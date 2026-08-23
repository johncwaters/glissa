'use strict';

// The Mill pull end to end through the REAL backend and a REAL control WebSocket: the request/reply
// round trip on the requesting socket only, an invalid spec surfaced rather than dropped, and the
// cached report replayed to a client that connects afterwards.
//
// SAFETY: createBackend resolves its config store and runs a boot worktree reconcile against the
// configured projects, so it is pointed at a throwaway temp config via GLISSA_CONFIG and can never see
// a real repo (memory: booting the backend against the real config once destroyed an active worktree).
// The single project's path is an empty temp directory: not a git repo, so the reconcile lists no
// worktrees and removes nothing, and the boot loop builds the session DORMANT without spawning. It
// deliberately carries no wasActive, which is what boot auto-resume selects on.
//
// The pack specs and the built root are temp fixtures injected through millWiringOptions, so nothing
// here reads the operator's real packs/ or ~/.glissa.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const { createBackend } = require('../server/backend');
const { dashboardClient } = require('./helpers/dashboard-ws');

const SESSION_ID = 'd0000000-0000-4000-8000-000000000001';
const MESSAGE_WAIT_MS = 5000;
const VERSION = 'f'.repeat(64);

function writePackFixture(root) {
  const specsDir = path.join(root, 'packs', 'specs');
  const sourcesDir = path.join(root, 'packs', 'sources', 'good');
  fs.mkdirSync(specsDir, { recursive: true });
  fs.mkdirSync(sourcesDir, { recursive: true });
  fs.writeFileSync(path.join(sourcesDir, 'notes.md'), '# notes\n', 'utf8');
  fs.writeFileSync(path.join(specsDir, 'good.pack.json'), JSON.stringify({
    name: 'good',
    description: 'A pack that builds',
    sources: [{ path: 'sources/good' }],
    budgetTokens: 8000,
  }), 'utf8');
  // Not JSON at all: the shell has to report the read failure as an invalid spec rather than throwing.
  fs.writeFileSync(path.join(specsDir, 'broken.pack.json'), '{ not json', 'utf8');

  const builtRoot = path.join(root, 'built');
  const currentDir = path.join(builtRoot, 'good', 'current');
  fs.mkdirSync(currentDir, { recursive: true });
  fs.writeFileSync(path.join(currentDir, 'manifest.json'), JSON.stringify({
    name: 'good',
    description: 'A pack that builds',
    version: VERSION,
    builtAt: '2026-08-20T10:00:00.000Z',
    tokenEstimate: 4000,
    budgetTokens: 8000,
    indexTokenEstimate: 200,
    rules: [],
    sources: [{ pattern: 'sources/good', files: [{ relPath: 'sources/good/notes.md' }] }],
    skills: [],
    outputs: [{ relPath: 'CLAUDE.md', tokenEstimate: 200 }],
  }), 'utf8');

  return { specsDir, builtRoot, baseDir: path.join(root, 'packs') };
}

// Every side effect of the build loop, faked: this suite must never walk the operator's real packs/
// tree, and BUILD_LOG is how a test sees which packs the loop was asked to build and in what order.
const BUILD_LOG = [];

function fakePackService() {
  BUILD_LOG.length = 0;
  return {
    listSpecs: async () => [{ name: 'good', specPath: '/specs/good.pack.json' }],
    loadSpec: async () => ({ name: 'good', sources: [], skills: [] }),
    watchRootsForSpec: async () => [],
    build: async ({ name }) => {
      BUILD_LOG.push(name);
      return { ok: true, name, version: 'v-good-1', unchanged: false, errors: [] };
    },
    createWatcher: () => ({ watch: () => false, stop: () => {} }),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  };
}

/*
 * `packs` is the project's assigned list; `packServiceOptions` fakes the whole build loop when a test
 * needs the service live (nothing here may walk or rebuild the operator's real packs/ tree, and no test
 * may spawn a Claude session).
 */
