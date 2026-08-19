'use strict';

// Session side of the live context-pack channel: a rebuilt pack arms a notice on the sessions that
// SPAWNED against the older build, the notice is consumed exactly once, a newer version re-arms it,
// and a restart voids whatever the previous spawn owed. Uses the injected ptySpawn fake plus a
// temp built root (same pattern as session-packs.test.js), so no real process ever launches.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { Session } = require('../session/sessions');

function fakePty(pid = 2147483645) {
  return { pid, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
}

async function makeBuiltRoot(packs) {
  const builtRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'glissa-packnotice-'));
  for (const [name, version] of Object.entries(packs)) {
    const currentDir = path.join(builtRoot, name, 'current');
    await fsp.mkdir(currentDir, { recursive: true });
    await fsp.writeFile(path.join(currentDir, 'manifest.json'), JSON.stringify({ name, version }), 'utf8');
  }
  return builtRoot;
}

async function startedSession(packs, builtRoot) {
  const s = new Session({
    id: `notice-${Math.random().toString(16).slice(2)}`,
    name: 'notice',
    path: process.cwd(),
    packs,
    packsBuiltRoot: builtRoot,
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: () => fakePty(),
  });
  await s.start();
  return s;
}

test('a rebuilt pack arms a notice that names the delivered and the new version', async () => {
  const builtRoot = await makeBuiltRoot({ alpha: 'v-old' });
  const s = await startedSession(['alpha'], builtRoot);
  try {
    assert.equal(s.takePackNoticeContext(), null, 'nothing pending right after the spawn');
    assert.equal(s.notePackUpdate('alpha', 'v-new'), true);
    const notice = s.takePackNoticeContext();
    assert.match(notice, /^\[glissa\] Context pack updated since this session started: "alpha" \(version v-old is now v-new\)\./);
  } finally {
    s.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
  }
});

test('the notice is consumed once and only a newer version re-arms it', async () => {
  const builtRoot = await makeBuiltRoot({ alpha: 'v1' });
  const s = await startedSession(['alpha'], builtRoot);
  try {
    s.notePackUpdate('alpha', 'v2');
    assert.ok(s.takePackNoticeContext(), 'first turn carries it');
    assert.equal(s.takePackNoticeContext(), null, 'a second turn does not repeat the same staleness');
    assert.equal(s.notePackUpdate('alpha', 'v2'), false, 'the same version again arms nothing');
    assert.equal(s.takePackNoticeContext(), null);

    s.notePackUpdate('alpha', 'v3');
    assert.match(s.takePackNoticeContext(), /version v1 is now v3/, 'a newer build re-arms against the DELIVERED version');
  } finally {
    s.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
  }
});

test('a rebuild that lands back on the delivered version says nothing', async () => {
  const builtRoot = await makeBuiltRoot({ alpha: 'v1' });
  const s = await startedSession(['alpha'], builtRoot);
  try {
    s.notePackUpdate('alpha', 'v2');
    assert.ok(s.takePackNoticeContext());
    assert.equal(s.notePackUpdate('alpha', 'v1'), false, 'back to what this session runs on');
    assert.equal(s.takePackNoticeContext(), null);
  } finally {
    s.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
  }
});

test('a pack this session never delivered never arms a notice', async () => {
  const builtRoot = await makeBuiltRoot({ alpha: 'v1', beta: 'v1' });
  const s = await startedSession(['alpha'], builtRoot);
  try {
    assert.equal(s.notePackUpdate('beta', 'v2'), false, 'beta is built but not configured on this session');
    assert.equal(s.takePackNoticeContext(), null);
  } finally {
    s.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
  }
});

test('a session with no packs at all is inert', async () => {
  const s = await startedSession([], null);
  try {
    assert.equal(s.notePackUpdate('alpha', 'v2'), false);
    assert.equal(s.takePackNoticeContext(), null);
  } finally {
    s.destroy();
  }
});

test('a restart voids the notice the previous spawn owed', async () => {
  const builtRoot = await makeBuiltRoot({ alpha: 'v1' });
  const s = await startedSession(['alpha'], builtRoot);
  try {
    s.notePackUpdate('alpha', 'v2');
    // The next spawn re-resolves the pack dir, so it delivers whatever is current and starts clean.
    await s._resolvePacks();
    assert.equal(s.takePackNoticeContext(), null, 'the pending notice did not survive the re-resolve');
    assert.deepEqual(s.toSnapshot().packs, [{ name: 'alpha', version: 'v1', reads: 0 }]);
  } finally {
    s.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
  }
});

test('taking a notice leaves a pack entry in the decision trace', async () => {
  const builtRoot = await makeBuiltRoot({ alpha: 'v1' });
  const s = await startedSession(['alpha'], builtRoot);
  try {
    s.notePackUpdate('alpha', 'v2');
    s.takePackNoticeContext();
    const notices = s.getDebugState().decisions.filter((d) => d.kind === 'pack' && d.decision === 'notice');
    assert.equal(notices.length, 1);
    assert.deepEqual(notices[0].names, ['alpha']);
  } finally {
    s.destroy();
    await fsp.rm(builtRoot, { recursive: true, force: true });
  }
});
