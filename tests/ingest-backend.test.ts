/*
 * The ingest lane inside a REAL booted backend (docs/plan-ingestion.md, M6): the config gate (absent
 * config constructs nothing at all), the connect-time snapshot on the control WS, and the load-bearing
 * ephemeral-session exclusion.
 *
 * That exclusion is the whole reason the tap lives in wireSessionEvents: visions dispatch sessions are
 * PTY sessions too, and tapping one feeds the Visions lane's own output back into its next prompt. This
 * file pins BOTH halves of the rule, because either alone would pass while the bug is present: a project
 * session that goes through wireSessionEvents IS tapped, and a session registered through
 * registerEphemeralSession (the one seam every lane uses) is NOT.
 *
 * SAFETY: every boot points at a throwaway temp config with ZERO real project paths via GLISSA_CONFIG,
 * like every other backend boot test, and no session is ever started, so nothing spawns a PTY.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

import { createBackend } from '../server/backend.ts';
import type { CreateBackendOptions } from '../server/backend.ts';
import { dashboardClient } from './helpers/dashboard-ws.ts';
import type { DashboardClient } from './helpers/dashboard-ws.ts';
import { closeServer, listenOnLoopback } from './helpers/http-server.ts';
import { ingestLane, visionsLane } from './helpers/lanes.ts';
import { createReplayLog } from '../server/control-replay-core.ts';
import { ACTIVITY_METHOD } from '../server/core/ingest-editor-core.ts';
import { registerEphemeralSession } from '../server/ephemeral-session.ts';
import { hasGit, git } from './helpers/git-fixture.ts';

type Backend = ReturnType<typeof createBackend>;

const INGEST_ON = { enabled: true, sources: { terminal: { enabled: true } } };
const MESSAGE_WAIT_MS = 5000;

// The frames these suites read off a control socket.
interface ControlFrame {
  type: string;
  [field: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// The health snapshot's anomaly flags, narrowed once rather than at each read.
function anomalies(frame: ControlFrame): Record<string, unknown> {
  const stats = frame.stats;
  if (!isRecord(stats) || !isRecord(stats.anomalies)) throw new Error('a health snapshot carries its anomalies');
  return stats.anomalies;
}

// The ingest frames the connect snapshot carries.
function snapshotEvents(frame: ControlFrame): { summary?: unknown }[] {
  const events = frame.events;
  if (!Array.isArray(events)) throw new Error('an ingest snapshot carries its events');
  return events.map((event: unknown) => (isRecord(event) ? event : {}));
}

interface StubWatcher {
  subscribed: string[];
  unsubscribed: string[];
  module: { subscribe: (root: string) => Promise<{ unsubscribe: () => Promise<void> }> };
}

// Whatever a test's own seed step built beside its config, before the backend booted. Each field is
// optional because each test seeds only what it needs; `seededPath` states the one it is about to read.
interface Seeded {
  projectDir?: string;
  laneDir?: string;
  watcher?: StubWatcher;
  env?: NodeJS.ProcessEnv;
  laneFile?: string;
  cardFile?: string;
  historyFile?: string;
}

interface BackendContext {
  backend: Backend;
  projectDir: string;
  seeded: Seeded;
  dash: DashboardClient;
  track: (ws: WebSocket) => WebSocket;
}

interface WithBackendOptions {
  backendOptions?: ((seeded: Seeded) => Partial<CreateBackendOptions>) | null;
  seed?: ((paths: { tmpDir: string; cfgPath: string }) => Seeded) | null;
}

/*
 * A lane's ephemeral session as registration and the root derivations see it: an EventEmitter with an
 * id, its checkout and a destroy(). Deliberately not a real Session, because the property under test is
 * that an ephemeral one never enters the persisted map those derivations read.
 */
class FakeEphemeralSession extends EventEmitter {
  id: string;

  path: string | null;

  worktreeDir: string | null;

  state: string;

  constructor(id: string, { path = null, worktreeDir = null, state = 'DORMANT' }: {
    path?: string | null;
    worktreeDir?: string | null;
    state?: string;
  } = {}) {
    super();
    this.id = id;
    this.path = path;
    this.worktreeDir = worktreeDir;
    this.state = state;
  }

  destroy(): void {}
}

function seededPath(value: string | undefined, what: string): string {
  if (!value) throw new Error(`this test seeded no ${what}`);
  return value;
}

function seededWatcher(seeded: Seeded): StubWatcher {
  if (!seeded.watcher) throw new Error('this test seeded no stub watcher');
  return seeded.watcher;
}

