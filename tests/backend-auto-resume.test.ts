import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import pty from 'node-pty';

import { createBackend, runAutoResume, persistSessionField, decideWasActiveFlip } from '../server/backend.ts';
import { createConfigStore } from '../server/config-store.ts';
import type { ConfigStore } from '../server/config-store.ts';
import type { RegistryConfig } from '../server/session-registry.ts';
import { createSpawnGate } from '../server/spawn-gate.ts';
import { Session } from '../session/sessions.ts';
import { STATES } from '../shared/states.ts';
import { UNREACHABLE_PID, fakePty } from './helpers/fake-pty.ts';
import { closeServer, listenOnLoopback } from './helpers/http-server.ts';
import { waitFor } from './helpers/wait-for.ts';

interface SpawnCall {
  id?: string;
  file: string;
  args: string[];
}

function withStore<T>(cfg: Record<string, unknown>, fn: (store: ConfigStore, configPath: string) => T): T {
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

async function withStoreAsync<T>(
  cfg: Record<string, unknown>,
  fn: (store: ConfigStore, configPath: string) => Promise<T>,
): Promise<T> {
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

async function asWin32(fn: () => Promise<void>): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(original, 'process.platform is an own property to restore');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try { await fn(); }
  finally { Object.defineProperty(process, 'platform', original); }
}

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

test('persistSessionField clears resumeSessionId with null', () => {
  withStore({ projects: [{ id: 'p1', name: 'proj', path: 'C:/proj', resumeSessionId: 'abcd1234-0000-0000-0000-abcdabcdabcd' }] }, (store, p) => {
    persistSessionField(store, store.config, 'p1', 'resumeSessionId', null);
    assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).projects[0].resumeSessionId, null);
    assert.equal(store.config.projects[0].resumeSessionId, null, 'in-memory config cleared too');
  });
});

function fakeIPty(): pty.IPty {
  const disposable = { dispose() {} };
  return {
    pid: UNREACHABLE_PID,
    cols: 80,
    rows: 24,
    process: 'fake',
    handleFlowControl: false,
    onData: () => disposable,
    onExit: () => disposable,
    resize() {},
    clear() {},
    write() {},
    kill() {},
    pause() {},
    resume() {},
  };
}

function fakeSession(id: string, resumeSessionId: string | null, calls: SpawnCall[]): Session {
  return new Session({
    id,
    name: id,
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: (file: string, args: string[]) => { calls.push({ id, file, args }); return fakePty(); },
    resumeSessionId,
  });
}

function autoResumeConfig(projects: Record<string, unknown>[], autoResume: boolean): RegistryConfig {
  return {
    autoResume,
    projects: projects.map((project) => ({ name: String(project.id), path: process.cwd(), ...project })) as RegistryConfig['projects'],
  };
}

test('runAutoResume spawns a picked session with --resume <id> and leaves non-picked ones alone', async () => {
  const calls: SpawnCall[] = [];
  const picked = fakeSession('picked', '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5', calls);
  const dormantNoFlag = fakeSession('not-active', null, calls);
  const noId = fakeSession('no-id', null, calls);
  const sessionsMap = new Map([
    ['picked', picked],
    ['not-active', dormantNoFlag],
    ['no-id', noId],
  ]);
  const cfg = autoResumeConfig([
    { id: 'picked', wasActive: true, resumeSessionId: '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5' },
    { id: 'not-active', wasActive: false, resumeSessionId: '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5' },
    { id: 'no-id', wasActive: true },
  ], true);
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
  const calls: SpawnCall[] = [];
  const picked = fakeSession('picked', '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5', calls);
  const sessionsMap = new Map([['picked', picked]]);
  const cfg = autoResumeConfig(
    [{ id: 'picked', wasActive: true, resumeSessionId: '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5' }],
    false,
  );
  try {
    await runAutoResume(sessionsMap, cfg, createSpawnGate());
    assert.equal(calls.length, 0);
    assert.equal(picked.state, STATES.DORMANT);
  } finally {
    picked.destroy();
  }
});