function withBackend(fn, { packs = ['good', 'ghost'], packsAutoRebuild = false, packServiceOptions } = {}) {
  return async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-mill-'));
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir);
    const fixture = writePackFixture(tmpDir);

    const project = { id: SESSION_ID, name: 'mill probe', path: projectDir };
    if (packs.length > 0) project.packs = packs;
    const cfgPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      projects: [project],
      teams: [],
      repoRoots: [],
      checkForUpdates: false,
      usage: { enabled: false },
      // Off by default so the boot service never walks or rebuilds the operator's real packs/ tree: the
      // mill report reads the injected fixture directly and needs no live service.
      packsAutoRebuild,
    }, null, 2), 'utf8');
    const prevEnv = process.env.GLISSA_CONFIG;
    process.env.GLISSA_CONFIG = cfgPath;

    const server = http.createServer();
    const backend = createBackend(server, {
      staticDir: null,
      millWiringOptions: { specsDir: fixture.specsDir, builtRoot: fixture.builtRoot, baseDir: fixture.baseDir },
      ...(packServiceOptions ? { packServiceOptions } : {}),
    });
    server.on('request', backend.app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const dash = await dashboardClient(server.address().port);
      await fn(t, { dash, cfgPath });
    } finally {
      for (const socket of OPEN_SOCKETS.splice(0)) socket.terminate();
      backend.shutdown();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      if (prevEnv == null) delete process.env.GLISSA_CONFIG;
      if (prevEnv != null) process.env.GLISSA_CONFIG = prevEnv;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

// Sockets a test opened, so the harness can hang up on the ones a failing body never closed: server.close()
// waits on an open connection, which turns an assertion failure into a whole-file timeout.
const OPEN_SOCKETS = [];

function openRecordingSocket(dash, pathAndSearch) {
  const ws = new WebSocket(dash.url(pathAndSearch), dash.options);
  OPEN_SOCKETS.push(ws);
  const received = [];
  ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));
  return new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.once('open', () => resolve({ ws, received }));
  });
}

function closeSocket(ws) {
  return new Promise((resolve) => {
    ws.once('close', resolve);
    ws.close();
  });
}

async function waitForMessage(received, matches, label) {
  const deadline = Date.now() + MESSAGE_WAIT_MS;
  while (Date.now() < deadline) {
    const hit = received.find(matches);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}; saw ${received.map((m) => m.type).join(', ')}`);
}

const isMillReport = (m) => m.type === 'mill-report';

test('request-mill-report replies to the requesting socket only, with both specs described', withBackend(async (_t, { dash }) => {
  const asker = await openRecordingSocket(dash, '/control');
  const bystander = await openRecordingSocket(dash, '/control');
  bystander.received.length = 0;

  asker.ws.send(JSON.stringify({ type: 'request-mill-report', requestId: 'm1' }));
  const report = await waitForMessage(asker.received, isMillReport, 'mill-report');

  assert.equal(report.requestId, 'm1');
  assert.equal(report.error, null);
  assert.equal(typeof report.ts, 'number');
  assert.equal(report.totals.packCount, 2);
  assert.equal(report.totals.builtCount, 1);
  assert.equal(report.totals.invalidSpecs, 1);

  const good = report.packs.find((pack) => pack.name === 'good');
  assert.equal(good.specValid, true);
  assert.equal(good.built.version, VERSION);
  assert.equal(good.built.budgetPct, 50);
  assert.deepEqual(good.consumers.projects, ['mill probe']);

  const broken = report.packs.find((pack) => pack.name === 'broken');
  assert.equal(broken.specValid, false);
  assert.equal(broken.built, null);
  assert.ok(broken.specErrors[0].startsWith('could not read spec:'));

  // The project names a pack no spec defines, which is a silent skip at spawn time and a warning here.
  assert.ok(report.configWarnings.some((w) => w.includes('"ghost"')));

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(bystander.received.filter(isMillReport).length, 0, 'a pull is not a broadcast');

  await closeSocket(asker.ws);
  await closeSocket(bystander.ws);
}));

test('the last report is replayed to a client that connects after it was built', withBackend(async (_t, { dash }) => {
  const first = await openRecordingSocket(dash, '/control');
  first.ws.send(JSON.stringify({ type: 'request-mill-report', requestId: 'm1' }));
  await waitForMessage(first.received, isMillReport, 'the first mill-report');

  const later = await openRecordingSocket(dash, '/control');
  const replayed = await waitForMessage(later.received, isMillReport, 'the connect replay');
  assert.equal(replayed.requestId, null, 'a replay answers no request');
  assert.equal(replayed.totals.packCount, 2);

  await closeSocket(first.ws);
  await closeSocket(later.ws);
}));

test('a control client with no prior request gets no mill report until it asks', withBackend(async (_t, { dash }) => {
  const client = await openRecordingSocket(dash, '/control');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(client.received.filter(isMillReport).length, 0);
  await closeSocket(client.ws);
}));

test('the report carries the assignment targets the Deliver to control renders from', withBackend(async (_t, { dash }) => {
  const asker = await openRecordingSocket(dash, '/control');
  asker.ws.send(JSON.stringify({ type: 'request-mill-report', requestId: 'm1' }));
  const report = await waitForMessage(asker.received, isMillReport, 'mill-report');

  assert.deepEqual(report.projects, [{ id: SESSION_ID, name: 'mill probe', packs: ['good', 'ghost'] }]);
  assert.equal(report.maxPacksPerProject, 4);
  // 'broken' is a spec file nothing names, so it is skipped on purpose rather than reported as a problem.
  assert.equal(report.packs.find((pack) => pack.name === 'broken').hasConsumers, false);
  assert.equal(report.packs.find((pack) => pack.name === 'good').hasConsumers, true);
  assert.equal(report.totals.unconsumed, 1);

  await closeSocket(asker.ws);
}));

// MAJOR: the whole point of the feature is the FIRST delivery, and consumer gating guarantees that pack
// has never been built. If the build waited for the reload, the recreated session would resolve its packs
// at spawn and find nothing there.
test('a first delivery builds the pack before the reload recreates the session', withBackend(async (_t, { dash, cfgPath }) => {
  const asker = await openRecordingSocket(dash, '/control');

  asker.ws.send(JSON.stringify({ type: 'set-project-packs', requestId: 's1', projectId: SESSION_ID, pack: 'good', deliver: true }));
  const result = await waitForMessage(asker.received, (m) => m.type === 'set-project-packs-result', 'the ack');
  assert.equal(result.ok, true, result.error || '');

  await waitForMessage(asker.received, (m) => m.type === 'session-modified', 'the recreate');
  // The pack had never been built (consumer gating skipped it), and it is built by the time the session
  // that resolves its packs at spawn has been recreated. The exact build-then-reload ORDER is pinned
  // deterministically in tests/control-project-packs.test.js, where both steps are observable.
  assert.ok(BUILD_LOG.includes('good'), `expected a build of "good", got ${JSON.stringify(BUILD_LOG)}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).projects[0].packs, ['good']);

  await closeSocket(asker.ws);
}, { packs: [], packsAutoRebuild: true, packServiceOptions: fakePackService() }));