// The lane accessors below answer null when the source is off; every case reading one has it on.
function laneOf(backend: Backend) {
  const lane = ingestLane(backend);
  if (!lane) throw new Error('the ingest lane was never constructed');
  return lane;
}

function fsSourceOf(backend: Backend) {
  const source = laneOf(backend).fs;
  if (!source) throw new Error('the fs source is off on this lane');
  return source;
}

function gitSourceOf(backend: Backend) {
  const source = laneOf(backend).git;
  if (!source) throw new Error('the git source is off on this lane');
  return source;
}

function agentLogsOf(backend: Backend) {
  const source = laneOf(backend).agentLogs;
  if (!source) throw new Error('the agentLogs source is off on this lane');
  return source;
}

function shellHistoryOf(backend: Backend) {
  const source = laneOf(backend).shellHistory;
  if (!source) throw new Error('the shellHistory source is off on this lane');
  return source;
}

function visionsOf(backend: Backend) {
  const lane = visionsLane(backend);
  if (!lane) throw new Error('the visions lane is off on this boot');
  return lane;
}

function sessionOf(backend: Backend, id: string) {
  const session = backend.getSession(id);
  if (!session) throw new Error(`this boot built no session ${id}`);
  return session;
}

function withBackend(
  configExtras: Record<string, unknown>,
  fn: (context: BackendContext) => Promise<void>,
  { backendOptions = null, seed = null }: WithBackendOptions = {},
): () => Promise<void> {
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
    const seeded: Seeded = seed ? seed({ tmpDir, cfgPath }) : {};

    const server = http.createServer();
    const backend = createBackend(server, { staticDir: null, ...(backendOptions ? backendOptions(seeded) : {}) });
    server.on('request', backend.app);
    const port = await listenOnLoopback(server);
    const sockets: WebSocket[] = [];
    try {
      await fn({
        backend,
        projectDir,
        seeded,
        dash: await dashboardClient(port),
        track: (ws: WebSocket) => { sockets.push(ws); return ws; },
      });
    } finally {
      for (const ws of sockets) ws.close();
      backend.shutdown();
      server.closeAllConnections();
      await closeServer(server);
      if (prevEnv == null) delete process.env.GLISSA_CONFIG;
      if (prevEnv != null) process.env.GLISSA_CONFIG = prevEnv;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

// Recording starts before 'open' resolves: the connect frames land the instant the socket does.
function openRecordingSocket(dash: DashboardClient, pathAndSearch = '/control'): Promise<{ ws: WebSocket; received: ControlFrame[] }> {
  const ws = new WebSocket(dash.url(pathAndSearch), dash.options);
  const received: ControlFrame[] = [];
  ws.on('message', (raw: Buffer) => received.push(JSON.parse(raw.toString())));
  return new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.once('open', () => resolve({ ws, received }));
  });
}

function waitFor(received: ControlFrame[], match: (frame: ControlFrame) => boolean): Promise<ControlFrame> {
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

// Waits on a condition a boot-time async pass will satisfy, for the cases where asking the backend to do
// the work itself would be the very thing under test.
function until(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + MESSAGE_WAIT_MS;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(message));
        return;
      }
      setTimeout(poll, 20).unref();
    };
    poll();
  });
}

// --- Config gating --------------------------------------------------------

test('with no ingest config the lane is never constructed and no session is tapped', withBackend({}, async ({ backend }) => {
  assert.equal(ingestLane(backend), null);
  const sess = sessionOf(backend, 'p1');
  assert.ok(sess, 'the project session should exist');
  assert.equal(sess.listenerCount('data'), 0, 'a lane that was never built cannot have tapped anything');
  assert.equal(sess.listenerCount('rebaseline'), 1, 'only the pre-existing data-client rebaseline listener');
}));

test('ingest enabled false is as inert as ingest absent', withBackend({ ingest: { enabled: false, sources: { terminal: { enabled: true } } } }, async ({ backend }) => {
  assert.equal(ingestLane(backend), null);
  assert.equal(sessionOf(backend, 'p1').listenerCount('data'), 0);
}));

test('the lane on with every source off builds no adapter and taps nothing', withBackend({ ingest: { enabled: true } }, async ({ backend }) => {
  const lane = laneOf(backend);
  assert.ok(lane, 'the lane itself is constructed');
  assert.equal(lane.terminalEnabled, false);
  assert.deepEqual(lane.sources, []);
  assert.equal(lane.tapCount, 0);
  assert.equal(sessionOf(backend, 'p1').listenerCount('data'), 0);
}));