test('runAutoResume skips a picked id with no live session in the map', async () => {
  const cfg = autoResumeConfig(
    [{ id: 'gone', wasActive: true, resumeSessionId: '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5' }],
    true,
  );
  await assert.doesNotReject(() => runAutoResume(new Map(), cfg, createSpawnGate()));
});

test('runAutoResume does not double-spawn a session started externally while queued behind the gate', async () => {
  const calls: SpawnCall[] = [];
  const sess = fakeSession('race', '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5', calls);
  const sessionsMap = new Map([['race', sess]]);
  const cfg = autoResumeConfig(
    [{ id: 'race', wasActive: true, resumeSessionId: '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5' }],
    true,
  );
  const gate = createSpawnGate();
  try {
    const blocker: { release: (() => void) | null } = { release: null };
    const blocked = gate.run(() => new Promise<void>((resolve) => { blocker.release = resolve; }));

    const done = runAutoResume(sessionsMap, cfg, gate);

    await sess.start();
    assert.equal(calls.length, 1, 'the external start spawned once');
    assert.equal(sess.state, STATES.STARTING);

    assert.ok(blocker.release, 'the blocker is holding the gate');
    blocker.release();
    await blocked;
    await done;

    assert.equal(calls.length, 1, 'the gate-queued auto-resume job re-checked and saw the session was no longer DORMANT');
  } finally {
    sess.destroy();
  }
});

