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

function withBackend(fn) {
  return async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-mill-'));
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir);
    const fixture = writePackFixture(tmpDir);

    const cfgPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      projects: [{ id: SESSION_ID, name: 'mill probe', path: projectDir, packs: ['good', 'ghost'] }],
      teams: [],
      repoRoots: [],
      checkForUpdates: false,
      usage: { enabled: false },
      // Off so the boot service never walks or rebuilds the operator's real packs/ tree: the mill
      // report reads the injected fixture directly and needs no live service.
      packsAutoRebuild: false,
    }, null, 2), 'utf8');
    const prevEnv = process.env.GLISSA_CONFIG;
    process.env.GLISSA_CONFIG = cfgPath;

    const server = http.createServer();
    const backend = createBackend(server, {
      staticDir: null,
      millWiringOptions: { specsDir: fixture.specsDir, builtRoot: fixture.builtRoot, baseDir: fixture.baseDir },
    });
    server.on('request', backend.app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const dash = await dashboardClient(server.address().port);
      await fn(t, { dash });
    } finally {
      backend.shutdown();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      if (prevEnv == null) delete process.env.GLISSA_CONFIG;
      if (prevEnv != null) process.env.GLISSA_CONFIG = prevEnv;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

function openRecordingSocket(dash, pathAndSearch) {
  const ws = new WebSocket(dash.url(pathAndSearch), dash.options);
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
  throw new Error(`timed out waiting for ${label}`);
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