// --- The tap and its exclusion --------------------------------------------

test('a project session is tapped, because it goes through wireSessionEvents', withBackend({ ingest: INGEST_ON }, async ({ backend }) => {
  const lane = laneOf(backend);
  assert.equal(lane.terminalEnabled, true);
  assert.equal(lane.tapCount, 1);
  const sess = sessionOf(backend, 'p1');
  assert.equal(sess.listenerCount('data'), 1);

  // The tap is real, not merely present: output published through it reaches the rings.
  sess.emit('data', 'a command ran here\n');
  await new Promise((resolve) => { setTimeout(resolve, 700).unref(); });
  const summaries = lane.recentEvents().map((event) => event.summary);
  assert.deepEqual(summaries, ['a command ran here']);
  assert.ok(lane.buildDigest({}).includes('a command ran here'));
}));

test('an ephemeral lane session is NOT tapped, which is what keeps the visions out of its own prompt', withBackend({ ingest: INGEST_ON }, async ({ backend }) => {
  const lane = laneOf(backend);
  assert.equal(lane.tapCount, 1, 'only the project session');

  // Exactly how every ephemeral lane registers its session: the one seam, and it never touches
  // wireSessionEvents, which is where the tap lives.
  const ephemeral = new FakeEphemeralSession('visions:file:///tmp/plan.md');
  registerEphemeralSession({
    map: new Map(),
    id: ephemeral.id,
    sess: ephemeral,
    closeSessionDataClients: () => {},
    logPrefix: 'visions',
    name: 'visions dispatch',
  });

  assert.equal(ephemeral.listenerCount('data'), 0, 'no ingest tap may ride an ephemeral session');
  assert.equal(lane.tapCount, 1, 'the tap count must not have moved');

  // And its output goes nowhere even if something does emit it.
  ephemeral.emit('data', 'the visions talking to itself\n');
  await new Promise((resolve) => { setTimeout(resolve, 700).unref(); });
  assert.equal(lane.recentEvents().length, 0);
}));

// --- The git watch set and its exclusion ----------------------------------

const GIT_ON = { enabled: true, sources: { git: { enabled: true } } };

/*
 * Two rules at once, both of which a booted backend is the only place to see.
 *
 * The watch set has to be POPULATED at boot. The lane is constructed before the session-construction loop
 * runs (the Visions lane below it takes this one's digest as a dependency), so the source's provider
 * would see an empty map and the source would sit inert until its first 60s poll, whose first read of each
 * repo is a baseline: a commit made in that window would be absorbed and never reported. Nothing here
 * calls reconcile(), deliberately, so removing backend.js's boot poke fails this test.
 *
 * And the set is derived from the persisted `sessions` map and nothing else, which is what keeps every
 * ephemeral lane's checkout outside it BY CONSTRUCTION: a pr-review worktree and a visions dispatch
 * workdir belong to sessions registered through registerEphemeralSession, which never enter that map.
 * Same mechanism as the terminal tap's placement in wireSessionEvents above, pinned here because a filter
 * added later would be the wrong fix.
 */
test('the git watch set is populated at boot, and never by an ephemeral lane session', { skip: !hasGit() }, withBackend(
  { ingest: GIT_ON },
  async ({ backend, seeded }) => {
    const lane = laneOf(backend);
    assert.equal(lane.gitEnabled, true);
    const projectGitDir = fs.realpathSync.native(path.join(seededPath(seeded.projectDir, 'project directory'), '.git'));
    await until(() => gitSourceOf(backend).repoCount === 1, 'the boot poke should have derived the watch set');
    assert.deepEqual(gitSourceOf(backend).repoKeys, [projectGitDir]);

    const ephemeral = new FakeEphemeralSession('pr-review:42', { path: seededPath(seeded.laneDir, 'lane directory'), worktreeDir: seededPath(seeded.laneDir, 'lane directory') });
    registerEphemeralSession({
      map: new Map(),
      id: ephemeral.id,
      sess: ephemeral,
      closeSessionDataClients: () => {},
      logPrefix: 'pr-review',
      name: 'pr review',
    });

    // The same seam a real worktree-ready uses, so the re-derivation is genuine rather than assumed.
    await lane.noteRepos();
    assert.deepEqual(
      gitSourceOf(backend).repoKeys,
      [projectGitDir],
      'a lane session in a real repo of its own must not widen the watch set',
    );
  },
  {
    seed: ({ tmpDir }) => {
      const projectDir = path.join(tmpDir, 'project');
      const laneDir = path.join(tmpDir, 'lane-repo');
      fs.mkdirSync(laneDir);
      for (const dir of [projectDir, laneDir]) {
        try {
          git(['init', '-b', 'main'], dir);
        } catch {
          git(['init'], dir);
        }
      }
      return { projectDir, laneDir };
    },
  },
));