// MAJOR: ticking a checkbox must not spawn a permissionless Claude for a card that was not running.
test('assigning a pack to a DORMANT project recreates its record without starting it', withBackend(async (_t, { dash }) => {
  const asker = await openRecordingSocket(dash, '/control');

  asker.ws.send(JSON.stringify({ type: 'set-project-packs', projectId: SESSION_ID, pack: 'good', deliver: true }));
  const modified = await waitForMessage(asker.received, (m) => m.type === 'session-modified', 'the recreate');

  assert.equal(modified.state, 'DORMANT');
  // A spawn announces itself: start() emits a state-change synchronously, so a settle window with none
  // of them is the proof that nothing was launched.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const launched = asker.received.filter((m) => m.type === 'state-change' && m.to !== 'DORMANT');
  assert.deepEqual(launched, [], 'no session was started by a checkbox');

  await closeSocket(asker.ws);
}, { packs: [], packsAutoRebuild: true, packServiceOptions: fakePackService() }));

test('a refused set-project-packs writes nothing and tells the asking socket why', withBackend(async (_t, { dash }) => {
  const asker = await openRecordingSocket(dash, '/control');

  asker.ws.send(JSON.stringify({ type: 'set-project-packs', requestId: 's1', projectId: SESSION_ID, pack: 'nosuchspec', deliver: true }));
  const result = await waitForMessage(asker.received, (m) => m.type === 'set-project-packs-result', 'the refusal');

  assert.equal(result.ok, false);
  assert.equal(result.requestId, 's1');
  assert.match(result.error, /No pack spec named "nosuchspec"/);

  // Nothing moved: no reload, so no session-modified, and the report still reads the original list.
  asker.ws.send(JSON.stringify({ type: 'request-mill-report', requestId: 'm2' }));
  const report = await waitForMessage(asker.received, (m) => isMillReport(m) && m.requestId === 'm2', 'mill-report');
  assert.deepEqual(report.projects[0].packs, ['good', 'ghost']);
  assert.equal(asker.received.filter((m) => m.type === 'project-packs-updated').length, 0);

  await closeSocket(asker.ws);
}));