test('createBackend defers boot auto-resume until the HTTP listener has a hook port', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-autoresume-cfg-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-autoresume-proj-'));
  const cfgPath = path.join(cfgDir, 'config.json');
  const resumeSessionId = '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5';
  fs.writeFileSync(cfgPath, JSON.stringify({
    autoResume: true,
    checkForUpdates: false,
    projects: [{
      id: 'boot-picked',
      name: 'boot-picked',
      path: projectDir,
      wasActive: true,
      resumeSessionId,
    }],
    teams: [],
    repoRoots: [],
  }, null, 2), 'utf8');
  const prevEnv = process.env.GLISSA_CONFIG;
  const originalSpawn = pty.spawn;
  const calls: SpawnCall[] = [];
  const live: { backend: ReturnType<typeof createBackend> | null } = { backend: null };
  process.env.GLISSA_CONFIG = cfgPath;
  pty.spawn = (file: string, args: string[] | string) => {
    calls.push({ file, args: Array.isArray(args) ? args : [args] });
    return fakeIPty();
  };
  const server = http.createServer();
  try {
    live.backend = createBackend(server, { staticDir: null });
    assert.equal(calls.length, 0, 'auto-resume waits until the HTTP listener is bound');

    const port = await listenOnLoopback(server);
    await waitFor(() => calls.length === 1);

    const settingsIndex = calls[0].args.indexOf('--settings');
    assert.notEqual(settingsIndex, -1, 'auto-resume spawn includes injected settings');
    const settingsPath = calls[0].args[settingsIndex + 1];
    const settingsText = fs.readFileSync(settingsPath, 'utf8');
    assert.match(settingsText, new RegExp(`http://127\\.0\\.0\\.1:${port}/hook/boot-picked/stop`));
    const resumeIndex = calls[0].args.indexOf('--resume');
    assert.notEqual(resumeIndex, -1, 'auto-resume keeps the resume argument');
    assert.equal(calls[0].args[resumeIndex + 1], resumeSessionId);
  } finally {
    if (live.backend) live.backend.shutdown();
    if (server.listening) await closeServer(server);
    pty.spawn = originalSpawn;
    if (prevEnv == null) delete process.env.GLISSA_CONFIG;
    if (prevEnv != null) process.env.GLISSA_CONFIG = prevEnv;
    fs.rmSync(cfgDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('createBackend shutdown removes pending boot listeners before listen', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-autoresume-cfg-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-autoresume-proj-'));
  const cfgPath = path.join(cfgDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    autoResume: true,
    checkForUpdates: false,
    projects: [{
      id: 'boot-picked',
      name: 'boot-picked',
      path: projectDir,
      wasActive: true,
      resumeSessionId: '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5',
    }],
    teams: [],
    repoRoots: [],
  }, null, 2), 'utf8');
  const prevEnv = process.env.GLISSA_CONFIG;
  const originalSpawn = pty.spawn;
  const live: { backend: ReturnType<typeof createBackend> | null } = { backend: null };
  process.env.GLISSA_CONFIG = cfgPath;
  pty.spawn = () => fakeIPty();
  const server = http.createServer();
  try {
    const listenersBeforeBackend = server.listenerCount('listening');
    live.backend = createBackend(server, { staticDir: null });
    assert.equal(server.listenerCount('listening'), listenersBeforeBackend + 2);
    live.backend.shutdown();
    live.backend = null;
    assert.equal(server.listenerCount('listening'), listenersBeforeBackend);
  } finally {
    if (live.backend) live.backend.shutdown();
    if (server.listening) await closeServer(server);
    pty.spawn = originalSpawn;
    if (prevEnv == null) delete process.env.GLISSA_CONFIG;
    if (prevEnv != null) process.env.GLISSA_CONFIG = prevEnv;
    fs.rmSync(cfgDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

function restartableSession(id: string, killCalls: string[][]): Session {
  return new Session({
    id,
    name: id,
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: () => fakePty(),
    killProc: (args, _opts, cb) => { killCalls.push(args); cb(null, '', ''); },
  });
}

function wireWasActive(sess: Session, store: ConfigStore): boolean[] {
  const last: { persisted: boolean | null } = { persisted: null };
  const writes: boolean[] = [];
  sess.on('state-change', ({ to, event }) => {
    const next = decideWasActiveFlip(to, event, sess.pendingRestart);
    if (next === null || next === last.persisted) return;
    last.persisted = next;
    writes.push(next);
    persistSessionField(store, store.config, sess.id, 'wasActive', next);
  });
  return writes;
}

test('forceRestart never persists wasActive:false during its transient kill-then-respawn window', async () => {
  await asWin32(async () => {
    await withStoreAsync({ projects: [{ id: 'fr1', name: 'fr1', path: 'C:/fr1' }] }, async (store, p) => {
      const killCalls: string[][] = [];
      const sess = restartableSession('fr1', killCalls);
      const writes = wireWasActive(sess, store);
      try {
        await sess.start();
        assert.deepEqual(writes, [true]);
        assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).projects[0].wasActive, true);

        sess.state = STATES.RUNNING;

        sess.forceRestart();
        assert.equal(sess.state, STATES.DONE);
        assert.equal(sess.pendingRestart, true, 'restart is pending across the kill');
        assert.deepEqual(writes, [true], 'the transient user_kill/DONE was NOT persisted as false');
        assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).projects[0].wasActive, true, 'still true on disk mid-restart');

        await sess._handlePtyExit(0, null);
        assert.equal(sess.pendingRestart, false);

        assert.deepEqual(writes, [true], 'never flipped false across the whole restart cycle');
        assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).projects[0].wasActive, true);
      } finally {
        if (sess._killPollTimer) clearTimeout(sess._killPollTimer);
        sess.destroy();
      }
    });
  });
});

test('a genuine kill (not a restart) still persists wasActive:false', async () => {
  await asWin32(async () => {
    await withStoreAsync({ projects: [{ id: 'fr2', name: 'fr2', path: 'C:/fr2' }] }, async (store, p) => {
      const killCalls: string[][] = [];
      const sess = restartableSession('fr2', killCalls);
      const writes = wireWasActive(sess, store);
      try {
        await sess.start();
        sess.state = STATES.RUNNING;
        sess.killSession();
        assert.equal(sess.pendingRestart, false);
        assert.deepEqual(writes, [true, false], 'an intentional kill still clears wasActive');
        assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).projects[0].wasActive, false);
      } finally {
        if (sess._killPollTimer) clearTimeout(sess._killPollTimer);
        sess.destroy();
      }
    });
  });
});