// --- The fs watch set and its exclusion -----------------------------------

const FS_ON = { enabled: true, sources: { fs: { enabled: true } } };

/*
 * A stub @parcel/watcher, because what a booted backend is the only place to see is the ROOT DERIVATION:
 * which sessions contribute a root, and on which lifecycle edges. The real native subscription is covered
 * in tests/ingest-fs.test.js, and installing one here would leave a live OS handle on the temp directory
 * the harness deletes on the way out.
 */
function stubWatcher(): StubWatcher {
  const subscribed: string[] = [];
  const unsubscribed: string[] = [];
  return {
    subscribed,
    unsubscribed,
    module: {
      subscribe: async (root: string) => {
        subscribed.push(root);
        return { unsubscribe: async () => { unsubscribed.push(root); } };
      },
    },
  };
}

const withStubWatcher: WithBackendOptions = {
  seed: ({ tmpDir }) => ({ projectDir: path.join(tmpDir, 'project'), watcher: stubWatcher() }),
  backendOptions: (seeded) => ({
    ingestLaneOptions: { fsOptions: { loadWatcher: () => seededWatcher(seeded).module } },
  }),
};

// The transition a real spawn drives, minus the PTY: the backend's own state-change listener is what
// turns it into a watched root, so nothing here calls the source directly.
function transition(sess: { state: string; emit: (event: string, payload: unknown) => unknown }, to: string): void {
  const from = sess.state;
  sess.state = to;
  sess.emit('state-change', { from, to, event: 'test', detail: null });
}

/*
 * The fs source follows LIVE sessions, which is the difference between it and the git source: git watches
 * the checkouts of every persisted session, while an fs watcher on an idle project would cost a recursive
 * subscription for a session nobody started. So the root arrives on the start edge and leaves on the exit
 * edge, and a machine with nothing running watches nothing at all.
 */
test('an fs root appears when a session starts and leaves when it exits', withBackend(
  { ingest: FS_ON },
  async ({ backend, seeded }) => {
    const lane = laneOf(backend);
    assert.equal(lane.fsEnabled, true);
    const projectRoot = fs.realpathSync.native(seededPath(seeded.projectDir, 'project directory'));
    assert.deepEqual(fsSourceOf(backend).roots, [], 'a dormant session has started nothing to watch');

    const sess = sessionOf(backend, 'p1');
    transition(sess, 'STARTING');
    await fsSourceOf(backend).settle();
    assert.deepEqual(fsSourceOf(backend).roots, [projectRoot]);
    assert.deepEqual(seededWatcher(seeded).subscribed, [projectRoot]);

    // Every transition in between re-registers the same root, and must cost nothing.
    transition(sess, 'RUNNING');
    transition(sess, 'IDLE');
    transition(sess, 'COMPLETE');
    await fsSourceOf(backend).settle();
    assert.deepEqual(seededWatcher(seeded).subscribed, [projectRoot], 'a live session never resubscribes its root');

    transition(sess, 'DONE');
    await fsSourceOf(backend).settle();
    assert.deepEqual(fsSourceOf(backend).roots, []);
    assert.deepEqual(seededWatcher(seeded).unsubscribed, [projectRoot]);
  },
  withStubWatcher,
));

test('a rebuilt fs lane follows state changes from a pre-existing live session', withBackend(
  { ingest: FS_ON },
  async ({ backend, seeded, dash, track }) => {
    const firstLane = laneOf(backend);
    const projectRoot = fs.realpathSync.native(seededPath(seeded.projectDir, 'project directory'));
    const sess = sessionOf(backend, 'p1');
    transition(sess, 'STARTING');
    await fsSourceOf(backend).settle();
    assert.deepEqual(fsSourceOf(backend).roots, [projectRoot]);

    const { ws, received } = await openRecordingSocket(dash);
    track(ws);
    ws.send(JSON.stringify({
      type: 'update-settings',
      requestId: 'rebuild-ingest',
      settings: { visions: { enabled: true, dispatch: { enabled: false } } },
    }));
    await waitFor(received, (message) => message.type === 'settings-updated');
    await until(() => ingestLane(backend) !== firstLane, 'the ingest lane was never rebuilt');

    await fsSourceOf(backend).settle();
    assert.deepEqual(fsSourceOf(backend).roots, [projectRoot]);
    transition(sess, 'DONE');
    await fsSourceOf(backend).settle();
    assert.deepEqual(fsSourceOf(backend).roots, []);
  },
  withStubWatcher,
));

