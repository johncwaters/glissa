'use strict';

/*
 * The ingest lane inside a REAL booted backend (docs/plan-ingestion.md, M6): the config gate (absent
 * config constructs nothing at all), the connect-time snapshot on the control WS, and the load-bearing
 * ephemeral-session exclusion.
 *
 * That exclusion is the whole reason the tap lives in wireSessionEvents: navigator dispatch sessions are
 * PTY sessions too, and tapping one feeds the navigator's own output back into its next prompt. This
 * file pins BOTH halves of the rule, because either alone would pass while the bug is present: a project
 * session that goes through wireSessionEvents IS tapped, and a session registered through
 * registerEphemeralSession (the one seam every lane uses) is NOT.
 *
 * SAFETY: every boot points at a throwaway temp config with ZERO real project paths via GLISSA_CONFIG,
 * like every other backend boot test, and no session is ever started, so nothing spawns a PTY.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

const { createBackend } = require('../server/backend');
const { createReplayLog } = require('../server/control-replay-core');
const { registerEphemeralSession } = require('../server/ephemeral-session');

const INGEST_ON = { enabled: true, sources: { terminal: { enabled: true } } };
const MESSAGE_WAIT_MS = 5000;

function withBackend(configExtras, fn, { backendOptions = null, seed = null } = {}) {
  return async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-ingest-'));
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir);
    const cfgPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      projects: [{ id: 'p1', name: 'project', path: projectDir }],
      teams: [],
      repoRoots: [],
      ...configExtras,
    }, null, 2), 'utf8');
    const prevEnv = process.env.GLISSA_CONFIG;
    process.env.GLISSA_CONFIG = cfgPath;
    const seeded = seed ? seed({ tmpDir, cfgPath }) : {};

    const server = http.createServer();
    const backend = createBackend(server, { staticDir: null, ...(backendOptions ? backendOptions(seeded) : {}) });
    server.on('request', backend.app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const sockets = [];
    try {
      await fn({
        backend,
        seeded,
        base: `ws://127.0.0.1:${server.address().port}`,
        track: (ws) => { sockets.push(ws); return ws; },
      });
    } finally {
      for (const ws of sockets) ws.close();
      backend.shutdown();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      if (prevEnv == null) delete process.env.GLISSA_CONFIG;
      if (prevEnv != null) process.env.GLISSA_CONFIG = prevEnv;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

// Recording starts before 'open' resolves: the connect frames land the instant the socket does.
function openRecordingSocket(url) {
  const ws = new WebSocket(url);
  const received = [];
  ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));
  return new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.once('open', () => resolve({ ws, received }));
  });
}

function waitFor(received, match) {
  const deadline = Date.now() + MESSAGE_WAIT_MS;
  return new Promise((resolve, reject) => {
    const poll = () => {
      const found = received.find(match);
      if (found) {
        resolve(found);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error('timed out waiting for a matching control message'));
        return;
      }
      setTimeout(poll, 20).unref();
    };
    poll();
  });
}

// --- Config gating --------------------------------------------------------

test('with no ingest config the lane is never constructed and no session is tapped', withBackend({}, async ({ backend }) => {
  assert.equal(backend.getIngestLane(), null);
  const sess = backend.getSession('p1');
  assert.ok(sess, 'the project session should exist');
  assert.equal(sess.listenerCount('data'), 0, 'a lane that was never built cannot have tapped anything');
  assert.equal(sess.listenerCount('rebaseline'), 1, 'only the pre-existing data-client rebaseline listener');
}));

test('ingest enabled false is as inert as ingest absent', withBackend({ ingest: { enabled: false, sources: { terminal: { enabled: true } } } }, async ({ backend }) => {
  assert.equal(backend.getIngestLane(), null);
  assert.equal(backend.getSession('p1').listenerCount('data'), 0);
}));

test('the lane on with every source off builds no adapter and taps nothing', withBackend({ ingest: { enabled: true } }, async ({ backend }) => {
  const lane = backend.getIngestLane();
  assert.ok(lane, 'the lane itself is constructed');
  assert.equal(lane.terminalEnabled, false);
  assert.deepEqual(lane.sources, []);
  assert.equal(lane.tapCount, 0);
  assert.equal(backend.getSession('p1').listenerCount('data'), 0);
}));

// --- The tap and its exclusion --------------------------------------------

test('a project session is tapped, because it goes through wireSessionEvents', withBackend({ ingest: INGEST_ON }, async ({ backend }) => {
  const lane = backend.getIngestLane();
  assert.equal(lane.terminalEnabled, true);
  assert.equal(lane.tapCount, 1);
  const sess = backend.getSession('p1');
  assert.equal(sess.listenerCount('data'), 1);

  // The tap is real, not merely present: output published through it reaches the rings.
  sess.emit('data', 'a command ran here\n');
  await new Promise((resolve) => { setTimeout(resolve, 700).unref(); });
  const summaries = lane.recentEvents().map((event) => event.summary);
  assert.deepEqual(summaries, ['a command ran here']);
  assert.ok(lane.buildDigest({}).includes('a command ran here'));
}));

test('an ephemeral lane session is NOT tapped, which is what keeps the navigator out of its own prompt', withBackend({ ingest: INGEST_ON }, async ({ backend }) => {
  const lane = backend.getIngestLane();
  assert.equal(lane.tapCount, 1, 'only the project session');

  // Exactly how every ephemeral lane registers its session: the one seam, and it never touches
  // wireSessionEvents, which is where the tap lives.
  const ephemeral = new EventEmitter();
  ephemeral.id = 'navigator:file:///tmp/plan.md';
  ephemeral.destroy = () => {};
  registerEphemeralSession({
    map: new Map(),
    id: ephemeral.id,
    sess: ephemeral,
    closeSessionDataClients: () => {},
    logPrefix: 'navigator',
    name: 'navigator dispatch',
  });

  assert.equal(ephemeral.listenerCount('data'), 0, 'no ingest tap may ride an ephemeral session');
  assert.equal(lane.tapCount, 1, 'the tap count must not have moved');

  // And its output goes nowhere even if something does emit it.
  ephemeral.emit('data', 'the navigator talking to itself\n');
  await new Promise((resolve) => { setTimeout(resolve, 700).unref(); });
  assert.equal(lane.recentEvents().length, 0);
}));

// --- Health anomaly --------------------------------------------------------

// The tap is a server-side `data` listener with no data-WS client behind it. Before the health
// snapshot learned about it, every tapped session tripped listenerMismatch permanently, which lit
// the Radar attention dot on an otherwise healthy install.
test('the ingest tap does not trip the listener-mismatch anomaly, and a real leak still does', withBackend({ ingest: INGEST_ON }, async ({ backend, base, track }) => {
  assert.equal(backend.getIngestLane().tapCount, 1);
  const { ws, received } = await openRecordingSocket(`${base}/control`);
  track(ws);
  const snapshot = await waitFor(received, (msg) => msg.type === 'health-snapshot');
  assert.equal(snapshot.stats.anomalies.listenerMismatch, false, 'a tapped session with zero data clients is healthy');

  // A listener nothing accounts for is still a leak worth flagging.
  backend.getSession('p1').on('data', () => {});
  const mark = received.length;
  ws.send(JSON.stringify({ type: 'request-health-snapshot' }));
  const leaked = await waitFor(received, (msg) => msg.type === 'health-snapshot' && received.indexOf(msg) >= mark);
  assert.equal(leaked.stats.anomalies.listenerMismatch, true);
}));

// --- The agent-log source and its ledger seam ------------------------------

/*
 * The agent-log source pointed at a throwaway Claude home, so a booted backend never reads the
 * operator's real transcripts. What this proves that the adapter's own tests cannot is the SEAM: that
 * backend.js hands the usage-lane ledger to the lane, which is the whole feedback-loop exclusion.
 */
