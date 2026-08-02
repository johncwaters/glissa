'use strict';

// Steps 3 and 5 of graceful-shutdown-auto-resume: the module-level helpers backend.js exports for
// direct testing (no httpServer/createBackend needed - see the exports at the bottom of backend.js).
//
// persistSessionField: the read-modify-write config.json persists resumeSessionId/wasActive
// through. Exercised against a real configStore (temp file), matching config-store.test.js's
// withStore pattern, so "no-op for an id absent from cfg.projects" is a real disk round-trip, not
// a mock assertion.
//
// runAutoResume: the boot pass that spawns picked, still-DORMANT sessions through spawnGate.
// Exercised with real Session instances and an injected ptySpawn/spawnCommand (mirrors
// sessions-resume.test.js / spawn-integration.test.js), so no real `claude` process ever launches.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runAutoResume, persistSessionField, decideWasActiveFlip } = require('../server/backend');
const { createConfigStore } = require('../server/config-store');
const { createSpawnGate } = require('../server/spawn-gate');
const { Session } = require('../session/sessions');
const { STATES } = require('../shared/states');

function withStore(cfg, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-autoresume-'));
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
  const prev = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = p;
  try {
    return fn(createConfigStore(), p);
  } finally {
    if (prev == null) delete process.env.GLISSA_CONFIG;
    if (prev != null) process.env.GLISSA_CONFIG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Async-aware sibling of withStore: `finally` must not sweep the temp dir before an async fn's
// awaited work (disk reads, _handlePtyExit) finishes. withStore's plain try/finally would run
// cleanup the instant fn returns a pending promise, not once it settles.
async function withStoreAsync(cfg, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-autoresume-'));
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
  const prev = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = p;
  try {
    return await fn(createConfigStore(), p);
  } finally {
    if (prev == null) delete process.env.GLISSA_CONFIG;
    if (prev != null) process.env.GLISSA_CONFIG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Run `fn` with process.platform pinned to 'win32', then restore it (mirrors
// tests/session-killproc.test.js): kill() branches on platform, and pinning win32 exercises the
// taskkill (killProc) path deterministically on any host.
async function asWin32(fn) {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try { return await fn(); }
  finally { Object.defineProperty(process, 'platform', orig); }
}

// --- decideWasActiveFlip ---

test('decideWasActiveFlip: entering STARTING or RUNNING always flips true', () => {
  assert.equal(decideWasActiveFlip(STATES.STARTING, 'spawn_success', false), true);
  assert.equal(decideWasActiveFlip(STATES.RUNNING, 'new_output', false), true);
  assert.equal(decideWasActiveFlip(STATES.RUNNING, 'resume', true), true, 'true even mid-restart');
});

test('decideWasActiveFlip: a genuine user_kill or terminal exit flips false', () => {
  assert.equal(decideWasActiveFlip(STATES.DONE, 'user_kill', false), false);
  assert.equal(decideWasActiveFlip(STATES.DONE, 'process_exit_ok', false), false);
  assert.equal(decideWasActiveFlip(STATES.FAILED, 'process_exit_fail', false), false);
});

test('decideWasActiveFlip: pendingRestart exempts the transient user_kill/DONE from forceRestart', () => {
  assert.equal(decideWasActiveFlip(STATES.DONE, 'user_kill', true), null, 'no flip - forceRestart is mid-cycle');
  assert.equal(decideWasActiveFlip(STATES.FAILED, 'process_exit_fail', true), null, 'no flip while a restart is pending');
});

test('decideWasActiveFlip: an unrelated transition never flips', () => {
  assert.equal(decideWasActiveFlip(STATES.WAITING, 'prompt_detected', false), null);
  assert.equal(decideWasActiveFlip(STATES.COMPLETE, 'task_complete', false), null);
});

// --- persistSessionField ---

test('persistSessionField writes the field to disk and to the in-memory config', () => {
  withStore({ projects: [{ id: 'p1', name: 'proj', path: 'C:/proj' }] }, (store, p) => {
    persistSessionField(store, store.config, 'p1', 'resumeSessionId', 'abcd1234-0000-0000-0000-abcdabcdabcd');
    const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(onDisk.projects[0].resumeSessionId, 'abcd1234-0000-0000-0000-abcdabcdabcd');
    assert.equal(store.config.projects[0].resumeSessionId, 'abcd1234-0000-0000-0000-abcdabcdabcd', 'in-memory config updated too');
  });
});

test('persistSessionField no-ops for an id absent from cfg.projects (ephemeral sessions never written)', () => {
  withStore({ projects: [{ id: 'p1', name: 'proj', path: 'C:/proj' }] }, (store, p) => {
    const before = fs.readFileSync(p, 'utf8');
    persistSessionField(store, store.config, 'ephemeral-not-in-config', 'resumeSessionId', 'abcd1234-0000-0000-0000-abcdabcdabcd');
    const after = fs.readFileSync(p, 'utf8');
    assert.equal(after, before, 'disk untouched for an unknown session id');
    assert.equal(store.config.projects.length, 1, 'no phantom project added in memory');
  });
});

test('persistSessionField flips wasActive true/false', () => {
  withStore({ projects: [{ id: 'p1', name: 'proj', path: 'C:/proj' }] }, (store, p) => {
    persistSessionField(store, store.config, 'p1', 'wasActive', true);
    assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).projects[0].wasActive, true);
    persistSessionField(store, store.config, 'p1', 'wasActive', false);
    assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).projects[0].wasActive, false);
  });
});

// --- runAutoResume ---

function fakePty(pid = 2147483646) {
  return { pid, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
}

function fakeSession(id, resumeSessionId, calls) {
  return new Session({
    id,
    name: id,
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: (file, args) => { calls.push({ id, file, args }); return fakePty(); },
    resumeSessionId,
  });
}

test('runAutoResume spawns a picked session with --resume <id> and leaves non-picked ones alone', async () => {
  const calls = [];
  const picked = fakeSession('picked', '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5', calls);
  const dormantNoFlag = fakeSession('not-active', null, calls);
  const noId = fakeSession('no-id', null, calls);
  const sessionsMap = new Map([
    ['picked', picked],
    ['not-active', dormantNoFlag],
    ['no-id', noId],
  ]);
  const cfg = {
    autoResume: true,
    projects: [
      { id: 'picked', wasActive: true, resumeSessionId: '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5' },
      { id: 'not-active', wasActive: false, resumeSessionId: '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5' },
      { id: 'no-id', wasActive: true },
    ],
  };
  try {
    await runAutoResume(sessionsMap, cfg, createSpawnGate());
    assert.equal(calls.length, 1, 'only the picked session spawned');
    assert.equal(calls[0].id, 'picked');
    const i = calls[0].args.indexOf('--resume');
    assert.ok(i !== -1, 'picked session spawned with --resume');
    assert.equal(calls[0].args[i + 1], '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5');
    assert.equal(picked.state, STATES.STARTING);
    assert.equal(dormantNoFlag.state, STATES.DORMANT, 'not-active session never spawned');
    assert.equal(noId.state, STATES.DORMANT, 'no-id session never spawned');
  } finally {
    picked.destroy(); dormantNoFlag.destroy(); noId.destroy();
  }
});

test('runAutoResume spawns nothing when autoResume is false (kill switch)', async () => {
  const calls = [];
  const picked = fakeSession('picked', '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5', calls);
  const sessionsMap = new Map([['picked', picked]]);
  const cfg = {
    autoResume: false,
    projects: [{ id: 'picked', wasActive: true, resumeSessionId: '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5' }],
  };
  try {
    await runAutoResume(sessionsMap, cfg, createSpawnGate());
    assert.equal(calls.length, 0);
    assert.equal(picked.state, STATES.DORMANT);
  } finally {
    picked.destroy();
  }
});

test('runAutoResume skips a picked id with no live session in the map', async () => {
  const cfg = {
    autoResume: true,
    projects: [{ id: 'gone', wasActive: true, resumeSessionId: '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5' }],
  };
  await assert.doesNotReject(() => runAutoResume(new Map(), cfg, createSpawnGate()));
});

// The DORMANT check must run at gate-execution time, not at enqueue time: the gate can serialize a
// picked session's start() well behind another queued job, and in that window the plain
// start-session control path (control-handlers.js, ungated) could start the very same session.
// Session.start()'s single-flight guard only collapses starts still in flight, not one that already
// settled, so a stale enqueue-time check would still respawn an externally started session here.
test('runAutoResume does not double-spawn a session started externally while queued behind the gate', async () => {
  const calls = [];
  const sess = fakeSession('race', '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5', calls);
  const sessionsMap = new Map([['race', sess]]);
  const cfg = {
    autoResume: true,
    projects: [{ id: 'race', wasActive: true, resumeSessionId: '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5' }],
  };
  const gate = createSpawnGate();
  try {
    let releaseBlocker;
    const blocked = gate.run(() => new Promise((resolve) => { releaseBlocker = resolve; }));

    const done = runAutoResume(sessionsMap, cfg, gate); // enqueues behind the blocker while sess is still DORMANT

    // Simulate the ungated start-session control path racing in while the gate is still occupied.
    await sess.start();
    assert.equal(calls.length, 1, 'the external start spawned once');
    assert.equal(sess.state, STATES.STARTING);

    releaseBlocker();
    await blocked;
    await done;

    assert.equal(calls.length, 1, 'the gate-queued auto-resume job re-checked and saw the session was no longer DORMANT');
  } finally {
    sess.destroy();
  }
});

// --- forceRestart end-to-end: wasActive must survive the transient kill window ---
//
// Drives a real Session through forceRestart() (kill -> transient user_kill -> respawn) with a real
// configStore, mirroring exactly what wireSessionEvents' state-change listener does on every entry
// (decideWasActiveFlip -> persistSessionField). Regression target: forceRestart's kill is not the
// operator giving up on the session, so no wasActive:false write may land on disk during that window.

function restartableSession(id, killCalls) {
  return new Session({
    id,
    name: id,
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: () => fakePty(),
    killProc: (args, _opts, cb) => { killCalls.push(args); cb(null, '', ''); },
  });
}

// Mirrors wireSessionEvents' state-change listener (backend.js), scoped to just the wasActive
// persistence, against a real configStore project record.
function wireWasActive(sess, store) {
  let lastPersisted = null;
  const writes = [];
  sess.on('state-change', ({ to, event }) => {
    const next = decideWasActiveFlip(to, event, sess.pendingRestart);
    if (next === null || next === lastPersisted) return;
    lastPersisted = next;
    writes.push(next);
    persistSessionField(store, store.config, sess.id, 'wasActive', next);
  });
  return writes;
}

test('forceRestart never persists wasActive:false during its transient kill-then-respawn window', async () => {
  await asWin32(async () => {
    await withStoreAsync({ projects: [{ id: 'fr1', name: 'fr1', path: 'C:/fr1' }] }, async (store, p) => {
      const killCalls = [];
      const sess = restartableSession('fr1', killCalls);
      const writes = wireWasActive(sess, store);
      try {
        await sess.start(); // DORMANT -> INITIALIZING -> STARTING: flips wasActive true, persisted once
        assert.deepEqual(writes, [true]);
        assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).projects[0].wasActive, true);

        sess.state = STATES.RUNNING; // direct set (mirrors session-killproc.test.js); no event, no new write

        sess.forceRestart(); // synchronously: pendingRestart=true, kill(), transition('user_kill') -> DONE
        assert.equal(sess.state, STATES.DONE);
        assert.equal(sess.pendingRestart, true, 'restart is pending across the kill');
        assert.deepEqual(writes, [true], 'the transient user_kill/DONE was NOT persisted as false');
        assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).projects[0].wasActive, true, 'still true on disk mid-restart');

        await sess._handlePtyExit(0, null); // fires forceRestart's once('exit'): clears pendingRestart, respawns
        assert.equal(sess.pendingRestart, false);
        // The respawn re-enters STARTING (flip true again) but true was already the last-persisted
        // value, so wireWasActive's redundancy guard skips the write - the point either way is that
        // false is never seen across the whole cycle.
        assert.deepEqual(writes, [true], 'never flipped false across the whole restart cycle');
        assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).projects[0].wasActive, true);
      } finally {
        sess._killPollTimer && clearTimeout(sess._killPollTimer);
        sess.destroy();
      }
    });
  });
});

test('a genuine kill (not a restart) still persists wasActive:false', async () => {
  await asWin32(async () => {
    await withStoreAsync({ projects: [{ id: 'fr2', name: 'fr2', path: 'C:/fr2' }] }, async (store, p) => {
      const killCalls = [];
      const sess = restartableSession('fr2', killCalls);
      const writes = wireWasActive(sess, store);
      try {
        await sess.start();
        sess.state = STATES.RUNNING;
        sess.killSession(); // real kill: no pendingRestart flag set
        assert.equal(sess.pendingRestart, false);
        assert.deepEqual(writes, [true, false], 'an intentional kill still clears wasActive');
        assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).projects[0].wasActive, false);
      } finally {
        sess._killPollTimer && clearTimeout(sess._killPollTimer);
        sess.destroy();
      }
    });
  });
});