// The lane's own rule, and the reason the edge is a gated listener rather than an optional-chained one:
// a source that is off owes a session zero listeners, not a no-op listener per transition.
test('with the fs source off a session carries no extra state-change listener', withBackend(
  { ingest: INGEST_ON },
  async ({ backend }) => {
    const lane = laneOf(backend);
    assert.equal(lane.fsEnabled, false);
    assert.equal(lane.fs, null);
    assert.equal(sessionOf(backend, 'p1').listenerCount('state-change'), 1, 'only the pre-existing handler');
  },
));

/*
 * Same mechanism as the terminal tap and the git watch set, pinned for the same reason: ephemeral lane
 * sessions (pr-review, visions dispatch, posthog, pack-distill) register through their own seam and
 * never pass through wireSessionEvents, which is where the fs root edge lives. A visions dispatch
 * workdir entering the watch set would feed the dispatch's own file writes back into its next prompt.
 */
test('an ephemeral lane session never contributes an fs root', withBackend(
  { ingest: FS_ON },
  async ({ backend, seeded }) => {
    const ephemeral = new FakeEphemeralSession('visions:file:///tmp/plan.md', { path: seededPath(seeded.projectDir, 'project directory'), worktreeDir: seededPath(seeded.projectDir, 'project directory'), state: 'DORMANT' });
    registerEphemeralSession({
      map: new Map(),
      id: ephemeral.id,
      sess: ephemeral,
      closeSessionDataClients: () => {},
      logPrefix: 'visions',
      name: 'visions dispatch',
    });

    // Even driven all the way through a live lifecycle, it reaches no listener that could widen the set.
    transition(ephemeral, 'STARTING');
    transition(ephemeral, 'RUNNING');
    await fsSourceOf(backend).settle();

    assert.deepEqual(fsSourceOf(backend).roots, [], 'no lane session may put a root on the watch set');
    assert.deepEqual(seededWatcher(seeded).subscribed, []);
  },
  withStubWatcher,
));

// --- Health anomaly --------------------------------------------------------

// The tap is a server-side `data` listener with no data-WS client behind it. Before the health
// snapshot learned about it, every tapped session tripped listenerMismatch permanently, which lit
// the Radar attention dot on an otherwise healthy install.
test('the ingest tap does not trip the listener-mismatch anomaly, and a real leak still does', withBackend({ ingest: INGEST_ON }, async ({ backend, dash, track }) => {
  assert.equal(laneOf(backend).tapCount, 1);
  const { ws, received } = await openRecordingSocket(dash);
  track(ws);
  const snapshot = await waitFor(received, (msg) => msg.type === 'health-snapshot');
  assert.equal(anomalies(snapshot).listenerMismatch, false, 'a tapped session with zero data clients is healthy');

  // A listener nothing accounts for is still a leak worth flagging.
  sessionOf(backend, 'p1').on('data', () => {});
  const mark = received.length;
  ws.send(JSON.stringify({ type: 'request-health-snapshot' }));
  const leaked = await waitFor(received, (msg) => msg.type === 'health-snapshot' && received.indexOf(msg) >= mark);
  assert.equal(anomalies(leaked).listenerMismatch, true);
}));

// --- The agent-log source and its ledger seam ------------------------------

/*
 * The agent-log source pointed at a throwaway Claude home, so a booted backend never reads the
 * operator's real transcripts. What this proves that the adapter's own tests cannot is the SEAM: that
 * backend.js hands the usage-lane ledger to the lane, which is the whole feedback-loop exclusion.
 */
const AGENT_LOGS_ON = { enabled: true, sources: { agentLogs: { enabled: true } } };