const AGENT_LOGS_ON = { enabled: true, sources: { agentLogs: { enabled: true } } };

function seedTranscripts({ tmpDir }) {
  const claudeHome = path.join(tmpDir, 'claude-home');
  const projects = path.join(claudeHome, 'projects');
  const projectDir = path.join(projects, 'C--repo');
  fs.mkdirSync(projectDir, { recursive: true });
  const write = (sessionId) => {
    const filePath = path.join(projectDir, `${sessionId}.jsonl`);
    fs.writeFileSync(filePath, '', 'utf8');
    return filePath;
  };
  // The ledger backend.js builds beside the config file, exactly as usage-lane-ledger.js writes it.
  fs.writeFileSync(path.join(tmpDir, 'usage-lanes.json'), JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: [
      { claudeSessionId: 'lane-session', lane: 'navigator', ts: Date.now() },
      { claudeSessionId: 'card-session', lane: 'interactive', ts: Date.now() },
    ],
  }), 'utf8');
  return { env: { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: path.join(tmpDir, 'no-codex'), GROK_HOME: path.join(tmpDir, 'no-grok') }, laneFile: write('lane-session'), cardFile: write('card-session') };
}

function assistantLine(text, sessionId) {
  return `${JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    cwd: 'C:\\repo',
    sessionId,
    timestamp: new Date().toISOString(),
  })}\n`;
}

