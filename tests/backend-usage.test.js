'use strict';

// The usage lane end to end through the REAL backend and a REAL control WebSocket: lazy start on the
// first connection, the usage-sessions push and its connect replay, the request-usage-report round
// trip, the enabled:false kill switch, and the cfg-key gating of a settings-triggered restart.
//
// SAFETY: createBackend resolves its config store and runs a boot worktree reconcile against the
// configured projects, so it is pointed at a throwaway temp config via GLISSA_CONFIG and can never see
// a real repo (memory: booting the backend against the real config once destroyed an active worktree).
// The single project's path is an empty temp directory: not a git repo, so the reconcile lists no
// worktrees and removes nothing, and the boot loop builds the session DORMANT without spawning. The
// project deliberately carries resumeSessionId (the usage attribution key) but NEVER wasActive, which
// is what boot auto-resume selects on: adding wasActive here would spawn a real `claude` PTY.
//
// The transcript tree is a temp fixture reached through the scanner's injected env
// (CLAUDE_CONFIG_DIR), and pricing is loaded snapshot-only, so nothing here reads the operator's real
// ~/.claude or touches the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const realFsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const { createBackend } = require('../server/backend');
const { dashboardClient } = require('./helpers/dashboard-ws');
const { createUsageWiring } = require('../server/usage-wiring');
const { createUsageScanner } = require('../server/usage-scanner');
const { loadPricing } = require('../server/usage-pricing');

const SESSION_ID = 'b0000000-0000-4000-8000-000000000001';
const CLAUDE_SESSION_ID = 'c1c1c1c1-2222-4333-8444-555555555555';
const MODEL = 'claude-opus-4-5';
const MESSAGE_WAIT_MS = 5000;

function transcriptLine({ sessionId, requestId, messageId, input, output, timestampMs }) {
  return `${JSON.stringify({
    sessionId,
    requestId,
    timestamp: new Date(timestampMs).toISOString(),
    cwd: 'C:/fixture/repo',
    version: '2.1.200',
    isSidechain: false,
    message: {
      id: messageId,
      model: MODEL,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  })}\n`;
}