function seedTranscripts({ tmpDir }: { tmpDir: string }): Seeded {
  const claudeHome = path.join(tmpDir, 'claude-home');
  const projects = path.join(claudeHome, 'projects');
  const projectDir = path.join(projects, 'C--repo');
  fs.mkdirSync(projectDir, { recursive: true });
  const write = (sessionId: string) => {
    const filePath = path.join(projectDir, `${sessionId}.jsonl`);
    fs.writeFileSync(filePath, '', 'utf8');
    return filePath;
  };
  // The ledger backend.js builds beside the config file, exactly as usage-lane-ledger.js writes it.
  fs.writeFileSync(path.join(tmpDir, 'usage-lanes.json'), JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: [
      { claudeSessionId: 'lane-session', lane: 'visions', ts: Date.now() },
      { claudeSessionId: 'card-session', lane: 'interactive', ts: Date.now() },
    ],
  }), 'utf8');
  return { env: { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: path.join(tmpDir, 'no-codex'), GROK_HOME: path.join(tmpDir, 'no-grok') }, laneFile: write('lane-session'), cardFile: write('card-session') };
}

function assistantLine(text: string, sessionId: string): string {
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
    const lane = laneOf(backend);
    assert.equal(lane.agentLogsEnabled, true);
    await agentLogsOf(backend).start();
    // backend.js loads the ledger eagerly at boot but cannot await it from a synchronous factory, so
    // give that one read a tick before asking it which lane spawned what.
    await new Promise((resolve) => { setTimeout(resolve, 50).unref(); });

    fs.appendFileSync(seededPath(seeded.cardFile, 'card transcript'), assistantLine('Ran the suite and it is green.', 'card-session'), 'utf8');
    fs.appendFileSync(seededPath(seeded.laneFile, 'lane transcript'), assistantLine('the visions talking to itself', 'lane-session'), 'utf8');
    await agentLogsOf(backend).poll();

    const summaries = lane.recentEvents().map((event) => event.summary);
    assert.deepEqual(summaries, ['claude: Ran the suite and it is green.']);
    assert.ok(lane.buildDigest({}).includes('Ran the suite and it is green.'));
  },
  {
    seed: seedTranscripts,
    backendOptions: (seeded) => ({ ingestLaneOptions: { agentLogOptions: { env: seeded.env } } }),
  },
));

test('an editor buffer opened through the Visions lane reaches the rings as a marker', withBackend(
  {
    ingest: { enabled: true, sources: { editor: { enabled: true } } },
    visions: { enabled: true, dispatch: { enabled: false } },
  },
  async ({ backend, projectDir }) => {
    const lane = laneOf(backend);
    assert.equal(lane.editorEnabled, true);

    const uri = `file://${projectDir.replace(/\\/g, '/')}/docs/plan.md`;
    const connection = visionsOf(backend).openConnection({ send: () => {} });
    connection.handleFrame(JSON.stringify({
      type: 'lsp',
      method: 'textDocument/didOpen',
      params: { textDocument: { uri, languageId: 'markdown', version: 1, text: '# Plan\n' } },
    }));
    connection.handleFrame(JSON.stringify({ type: 'lsp', method: 'textDocument/didSave', params: { textDocument: { uri } } }));

    const events = lane.recentEvents();
    assert.deepEqual(events.map((event) => event.kind), ['doc-save', 'doc-open']);
    assert.deepEqual(events.map((event) => event.summary), ['saved docs/plan.md', 'opened docs/plan.md']);
    // The buffer text is what this source must never carry: it would ride into the next dispatch prompt.
    assert.equal(events.some((event) => JSON.stringify(event).includes('# Plan')), false);
    assert.equal(events[0].scope.root, projectDir);
  },
));

test('a file the lane never mirrors still reports its save as a marker', withBackend(
  {
    ingest: { enabled: true, sources: { editor: { enabled: true } } },
    visions: { enabled: true, dispatch: { enabled: false } },
  },
  async ({ backend, projectDir }) => {
    const uri = `file://${projectDir.replace(/\\/g, '/')}/src/app.js`;
    const connection = visionsOf(backend).openConnection({ send: () => {} });
    connection.handleFrame(JSON.stringify({
      type: 'lsp',
      method: ACTIVITY_METHOD,
      params: { uri, method: 'textDocument/didSave' },
    }));

    const events = laneOf(backend).recentEvents();
    assert.deepEqual(events.map((event) => event.summary), ['saved src/app.js']);
    assert.equal(events[0].scope.root, projectDir);
  },
));