test('a completed agent turn reaches the rings and the digest, and a lane session never does', withBackend(
  { ingest: AGENT_LOGS_ON },
  async ({ backend, seeded }) => {
    const lane = backend.getIngestLane();
    assert.equal(lane.agentLogsEnabled, true);
    await lane.agentLogs.start();
    // backend.js loads the ledger eagerly at boot but cannot await it from a synchronous factory, so
    // give that one read a tick before asking it which lane spawned what.
    await new Promise((resolve) => { setTimeout(resolve, 50).unref(); });

    fs.appendFileSync(seeded.cardFile, assistantLine('Ran the suite and it is green.', 'card-session'), 'utf8');
    fs.appendFileSync(seeded.laneFile, assistantLine('the navigator talking to itself', 'lane-session'), 'utf8');
    await lane.agentLogs.poll();

    const summaries = lane.recentEvents().map((event) => event.summary);
    assert.deepEqual(summaries, ['claude: Ran the suite and it is green.']);
    assert.ok(lane.buildDigest({}).includes('Ran the suite and it is green.'));
  },
  {
    seed: seedTranscripts,
    backendOptions: (seeded) => ({ ingestLaneOptions: { agentLogOptions: { env: seeded.env } } }),
  },
));

test('the agentLogs source off builds no adapter, even with the lane on', withBackend({ ingest: INGEST_ON }, async ({ backend }) => {
  const lane = backend.getIngestLane();
  assert.equal(lane.agentLogsEnabled, false);
  assert.equal(lane.agentLogs, null);
}));

// --- Wire ------------------------------------------------------------------

test('a connecting dashboard is repaired with one ingest snapshot', withBackend({ ingest: INGEST_ON }, async ({ backend, base, track }) => {
  const lane = backend.getIngestLane();
  lane.publish({ source: 'terminal', kind: 'output', summary: 'earlier output', scope: { root: '/repo' } });

  const { ws, received } = await openRecordingSocket(`${base}/control`);
  track(ws);
  const snapshot = await waitFor(received, (msg) => msg.type === 'ingest-snapshot');
  assert.deepEqual(snapshot.events.map((event) => event.summary), ['earlier output']);
  assert.deepEqual(snapshot.sources, ['terminal']);
}));

test('a batched activity delta reaches the dashboard, and is deliberately not replayable', withBackend({ ingest: INGEST_ON }, async ({ backend, base, track }) => {
  const { ws, received } = await openRecordingSocket(`${base}/control`);
  track(ws);
  await waitFor(received, (msg) => msg.type === 'ingest-snapshot');

  const lane = backend.getIngestLane();
  lane.publish({ source: 'terminal', kind: 'output', summary: 'live output', scope: { root: '/repo' } });
  const frame = await waitFor(received, (msg) => msg.type === 'ingest-activity');
  assert.equal(frame.overflow, 0);
  assert.deepEqual(frame.events.map((event) => event.summary), ['live output']);

  // The snapshot repairs a gap, so an activity delta must never be re-sent on reconnect: an ingest
  // event is current ring state, not the one-shot moment control-replay-core retains.
  const log = createReplayLog();
  log.stamp({ type: 'ingest-activity', events: [] });
  log.stamp({ type: 'ingest-snapshot', events: [] });
  assert.deepEqual(log.entriesSince(0).entries, []);
}));

test('no dashboard connected costs the lane nothing: publishing still fills the rings', withBackend({ ingest: INGEST_ON }, async ({ backend }) => {
  const lane = backend.getIngestLane();
  lane.publish({ source: 'terminal', kind: 'output', summary: 'nobody is watching', scope: { root: '/repo' } });
  assert.equal(lane.recentEvents().length, 1);
}));