// A minimal but REAL transcript tree: <claudeHome>/projects/<encoded-dir>/<uuid>.jsonl, the shape
// resolveProjectsDirs + the scanner walk expect.
function writeTranscriptFixture(claudeHome) {
  const projectDir = path.join(claudeHome, 'projects', 'C--fixture-repo');
  fs.mkdirSync(projectDir, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(
    path.join(projectDir, `${CLAUDE_SESSION_ID}.jsonl`),
    transcriptLine({ sessionId: CLAUDE_SESSION_ID, requestId: 'req-1', messageId: 'msg-1', input: 100, output: 50, timestampMs: now - 60000 })
      + transcriptLine({ sessionId: CLAUDE_SESSION_ID, requestId: 'req-2', messageId: 'msg-2', input: 200, output: 25, timestampMs: now - 30000 }),
    'utf8',
  );
}

// Counts every fs call the scanner makes plus every scanner construction, which is how the lazy-start
// and restart assertions observe the lane without reaching into it.
function makeUsageProbe(claudeHome) {
  const counts = { scanners: 0, stat: 0, readdir: 0, open: 0 };
  const fsPromises = {
    stat: (...args) => { counts.stat += 1; return realFsp.stat(...args); },
    readdir: (...args) => { counts.readdir += 1; return realFsp.readdir(...args); },
    open: (...args) => { counts.open += 1; return realFsp.open(...args); },
  };
  const options = {
    // Snapshot-only pricing: no network fetch, no ~/.glissa cache read, whatever config.usage says.
    loadPricingFn: (args) => loadPricing({ ...args, fetchEnabled: false }),
    createScanner: (deps) => {
      counts.scanners += 1;
      return createUsageScanner(deps);
    },
    // HOME is pinned to the fixture as well as CLAUDE_CONFIG_DIR: the scanner also resolves the Codex and
    // Grok homes from it, so without this the lane would walk the operator's real ~/.codex and ~/.grok.
    scannerDeps: { env: { CLAUDE_CONFIG_DIR: claudeHome, HOME: path.dirname(claudeHome), USERPROFILE: path.dirname(claudeHome) }, fsPromises },
    logger: { warn: () => {} },
  };
  return { counts, options };
}

function withBackend({ usage } = {}, fn) {
  return async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-usage-'));
    const projectDir = path.join(tmpDir, 'project');
    const claudeHome = path.join(tmpDir, 'claude');
    fs.mkdirSync(projectDir);
    writeTranscriptFixture(claudeHome);

    const cfgPath = path.join(tmpDir, 'config.json');
    const cfg = {
      projects: [{ id: SESSION_ID, name: 'usage probe', path: projectDir, resumeSessionId: CLAUDE_SESSION_ID }],
      teams: [],
      repoRoots: [],
      checkForUpdates: false,
    };
    if (usage) cfg.usage = usage;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    const prevEnv = process.env.GLISSA_CONFIG;
    process.env.GLISSA_CONFIG = cfgPath;

    const probe = makeUsageProbe(claudeHome);
    const server = http.createServer();
    const backend = createBackend(server, { staticDir: null, usageWiringOptions: probe.options });
    server.on('request', backend.app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const dash = await dashboardClient(server.address().port);

    try {
      await fn(t, { dash, counts: probe.counts, cfgPath });
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

// Recording starts before 'open' resolves: the server sends the snapshot the instant the connection
// lands, and ws can emit 'open' and 'message' within one socket read.
function openRecordingSocket(dash, pathAndSearch = '/control') {
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

async function waitFor(predicate, label) {
  const deadline = Date.now() + MESSAGE_WAIT_MS;
  while (Date.now() < deadline) {
    const hit = predicate();
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function waitForMessage(received, matches, label) {
  return waitFor(() => received.find(matches), label);
}

function settle(ms = 250) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const isUsageSessions = (m) => m.type === 'usage-sessions';

test('no transcript is read until the first control connection, then the boot pass runs once', withBackend({}, async (_t, { dash, counts }) => {
  await settle();
  assert.equal(counts.scanners, 0, 'cold boot constructs no scanner');
  assert.equal(counts.readdir, 0, 'cold boot walks no directory');
  assert.equal(counts.open, 0, 'cold boot reads no transcript');

  const first = await openRecordingSocket(dash);
  await waitForMessage(first.received, isUsageSessions, 'the first usage-sessions push');
  assert.equal(counts.scanners, 1);
  assert.ok(counts.readdir > 0, 'the deferred boot pass walked the transcript tree');
  assert.ok(counts.open > 0, 'the deferred boot pass read the transcript');

  const second = await openRecordingSocket(dash);
  await waitForMessage(second.received, isUsageSessions, 'usage-sessions replayed to a later client');
  assert.equal(counts.scanners, 1, 'a second connection reuses the warm scanner');

  await closeSocket(first.ws);
  await closeSocket(second.ws);
}));

test('usage-sessions attributes the fixture transcript to the card through its live Claude session id', withBackend({}, async (_t, { dash }) => {
  const client = await openRecordingSocket(dash);
  const message = await waitForMessage(client.received, isUsageSessions, 'usage-sessions');

  assert.equal(message.pricingSource, 'snapshot');
  assert.equal(typeof message.ts, 'number');
  assert.deepEqual(message.sessions.map((row) => row.id), [SESSION_ID]);
  const row = message.sessions[0];
  assert.equal(row.tokens, 375, 'both transcript lines counted (100+50 and 200+25)');
  assert.ok(row.costUSD > 0, 'priced from the committed snapshot');
  assert.equal(typeof row.lastTs, 'number');

  await closeSocket(client.ws);
}));

test('request-usage-report replies to the requesting socket only, with the full report shape', withBackend({}, async (_t, { dash }) => {
  const asker = await openRecordingSocket(dash);
  await waitForMessage(asker.received, isUsageSessions, 'the boot push');
  const bystander = await openRecordingSocket(dash);
  await waitForMessage(bystander.received, isUsageSessions, 'the bystander connect replay');
  bystander.received.length = 0;

  asker.ws.send(JSON.stringify({ type: 'request-usage-report', requestId: 'r1', days: 30 }));
  const report = await waitForMessage(asker.received, (m) => m.type === 'usage-report', 'usage-report');

  assert.equal(report.requestId, 'r1');
  assert.equal(report.error, null);
  assert.equal(report.warning, null);
  assert.equal(report.blockHours, 5);
  assert.equal(report.totals.tokens, 375);
  assert.equal(report.totals.input, 300);
  assert.equal(report.totals.output, 75);
  assert.equal(report.daily.length, 1, 'both entries land in one local-tz day');
  assert.deepEqual(report.models.map((m) => m.model), [MODEL]);
  assert.equal(report.sessions.length, 1);
  assert.ok(report.blocks.length >= 1);
  assert.ok(report.activeBlock, 'the fixture entries are minutes old, so the block is still active');
  assert.equal(report.pricing.source, 'snapshot');
  assert.deepEqual(report.pricing.missing, []);
  assert.equal(report.scan.files, 1);
  assert.equal(report.scan.entries, 2);
  assert.equal(report.scan.partial, false);
  assert.ok(Array.isArray(report.scan.dirs) && report.scan.dirs.length === 1);

  await settle();
  assert.equal(bystander.received.filter((m) => m.type === 'usage-report').length, 0, 'the report is replied, never broadcast');

  // A client connecting after a report exists gets it replayed, with no requestId of its own.
  const latecomer = await openRecordingSocket(dash);
  const replayed = await waitForMessage(latecomer.received, (m) => m.type === 'usage-report', 'the replayed report');
  assert.equal(replayed.requestId, null);
  assert.equal(replayed.totals.tokens, 375);

  await closeSocket(asker.ws);
  await closeSocket(bystander.ws);
  await closeSocket(latecomer.ws);
}));

test('usage.enabled false: no scanner, no messages, and a refused report request', withBackend({ usage: { enabled: false } }, async (_t, { dash, counts }) => {
  const client = await openRecordingSocket(dash);
  await waitForMessage(client.received, (m) => m.type === 'snapshot', 'the snapshot');
  await settle();

  assert.equal(counts.scanners, 0, 'a disabled lane constructs no scanner');
  assert.equal(counts.readdir, 0, 'a disabled lane walks no directory');
  assert.equal(client.received.filter(isUsageSessions).length, 0, 'no usage message on the wire');

  client.ws.send(JSON.stringify({ type: 'request-usage-report', requestId: 'r9' }));
  const report = await waitForMessage(client.received, (m) => m.type === 'usage-report', 'the refusal');
  assert.equal(report.requestId, 'r9');
  assert.match(report.error, /disabled/);
  assert.equal(report.totals, undefined, 'a refusal carries no report body');
  assert.equal(counts.scanners, 0, 'the refused request still constructed nothing');

  await closeSocket(client.ws);
}));

test('a settings save restarts the lane only when the usage block actually changed', withBackend({}, async (_t, { dash, counts }) => {
  const client = await openRecordingSocket(dash);
  await waitForMessage(client.received, isUsageSessions, 'the boot push');
  assert.equal(counts.scanners, 1);

  client.ws.send(JSON.stringify({ type: 'update-settings', requestId: 's1', settings: { cursorBlink: true } }));
  await waitForMessage(client.received, (m) => m.type === 'settings-updated' && m.requestId === 's1', 'the unrelated save');
  await settle();
  assert.equal(counts.scanners, 1, 'a save that touches no usage key leaves the warm scanner alone');

  client.ws.send(JSON.stringify({
    type: 'update-settings',
    requestId: 's2',
    settings: { usage: { enabled: true, fetchPricing: false, scanIntervalMinutes: 7, costMode: 'calculate' } },
  }));
  await waitForMessage(client.received, (m) => m.type === 'settings-updated' && m.requestId === 's2', 'the usage save');
  await waitFor(() => counts.scanners === 2, 'the lane to restart with a fresh scanner');

  const updated = client.received.find((m) => m.type === 'settings-updated' && m.requestId === 's2');
  assert.deepEqual(updated.settings.usage, { enabled: true, fetchPricing: false, scanIntervalMinutes: 7, costMode: 'calculate' });

  await closeSocket(client.ws);
}));

// --- pass scheduling, against a stub scanner (no fs, no backend) ---
//
// The scanner caps each pass at a byte budget, so a large transcript tree comes back partial and the
// lane must finish it on its own short timer rather than waiting out scanIntervalMinutes. Measured on
// a real machine: 6927 files, budget exhausted, 36 of the entries found on the first pass.

function stubScannerWiring({ passResults, clients = 1 }) {
  const passes = [];
  const scanner = {
    runPass: async (args) => {
      passes.push(args);
      return passResults[Math.min(passes.length - 1, passResults.length - 1)];
    },
    buildReport: () => ({
      ts: 1, tz: null, blockHours: 5, totals: {}, daily: [], models: [], sessions: [],
      blocks: [], activeBlock: null, tokenLimit: null, pricing: { missing: [] },
      scan: { dirs: [], files: 0, entries: 0, lastScanMs: 1, partial: false },
    }),
    sessionTotals: () => new Map(),
    stats: () => ({ dirs: [], files: 0, entries: 0, lastScanMs: 1, resolutionError: null }),
  };
  const wiring = createUsageWiring({
    config: {},
    sessions: new Map(),
    controlClientCount: () => clients,
    createScanner: () => scanner,
    loadPricingFn: async () => ({ table: {}, source: 'snapshot', fetchedAt: null }),
    partialContinueMs: 10,
    logger: { warn: () => {} },
  });
  return { wiring, passes };
}

const PARTIAL_PASS = { files: 1, entries: 1, newEntries: 1, partial: true, durationMs: 1 };
const COMPLETE_PASS = { files: 1, entries: 1, newEntries: 0, partial: false, durationMs: 1 };

test('a partial pass is continued on the short timer until the scan completes', async () => {
  const { wiring, passes } = stubScannerWiring({ passResults: [PARTIAL_PASS, PARTIAL_PASS, COMPLETE_PASS] });
  await wiring.start();
  assert.equal(passes.length, 1, 'the boot pass');

  await waitFor(() => passes.length === 3, 'the truncated scan to be continued to completion');
  await settle(60);
  assert.equal(passes.length, 3, 'a complete pass schedules no further continuation');
  await wiring.stop();
});

test('a partial pass is not continued while no dashboard is connected', async () => {
  const { wiring, passes } = stubScannerWiring({ passResults: [PARTIAL_PASS], clients: 0 });
  await wiring.start();
  assert.equal(passes.length, 1);

  await settle(80);
  assert.equal(passes.length, 1, 'nobody is looking, so the tree is left for the next interval tick');
  await wiring.stop();
});

test('stop() cancels a pending continuation', async () => {
  const { wiring, passes } = stubScannerWiring({ passResults: [PARTIAL_PASS] });
  await wiring.start();
  await wiring.stop();

  await settle(80);
  assert.equal(passes.length, 1, 'no pass runs after stop');
});

test('a config with no usage block never materializes one on an unrelated save', withBackend({}, async (_t, { dash, cfgPath }) => {
  const client = await openRecordingSocket(dash);
  await waitForMessage(client.received, (m) => m.type === 'snapshot', 'the snapshot');

  client.ws.send(JSON.stringify({ type: 'update-settings', requestId: 'u1', settings: { cursorBlink: false } }));
  const updated = await waitForMessage(client.received, (m) => m.type === 'settings-updated' && m.requestId === 'u1', 'the save');
  assert.equal(updated.settings.usage, null, 'getSettings echoes null while the block is unconfigured');
  assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).usage, undefined, 'config.json still has no usage key');

  await closeSocket(client.ws);
}));

test('a settings restart during an in-flight start arms the NEW interval cadence', async () => {
  let releaseFirstPass;
  const firstPassGate = new Promise((resolve) => { releaseFirstPass = resolve; });
  const armed = [];
  const cleared = [];
  let passCount = 0;
  const scanner = {
    runPass: async () => {
      passCount += 1;
      if (passCount === 1) await firstPassGate;
      return { files: 0, entries: 0, newEntries: 0, partial: false, durationMs: 1 };
    },
    buildReport: () => ({
      ts: 1, tz: null, blockHours: 5, totals: {}, daily: [], models: [], sessions: [],
      blocks: [], activeBlock: null, tokenLimit: null, pricing: { missing: [] },
      scan: { dirs: [], files: 0, entries: 0, lastScanMs: 1, partial: false },
    }),
    sessionTotals: () => new Map(),
    stats: () => ({ dirs: [], files: 0, entries: 0, lastScanMs: 1, resolutionError: null }),
  };
  const config = { usage: { scanIntervalMinutes: 1 } };
  const wiring = createUsageWiring({
    config,
    sessions: new Map(),
    controlClientCount: () => 1,
    createScanner: () => scanner,
    loadPricingFn: async () => ({ table: {}, source: 'snapshot', fetchedAt: null }),
    setIntervalFn: (fn, ms) => { const handle = { ms }; armed.push(handle); return handle; },
    clearIntervalFn: (handle) => { cleared.push(handle); },
    logger: { warn: () => {} },
  });

  const startPending = wiring.start();
  config.usage = { scanIntervalMinutes: 7 };
  wiring.restartIfConfigChanged();
  releaseFirstPass();
  await startPending;

  const wantedMs = 7 * 60 * 1000;
  for (let i = 0; i < 200 && !armed.some((handle) => handle.ms === wantedMs); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(armed.some((handle) => handle.ms === wantedMs), 'the restarted lane armed the new cadence');
  for (const handle of armed.filter((entry) => entry.ms !== wantedMs)) {
    assert.ok(cleared.includes(handle), 'every stale interval from the aborted start was cleared');
  }
  await wiring.stop();
});