test('with the editor source off a mirrored buffer publishes nothing', withBackend(
  {
    ingest: { enabled: true, sources: { terminal: { enabled: true }, editor: { enabled: false } } },
    visions: { enabled: true, dispatch: { enabled: false } },
  },
  async ({ backend, projectDir }) => {
    const lane = laneOf(backend);
    assert.equal(lane.editorEnabled, false);
    const connection = visionsOf(backend).openConnection({ send: () => {} });
    connection.handleFrame(JSON.stringify({
      type: 'lsp',
      method: 'textDocument/didOpen',
      params: { textDocument: { uri: `file://${projectDir.replace(/\\/g, '/')}/docs/plan.md`, languageId: 'markdown', version: 1, text: '# Plan\n' } },
    }));
    assert.deepEqual(lane.recentEvents(), []);
  },
));

test('the agentLogs source off builds no adapter, even with the lane on', withBackend({ ingest: INGEST_ON }, async ({ backend }) => {
  const lane = laneOf(backend);
  assert.equal(lane.agentLogsEnabled, false);
  assert.equal(lane.agentLogs, null);
}));

/*
 * The shell-history source (docs/plan-ingestion.md, M10). It is the one source reading data created
 * OUTSIDE glissa's own surfaces, so the default-off rule is the load-bearing one here: it must stay
 * inert with the lane on and every other source running, and only an explicit `enabled: true` builds it.
 *
 * SAFETY: the PSReadLine directory is a throwaway temp path injected through APPDATA with an explicit
 * `platform`, so no test here reads the operator's real shell history.
 */
const SHELL_HISTORY_ON = { enabled: true, sources: { shellHistory: { enabled: true } } };

function seedShellHistory({ tmpDir }: { tmpDir: string }): Seeded {
  const appData = path.join(tmpDir, 'AppData', 'Roaming');
  const psDir = path.join(appData, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine');
  fs.mkdirSync(psDir, { recursive: true });
  const historyFile = path.join(psDir, 'ConsoleHost_history.txt');
  fs.writeFileSync(historyFile, 'npm install\ngit push\n', 'utf8');
  return { historyFile, env: { APPDATA: appData, HOME: tmpDir, USERPROFILE: tmpDir } };
}

const withSeededShell: WithBackendOptions = {
  seed: seedShellHistory,
  backendOptions: (seeded) => ({
    ingestLaneOptions: { shellHistoryOptions: { env: seeded.env, platform: 'win32' } },
  }),
};

test('shellHistory stays off with the lane on and another source running', withBackend({ ingest: INGEST_ON }, async ({ backend }) => {
  const lane = laneOf(backend);
  assert.equal(lane.shellHistoryEnabled, false, 'it is the one source that never rides the lane flag');
  assert.equal(lane.shellHistory, null);
  assert.ok(!lane.sources.includes('shellHistory'));
}));

test('a command accepted in an external shell reaches the feed and the digest as machine scope', withBackend(
  { ingest: SHELL_HISTORY_ON },
  async ({ backend, seeded }) => {
    const lane = laneOf(backend);
    assert.equal(lane.shellHistoryEnabled, true);
    await shellHistoryOf(backend).start();
    assert.equal(shellHistoryOf(backend).trackedCount, 1, 'the seeded history file is tailed');

    fs.appendFileSync(seededPath(seeded.historyFile, 'history file'), 'npm run deploy\n', 'utf8');
    await shellHistoryOf(backend).poll();

    const [event] = lane.recentEvents();
    assert.equal(event.summary, 'powershell: npm run deploy');
    assert.deepEqual(event.scope, { root: null, sessionId: null });
    /*
     * The M7 contract drops a null-root agentLogs event precisely because machine scope belongs to this
     * source; here the digest must render it, labelled, rather than silently omitting it.
     */
    const digest = lane.buildDigest({});
    assert.ok(digest.includes('- shell '), digest);
    assert.ok(digest.includes('(machine scope): powershell: npm run deploy'), digest);
  },
  withSeededShell,
));

test('a machine-scope command survives a project-scoped digest, since it belongs to no project', withBackend(
  { ingest: SHELL_HISTORY_ON },
  async ({ backend, seeded }) => {
    const lane = laneOf(backend);
    await shellHistoryOf(backend).start();
    fs.appendFileSync(seededPath(seeded.historyFile, 'history file'), 'cargo build --release\n', 'utf8');
    await shellHistoryOf(backend).poll();

    const scoped = lane.buildDigest({ scopes: ['C:\\some\\other\\repo'] });
    assert.ok(scoped.includes('cargo build --release'), scoped);
  },
  withSeededShell,
));

// --- Wire ------------------------------------------------------------------

test('a connecting dashboard is repaired with one ingest snapshot', withBackend({ ingest: INGEST_ON }, async ({ backend, dash, track }) => {
  const lane = laneOf(backend);
  lane.publish({ source: 'terminal', kind: 'output', summary: 'earlier output', scope: { root: '/repo' } });

  const { ws, received } = await openRecordingSocket(dash);
  track(ws);
  const snapshot = await waitFor(received, (msg) => msg.type === 'ingest-snapshot');
  assert.deepEqual(snapshotEvents(snapshot).map((event) => event.summary), ['earlier output']);
  assert.deepEqual(snapshot.sources, ['terminal']);
}));

test('a batched activity delta reaches the dashboard, and is deliberately not replayable', withBackend({ ingest: INGEST_ON }, async ({ backend, dash, track }) => {
  const { ws, received } = await openRecordingSocket(dash);
  track(ws);
  await waitFor(received, (msg) => msg.type === 'ingest-snapshot');

  const lane = laneOf(backend);
  lane.publish({ source: 'terminal', kind: 'output', summary: 'live output', scope: { root: '/repo' } });
  const frame = await waitFor(received, (msg) => msg.type === 'ingest-activity');
  assert.equal(frame.overflow, 0);
  assert.deepEqual(snapshotEvents(frame).map((event) => event.summary), ['live output']);

  // The snapshot repairs a gap, so an activity delta must never be re-sent on reconnect: an ingest
  // event is current ring state, not the one-shot moment control-replay-core retains.
  const log = createReplayLog();
  log.stamp({ type: 'ingest-activity', events: [] });
  log.stamp({ type: 'ingest-snapshot', events: [] });
  assert.deepEqual(log.entriesSince(0).entries, []);
}));

test('no dashboard connected costs the lane nothing: publishing still fills the rings', withBackend({ ingest: INGEST_ON }, async ({ backend }) => {
  const lane = laneOf(backend);
  lane.publish({ source: 'terminal', kind: 'output', summary: 'nobody is watching', scope: { root: '/repo' } });
  assert.equal(lane.recentEvents().length, 1);
}));

// --- Activity-driven dispatch, both halves of the seam (docs/plan-ingestion.md, M7.5) ---

/*
 * Dispatch stays OFF in every boot below, because an enabled one spawns a real headless claude the
 * moment a gate passes. What a booted backend can prove that the unit tests cannot is the wiring itself:
 * that the ingest batch reaches the Visions lane, and that the gate's movement signal IS this lane's
 * seq. The arming and the dispatch behind that poke are pinned in tests/visions-wiring.test.js.
 */
const BOTH_LANES = { ingest: INGEST_ON, visions: { enabled: true } };

test('an ingest batch pokes the Visions lane, and its gate reads this lane seq', withBackend(BOTH_LANES, async ({ backend }) => {
  const lane = laneOf(backend);
  const visions = visionsOf(backend);
  assert.equal(visions.latestContextSeq(), 0, 'wired, and nothing has happened on the machine yet');

  let pokes = 0;
  visions.noteActivity = () => { pokes += 1; };
  lane.publish({ source: 'terminal', kind: 'output', summary: 'a command ran here', scope: { root: '/repo' } });
  assert.ok(lane.latestSeq() > 0);
  assert.equal(visions.latestContextSeq(), lane.latestSeq(), 'one signal, read from the lane that owns it');

  // The poke rides the lane's own 1s batch, so this waits out one real interval and no new timer.
  await new Promise((resolve) => { setTimeout(resolve, 1400).unref(); });
  assert.equal(pokes, 1, 'one poke for the batch, however many events it carried');
}));

// Visions IMPLIES the lane now, so ingest off here is the operator's explicit opt-out, which is the only
// thing that still produces the pre-M7.5 shape.
test('with ingest off the Visions lane is wired to no movement signal at all', withBackend({ visions: { enabled: true }, ingest: { enabled: false } }, async ({ backend }) => {
  assert.equal(ingestLane(backend), null);
  assert.equal(
    visionsOf(backend).latestContextSeq(), null,
    'a null seq is what makes every gate decision the pre-M7.5 one',
  );
}));

test('with the Visions lane off the ingest lane batches with nothing to poke', withBackend({ ingest: INGEST_ON }, async ({ backend }) => {
  const lane = laneOf(backend);
  assert.equal(backend.getLane('visions'), null);
  lane.publish({ source: 'terminal', kind: 'output', summary: 'nobody to tell', scope: { root: '/repo' } });
  await new Promise((resolve) => { setTimeout(resolve, 1400).unref(); });
  assert.equal(lane.pendingEventCount, 0, 'the batch flushed rather than falling over on a lane that is not there');
}));
