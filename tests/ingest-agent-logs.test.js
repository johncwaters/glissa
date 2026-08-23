'use strict';

/*
 * The agent-log ingest source against REAL temp directories (docs/plan-ingestion.md, M7): synthetic
 * Claude, Codex and Grok transcripts written to disk and driven end to end into the rings and the
 * digest, the EOF start, the config gate, and the feedback-loop exclusion.
 *
 * The exclusion is the load-bearing rule this file exists for. A visions dispatch is a headless Claude
 * session that writes a transcript exactly like any other, so ingesting it would feed the Visions lane's
 * own output back into its next prompt. Its two INDEPENDENT layers are pinned separately, each on a
 * fixture the other would not catch: the ledger (primary) on an ordinary project directory, and the
 * dispatch-workdir shape with no ledger present at all.
 *
 * The scale tests are not padding. A promotion pass that re-checks finished transcripts is correct on a
 * fixture of three files and starves the live session on a real projects root of several hundred
 * directories, so the fixtures there are sized to the real thing.
 *
 * SAFETY: every root is a throwaway temp directory injected through CLAUDE_CONFIG_DIR, CODEX_HOME and
 * GROK_HOME, so no test here ever reads the operator's real transcripts.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAgentLogIngest } = require('../server/ingest-agent-logs');
const { createIngestLane } = require('../server/ingest-wiring');
const { resolveIngestConfig } = require('../server/core/ingest-core');
const { encodeProjectDir } = require('../session/core/conversation-history');

// --- Harness --------------------------------------------------------------

function makeHomes() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-agentlogs-'));
  const claudeHome = path.join(tmpDir, 'claude');
  const codexHome = path.join(tmpDir, 'codex');
  const grokHome = path.join(tmpDir, 'grok');
  const projects = path.join(claudeHome, 'projects');
  fs.mkdirSync(projects, { recursive: true });
  fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(grokHome, 'sessions'), { recursive: true });
  return {
    tmpDir,
    projects,
    codexSessions: path.join(codexHome, 'sessions'),
    grokSessions: path.join(grokHome, 'sessions'),
    env: {
      CLAUDE_CONFIG_DIR: claudeHome,
      CODEX_HOME: codexHome,
      GROK_HOME: grokHome,
      HOME: tmpDir,
      USERPROFILE: tmpDir,
    },
  };
}

function inertTimers() {
  return {
    setIntervalFn: () => ({ unref() { return this; } }),
    clearIntervalFn: () => {},
    setTimeoutFn: () => ({ unref() { return this; } }),
    clearTimeoutFn: () => {},
  };
}

// Records the delays the adapter asks for, which is how the watch-event tests tell a 100ms poll poke
// from a 500ms discovery sweep without waiting for either.
function recordingTimers() {
  const timeoutDelays = [];
  return {
    timeoutDelays,
    setIntervalFn: () => ({ unref() { return this; } }),
    clearIntervalFn: () => {},
    setTimeoutFn: (_fn, delay) => { timeoutDelays.push(delay); return { unref() { return this; } }; },
    clearTimeoutFn: () => {},
  };
}

// Counts the stats the sweep spends, which is the only way to see the difference between a promotion
// pass that memoizes its rejections and one that re-walks every finished transcript forever.
function countingFs() {
  const counts = { stat: 0, readdir: 0 };
  return {
    counts,
    fsPromises: {
      ...fs.promises,
      stat: (target) => { counts.stat += 1; return fs.promises.stat(target); },
      readdir: (target, options) => { counts.readdir += 1; return fs.promises.readdir(target, options); },
    },
  };
}

// Holds the sweep open inside its first readdir, so a test can call stop() with a pass genuinely in
// flight rather than hoping to hit the window.
function gatedFs() {
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  return {
    release: () => release(),
    fsPromises: {
      ...fs.promises,
      readdir: async (target, options) => {
        await gate;
        return fs.promises.readdir(target, options);
      },
    },
  };
}

function withHomes(fn) {
  return async () => {
    const homes = makeHomes();
    const events = [];
    const warnings = [];
    const adapters = [];
    const build = (overrides = {}) => {
      const adapter = createAgentLogIngest({
        publish: (event) => events.push(event),
        env: homes.env,
        logger: { warn: (message) => warnings.push(message) },
        ...inertTimers(),
        ...overrides,
      });
      adapters.push(adapter);
      return adapter;
    };
    try {
      await fn({ ...homes, events, warnings, build });
    } finally {
      for (const adapter of adapters) adapter.stop();
      fs.rmSync(homes.tmpDir, { recursive: true, force: true });
    }
  };
}

// One assistant message as Claude Code actually writes it: cwd and sessionId on the line itself.
function claudeAssistant({ text = null, tools = [], sessionId, cwd = 'C:\\repo' }) {
  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const tool of tools) content.push({ type: 'tool_use', id: 'tu-1', name: tool.name, input: tool.input });
  return `${JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content },
    cwd,
    sessionId,
    timestamp: new Date().toISOString(),
  })}\n`;
}

// A prompt as Claude Code writes it. A tool RESULT arrives on a `user` line too, which is why the
// mapper reads the content blocks rather than the line type alone.
function claudeUser({ text, sessionId, cwd = 'C:\\repo', ts = null }) {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    cwd,
    sessionId,
    timestamp: ts || new Date().toISOString(),
  })}\n`;
}

function seedClaudeTranscript(projects, { dirName = 'C--repo', sessionId = 'sess-live', lines = [] } = {}) {
  const dir = path.join(projects, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, lines.join(''), 'utf8');
  return filePath;
}

function append(filePath, text) {
  fs.appendFileSync(filePath, text, 'utf8');
}

// --- EOF start and the happy path -----------------------------------------

test('a completed turn surfaces as an agent-turn without any of the history before it', withHomes(async ({ projects, events, build }) => {
  const filePath = seedClaudeTranscript(projects, {
    sessionId: 'sess-live',
    lines: [
      claudeAssistant({ text: 'a turn from yesterday', sessionId: 'sess-live' }),
      claudeAssistant({ text: 'another turn from yesterday', sessionId: 'sess-live' }),
    ],
  });

  const adapter = build();
  await adapter.start();
  assert.equal(adapter.trackedCount, 1, 'the live transcript is tailed');
  await adapter.poll();
  assert.deepEqual(events, [], 'lines written before start() must never publish');

  append(filePath, claudeAssistant({ text: 'Finished the refactor and ran the suite.', sessionId: 'sess-live' }));
  await adapter.poll();

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'agent-turn');
  assert.equal(events[0].summary, 'claude: Finished the refactor and ran the suite.');
  assert.deepEqual(events[0].scope, { root: 'C:\\repo', sessionId: 'sess-live' });
}));

test('a turn with tool uses publishes the turn and one event per tool call', withHomes(async ({ projects, events, build }) => {
  const filePath = seedClaudeTranscript(projects, { sessionId: 'sess-tools', lines: [] });
  const adapter = build();
  await adapter.start();

  append(filePath, claudeAssistant({
    text: 'Reading both files.',
    sessionId: 'sess-tools',
    tools: [
      { name: 'Read', input: { file_path: 'C:\\repo\\a.js' } },
      { name: 'Read', input: { file_path: 'C:\\repo\\b.js' } },
    ],
  }));
  await adapter.poll();

  assert.deepEqual(events.map((event) => event.kind), ['agent-turn', 'agent-tool', 'agent-tool']);
  assert.deepEqual(
    events.slice(1).map((event) => event.summary),
    ['claude: Read C:\\repo\\a.js', 'claude: Read C:\\repo\\b.js'],
  );
}));

test('a transcript created after start is discovered by the next sweep and tailed from its end', withHomes(async ({ projects, events, build }) => {
  const adapter = build();
  await adapter.start();
  assert.equal(adapter.trackedCount, 0);

  const filePath = seedClaudeTranscript(projects, {
    dirName: 'C--repo-two',
    sessionId: 'sess-new',
    lines: [claudeAssistant({ text: 'the opening turn', sessionId: 'sess-new', cwd: 'C:\\repo\\two' })],
  });
  await adapter.discover();
  assert.equal(adapter.trackedCount, 1);
  await adapter.poll();
  assert.deepEqual(events, [], 'even a fresh file starts at its end');

  append(filePath, claudeAssistant({ text: 'the next turn', sessionId: 'sess-new', cwd: 'C:\\repo\\two' }));
  await adapter.poll();
  assert.deepEqual(events.map((event) => event.summary), ['claude: the next turn']);
  assert.equal(events[0].scope.root, 'C:\\repo\\two');
}));

test('a line split across two polls arrives whole exactly once', withHomes(async ({ projects, events, build }) => {
  const filePath = seedClaudeTranscript(projects, { sessionId: 'sess-split' });
  const adapter = build();
  await adapter.start();

  const line = claudeAssistant({ text: 'a turn written in two writes', sessionId: 'sess-split' });
  append(filePath, line.slice(0, 40));
  await adapter.poll();
  assert.deepEqual(events, [], 'half a JSON line is not an event');

  append(filePath, line.slice(40));
  await adapter.poll();
  assert.deepEqual(events.map((event) => event.summary), ['claude: a turn written in two writes']);
}));

test('a transcript deleted and recreated at the same path is fresh state, not a continuation', withHomes(async ({ projects, events, build }) => {
  const filePath = seedClaudeTranscript(projects, { sessionId: 'sess-rotate' });
  const adapter = build();
  await adapter.start();
  append(filePath, claudeAssistant({ text: 'before the rotation', sessionId: 'sess-rotate' }));
  await adapter.poll();
  assert.equal(events.length, 1);

  fs.rmSync(filePath);
  fs.writeFileSync(filePath, claudeAssistant({ text: 'after the rotation', sessionId: 'sess-rotate' }), 'utf8');
  await adapter.poll();

  assert.deepEqual(
    events.map((event) => event.summary),
    ['claude: before the rotation', 'claude: after the rotation'],
    'the recreated file must not be read from the old offset',
  );
}));

test('a truncated transcript is read from the start rather than skipped forever', withHomes(async ({ projects, events, build }) => {
  const filePath = seedClaudeTranscript(projects, {
    sessionId: 'sess-truncate',
    lines: [claudeAssistant({ text: 'x'.repeat(300), sessionId: 'sess-truncate' })],
  });
  const adapter = build();
  await adapter.start();

  fs.writeFileSync(filePath, claudeAssistant({ text: 'the file was rewritten short', sessionId: 'sess-truncate' }), 'utf8');
  await adapter.poll();
  assert.deepEqual(events.map((event) => event.summary), ['claude: the file was rewritten short']);
}));

// --- Vendors --------------------------------------------------------------

test('a Codex rollout under its date directories reaches the rings with the session cwd', withHomes(async ({ codexSessions, events, build }) => {
  const dir = path.join(codexSessions, '2026', '08', '21');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'rollout-2026-08-21T10-32-56-01a0252b-16cf-7a93-b5f5-c7113baf3e16.jsonl');
  fs.writeFileSync(filePath, '', 'utf8');

  const adapter = build();
  await adapter.start();
  assert.equal(adapter.trackedCount, 1, 'the walk reaches three directories below the sessions root');

  append(filePath, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'session_meta',
    payload: { type: 'session_meta', session_id: 'codex-session', cwd: 'C:\\repo' },
  })}\n`);
  append(filePath, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload: { type: 'agent_message', message: 'Reviewed the plan and found two issues.' },
  })}\n`);
  await adapter.poll();

  assert.equal(events.length, 1);
  assert.equal(events[0].summary, 'codex: Reviewed the plan and found two issues.');
  assert.deepEqual(events[0].scope, { root: 'C:\\repo', sessionId: 'codex-session' });
}));

test('a Grok session publishes its completed turn once, not its chunks', withHomes(async ({ grokSessions, events, build }) => {
  const encodedCwd = encodeURIComponent('C:\\repo');
  const dir = path.join(grokSessions, encodedCwd, '019fde0f-453b-72a3-bf55-d1fd726cb2ad');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'updates.jsonl');
  fs.writeFileSync(filePath, '', 'utf8');

  const adapter = build();
  await adapter.start();
  assert.equal(adapter.trackedCount, 1, 'only updates.jsonl is a transcript, not its siblings');

  const line = (update) => `${JSON.stringify({
    timestamp: Math.floor(Date.now() / 1000),
    params: { sessionId: '019fde0f-453b-72a3-bf55-d1fd726cb2ad', update },
  })}\n`;
  append(filePath, line({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking out loud' } }));
  append(filePath, line({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Pulling current' } }));
  append(filePath, line({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'facts from Scryfall.' } }));
  await adapter.poll();
  assert.deepEqual(events, [], 'chunks are streaming, and the plan forbids one event per chunk');

  append(filePath, line({ sessionUpdate: 'turn_completed', prompt_id: 'p1', stop_reason: 'end_turn' }));
  await adapter.poll();
  assert.equal(events.length, 1);
  assert.equal(events[0].summary, 'grok: Pulling current facts from Scryfall.');
  assert.equal(events[0].scope.root, 'C:\\repo', 'the percent-encoded directory decodes back exactly');
}));

// --- The feedback-loop exclusion -------------------------------------------

/*
 * The two layers are tested SEPARATELY on purpose. Each fixture matches only its own mechanism, so a
 * regression in either one fails a test instead of being masked by the other: the ledger cases use an
 * ordinary project directory that no shape rule would catch, and the shape cases carry no ledger at all.
 */

test('layer 1, the ledger: a visions-lane transcript in an ordinary project dir is never opened', withHomes(async ({ projects, events, build }) => {
  const filePath = seedClaudeTranscript(projects, { dirName: 'C--repo', sessionId: 'visions-session' });
  const adapter = build({ laneMap: () => new Map([['visions-session', 'visions']]) });
  await adapter.start();
  assert.equal(adapter.trackedCount, 0, 'a lane transcript costs not even a tail');

  append(filePath, claudeAssistant({ text: 'the visions talking to itself', sessionId: 'visions-session' }));
  await adapter.poll();
  await adapter.discover();
  await adapter.poll();
  assert.deepEqual(events, [], 'visions dispatch output must never re-enter the next visions prompt');
}));

test('layer 1, the ledger: a record landing AFTER the sweep still stops the lane publishing', withHomes(async ({ projects, events, build }) => {
  // The in-place PR-review lane runs in the operator's REAL project directory, which is exactly the
  // case no path or workdir shape can catch and the ledger is primary for.
  const filePath = seedClaudeTranscript(projects, { dirName: 'C--repo', sessionId: 'late-lane' });
  const lanes = new Map();
  const adapter = build({ laneMap: () => lanes });
  await adapter.start();
  assert.equal(adapter.trackedCount, 1, 'nothing in the ledger yet, so the file is tailed');

  // The claude-session-id hook lands and the ledger learns which lane spawned this session.
  lanes.set('late-lane', 'pr-review');
  append(filePath, claudeAssistant({ text: 'review output arriving after the sweep', sessionId: 'late-lane' }));
  await adapter.poll();
  assert.deepEqual(events, [], 'the per-line check is what covers the record landing late');
}));

test('layer 2, the workdir shape: a dispatch transcript is excluded with NO ledger at all', withHomes(async ({ projects, events, build }) => {
  const workDir = path.join(os.tmpdir(), 'glissa-visions-abc123');
  const filePath = seedClaudeTranscript(projects, {
    dirName: encodeProjectDir(workDir),
    sessionId: 'unrecorded-visions',
  });
  // No laneMap: the ledger never heard of this session, which is the single point of failure this
  // layer exists to remove.
  const adapter = build();
  await adapter.start();
  assert.equal(adapter.trackedCount, 0, 'a dispatch workdir is not even listed');
  assert.equal(adapter.watchCount, 3, 'and it earns no watcher either, only the three vendor roots');

  append(filePath, claudeAssistant({ text: 'unrecorded dispatch output', sessionId: 'unrecorded-visions', cwd: workDir }));
  await adapter.poll();
  await adapter.discover();
  await adapter.poll();
  assert.deepEqual(events, []);
}));

test('layer 2, the workdir shape: a cwd revealed by a LINE is caught even from an ordinary dir', withHomes(async ({ projects, events, build }) => {
  const workDir = path.join(os.tmpdir(), 'glissa-visions-xyz789');
  const filePath = seedClaudeTranscript(projects, { dirName: 'C--repo', sessionId: 'moved-visions' });
  const adapter = build();
  await adapter.start();
  assert.equal(adapter.trackedCount, 1, 'the directory name gave nothing away');

  append(filePath, claudeAssistant({ text: 'dispatch output naming its own workdir', sessionId: 'moved-visions', cwd: workDir }));
  await adapter.poll();
  assert.deepEqual(events, [], 'the cwd on the line is the second place the shape can show up');
}));

test('the shape rule is a segment match, so an ordinary project named after glissa still publishes', withHomes(async ({ projects, events, build }) => {
  const filePath = seedClaudeTranscript(projects, { dirName: 'C--Users-johnw-Projects-glissa', sessionId: 'glissa-repo-session' });
  const adapter = build();
  await adapter.start();
  append(filePath, claudeAssistant({
    text: 'working in the glissa repo itself',
    sessionId: 'glissa-repo-session',
    cwd: 'C:\\Users\\johnw\\Projects\\glissa',
  }));
  await adapter.poll();
  assert.deepEqual(events.map((event) => event.summary), ['claude: working in the glissa repo itself']);
}));

test('a session the ledger calls interactive is the operator working, and publishes normally', withHomes(async ({ projects, events, build }) => {
  const filePath = seedClaudeTranscript(projects, { sessionId: 'card-session' });
  const adapter = build({ laneMap: () => new Map([['card-session', 'interactive']]) });
  await adapter.start();

  append(filePath, claudeAssistant({ text: 'the operator running their own session', sessionId: 'card-session' }));
  await adapter.poll();
  assert.deepEqual(events.map((event) => event.summary), ['claude: the operator running their own session']);
}));

test('every ephemeral lane is excluded by the same rule, with no lane-name list to drift', withHomes(async ({ projects, events, build }) => {
  const lanes = new Map();
  const files = [];
  for (const lane of ['visions', 'pr-review', 'posthog', 'pack-distill']) {
    lanes.set(`${lane}-session`, lane);
    files.push(seedClaudeTranscript(projects, { dirName: `C--lane-${lane}`, sessionId: `${lane}-session` }));
  }
  const operatorFile = seedClaudeTranscript(projects, { dirName: 'C--operator', sessionId: 'operator-session' });

  const adapter = build({ laneMap: () => lanes });
  await adapter.start();
  assert.equal(adapter.trackedCount, 1, 'only the transcript the operator drove is tailed');

  for (const filePath of files) append(filePath, claudeAssistant({ text: 'lane output', sessionId: path.basename(filePath, '.jsonl') }));
  append(operatorFile, claudeAssistant({ text: 'operator output', sessionId: 'operator-session' }));
  await adapter.poll();

  assert.deepEqual(events.map((event) => event.summary), ['claude: operator output']);
}));

// --- Scale --------------------------------------------------------------------

function setMtime(target, whenMs) {
  const when = new Date(whenMs);
  fs.utimesSync(target, when, when);
}

/*
 * Realistic scale, because this defect only exists at scale. The real projects root on the machine this
 * was written against holds 753 directories and 7167 transcripts, one directory alone holding 408. A
 * promotion pass that re-stats every finished transcript spends its whole budget on the biggest
 * directory and never reaches the live session below it, which is silent: the source simply reports
 * nothing forever.
 */
test('a big finished directory cannot starve a live session in a lower-sorting one', withHomes(async ({ projects, events, build }) => {
  const longAgo = Date.now() - (60 * 60 * 1000);
  const bigDir = path.join(projects, 'C--big-finished-project');
  fs.mkdirSync(bigDir, { recursive: true });
  for (let index = 0; index < 500; index += 1) {
    const filePath = path.join(bigDir, `finished-${index}.jsonl`);
    fs.writeFileSync(filePath, '', 'utf8');
    setMtime(filePath, longAgo);
  }
  const liveFile = seedClaudeTranscript(projects, { dirName: 'C--live-project', sessionId: 'sess-live' });

  // The big directory sorts FIRST, so it is the one that gets the budget.
  setMtime(path.join(projects, 'C--live-project'), Date.now() - 60000);
  setMtime(bigDir, Date.now());

  const counter = countingFs();
  const adapter = build({ fsPromises: counter.fsPromises, maxStatsPerSweep: 400 });

  await adapter.start();
  assert.equal(adapter.trackedCount, 0, 'sweep one is entirely consumed by the finished directory');

  // Sweep two must RESUME where sweep one stopped rather than restarting the same 400 rejections.
  await adapter.discover();
  assert.equal(adapter.trackedCount, 1, 'the live session must be reached on the next sweep');

  const before = counter.counts.stat;
  await adapter.discover();
  const spent = counter.counts.stat - before;
  assert.ok(spent < 20, `a settled tree must cost almost nothing per sweep, spent ${spent} stats`);

  append(liveFile, claudeAssistant({ text: 'the live session finally publishes', sessionId: 'sess-live' }));
  await adapter.poll();
  assert.deepEqual(events.map((event) => event.summary), ['claude: the live session finally publishes']);
}));

test('a new transcript among finished ones is still found, whether or not creating it moved the dir mtime', withHomes(async ({ projects, events, build }) => {
  const longAgo = Date.now() - (60 * 60 * 1000);
  const dir = path.join(projects, 'C--settled');
  fs.mkdirSync(dir, { recursive: true });
  for (let index = 0; index < 20; index += 1) {
    const filePath = path.join(dir, `old-${index}.jsonl`);
    fs.writeFileSync(filePath, '', 'utf8');
    setMtime(filePath, longAgo);
  }
  const adapter = build();
  await adapter.start();
  assert.equal(adapter.trackedCount, 0);

  const fresh = path.join(dir, 'brand-new.jsonl');
  fs.writeFileSync(fresh, '', 'utf8');
  await adapter.discover();
  assert.equal(adapter.trackedCount, 1);

  append(fresh, claudeAssistant({ text: 'a new session in an old project', sessionId: 'brand-new' }));
  await adapter.poll();
  assert.deepEqual(events.map((event) => event.summary), ['claude: a new session in an old project']);
}));

// Frozen clock + forced-back mtime reproduce the same-tick mtime collision deterministically on any filesystem.
test('a transcript born in the tick the last listing read is still found, not lost for the life of the daemon', withHomes(async ({ projects, build }) => {
  const tick = Math.floor(Date.now() / 1000) * 1000;
  const dir = path.join(projects, 'C--same-tick');
  fs.mkdirSync(dir, { recursive: true });
  setMtime(dir, tick);
  const adapter = build({ nowFn: () => tick });
  await adapter.start();
  assert.equal(adapter.trackedCount, 0);

  fs.writeFileSync(path.join(dir, 'sess-same-tick.jsonl'), '', 'utf8');
  setMtime(dir, tick);
  await adapter.discover();
  assert.equal(adapter.trackedCount, 1, 'an unsettled listing must be re-read rather than trusted');
}));

test('the directory listing cache is bounded rather than growing with the tree', withHomes(async ({ projects, build }) => {
  for (let index = 0; index < 6; index += 1) {
    seedClaudeTranscript(projects, { dirName: `C--project-${index}`, sessionId: `sess-${index}` });
  }
  const adapter = build({ maxCachedDirs: 3 });
  await adapter.start();
  assert.ok(adapter.cachedDirCount <= 3, `cache grew to ${adapter.cachedDirCount}`);
}));

// --- Waking back up ---------------------------------------------------------

test('a session left quiet past the active window still publishes when it resumes', withHomes(async ({ projects, events, build }) => {
  const filePath = seedClaudeTranscript(projects, { sessionId: 'sess-quiet' });
  const clock = { now: Date.now() };
  const adapter = build({ nowFn: () => clock.now, activeWithinMs: 10 * 60 * 1000 });
  await adapter.start();

  append(filePath, claudeAssistant({ text: 'the first turn', sessionId: 'sess-quiet' }));
  await adapter.poll();
  assert.deepEqual(events.map((event) => event.summary), ['claude: the first turn']);

  // The carbon unit went to lunch. This is the ordinary shape of a working session, not an edge case.
  clock.now += 20 * 60 * 1000;
  await adapter.discover();
  await adapter.poll();

  append(filePath, claudeAssistant({ text: 'the turn after lunch', sessionId: 'sess-quiet' }));
  await adapter.poll();
  assert.deepEqual(
    events.map((event) => event.summary),
    ['claude: the first turn', 'claude: the turn after lunch'],
  );
}));

test('a tail pushed out of the active set by newer work is picked back up when it moves again', withHomes(async ({ projects, events, build }) => {
  const quiet = seedClaudeTranscript(projects, { dirName: 'C--quiet', sessionId: 'sess-pushed-out' });
  const busy = seedClaudeTranscript(projects, { dirName: 'C--busy', sessionId: 'sess-busy' });
  // One active slot, so the newer file evicts the older one from the poll.
  const adapter = build({ maxActiveFiles: 1 });
  await adapter.start();

  append(busy, claudeAssistant({ text: 'busy work', sessionId: 'sess-busy' }));
  await adapter.poll();
  await adapter.discover();
  assert.equal(adapter.activeCount, 1, 'only one file may be polled');

  append(quiet, claudeAssistant({ text: 'the evicted session woke up', sessionId: 'sess-pushed-out' }));
  /*
   * The active set is ordered by mtime, and two appends microseconds apart can land on the SAME
   * filesystem timestamp, which makes the eviction order arbitrary and this test a coin flip. A session
   * that genuinely wakes up later has a later mtime; this says so instead of hoping for one.
   */
  const wokeAt = new Date(Date.now() + 1000);
  fs.utimesSync(quiet, wokeAt, wokeAt);
  await adapter.discover();
  await adapter.poll();
  assert.ok(
    events.some((event) => event.summary === 'claude: the evicted session woke up'),
    'an evicted tail must be reachable again, or it is lost for the life of the daemon',
  );
}));

// --- Watch events -----------------------------------------------------------

function watchCapture() {
  const listeners = [];
  return {
    listeners,
    watchFn: (dir, _options, listener) => {
      listeners.push({ dir, listener });
      return { close() {}, on() {} };
    },
  };
}

test('a plain append fires change, and a change must not drive a whole-tree sweep', withHomes(async ({ projects, build }) => {
  seedClaudeTranscript(projects, { sessionId: 'sess-watch' });
  const capture = watchCapture();
  const timers = recordingTimers();
  const adapter = build({ watchFn: capture.watchFn, ...timers });
  await adapter.start();

  const projectWatch = capture.listeners.find((entry) => entry.dir.endsWith('C--repo'));
  assert.ok(projectWatch, 'the project directory is watched');
  timers.timeoutDelays.length = 0;

  projectWatch.listener('change', 'sess-watch.jsonl');
  assert.deepEqual(timers.timeoutDelays, [100], 'a change pokes the poll and nothing else');

  timers.timeoutDelays.length = 0;
  projectWatch.listener('rename', 'a-new-session.jsonl');
  assert.deepEqual(timers.timeoutDelays, [500], 'only a rename can mean a transcript appeared or went');
}));

test('a change naming an untracked transcript promotes it, which is the only wakeup an append gives', withHomes(async ({ projects, events, build }) => {
  const longAgo = Date.now() - (60 * 60 * 1000);
  const filePath = seedClaudeTranscript(projects, { sessionId: 'sess-dormant' });
  setMtime(filePath, longAgo);
  const capture = watchCapture();
  const adapter = build({ watchFn: capture.watchFn });
  await adapter.start();
  assert.equal(adapter.trackedCount, 0, 'a transcript dead for an hour is not recent activity');

  // The session wakes up. Appending moves no directory mtime, so the sweep alone would never see it.
  append(filePath, claudeAssistant({ text: 'the dormant session woke', sessionId: 'sess-dormant' }));
  const projectWatch = capture.listeners.find((entry) => entry.dir.endsWith('C--repo'));
  projectWatch.listener('change', 'sess-dormant.jsonl');
  await adapter.poll();
  assert.equal(adapter.trackedCount, 1, 'the named file is promoted from the watch event');

  append(filePath, claudeAssistant({ text: 'and its next turn publishes', sessionId: 'sess-dormant' }));
  await adapter.poll();
  assert.deepEqual(events.map((event) => event.summary), ['claude: and its next turn publishes']);
}));

// --- Scope ------------------------------------------------------------------

test('an agent event with no root is dropped, because machine scope is the shellHistory contract', withHomes(async ({ codexSessions, events, build }) => {
  const dir = path.join(codexSessions, '2026', '08', '21');
  fs.mkdirSync(dir, { recursive: true });
  // No session_meta and no turn_context, so nothing in this file or its path names a project.
  const filePath = path.join(dir, 'rollout-2026-08-21T10-00-00-00000000-0000-7000-8000-000000000000.jsonl');
  fs.writeFileSync(filePath, '', 'utf8');

  const adapter = build();
  await adapter.start();
  append(filePath, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload: { type: 'agent_message', message: 'a turn belonging to no project' },
  })}\n`);
  await adapter.poll();
  assert.deepEqual(events, [], 'a rootless agent event would be labelled machine scope in every digest');
}));

test('a Codex session joined mid-file still gets its root, read once from the head', withHomes(async ({ codexSessions, events, build }) => {
  const dir = path.join(codexSessions, '2026', '08', '21');
  fs.mkdirSync(dir, { recursive: true });
  // Codex names the rollout file after its session id, which is where the id comes from, exactly as the
  // usage lane resolves it.
  const sessionId = '11111111-1111-7111-8111-111111111111';
  const filePath = path.join(dir, `rollout-2026-08-21T11-00-00-${sessionId}.jsonl`);
  // The head already holds session_meta, and the tail starts at EOF, so only a head read can recover it.
  fs.writeFileSync(filePath, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'session_meta',
    payload: { type: 'session_meta', session_id: sessionId, cwd: 'C:\\repo' },
  })}\n`, 'utf8');

  const adapter = build();
  await adapter.start();
  append(filePath, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload: { type: 'agent_message', message: 'a turn from a session already running' },
  })}\n`);
  await adapter.poll();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].scope, { root: 'C:\\repo', sessionId });
}));

test('a rotated transcript does not inherit the previous file root and session', withHomes(async ({ projects, events, build }) => {
  const filePath = seedClaudeTranscript(projects, { sessionId: 'sess-context' });
  const adapter = build();
  await adapter.start();
  append(filePath, claudeAssistant({ text: 'from the old file', sessionId: 'old-session', cwd: 'C:\\old-project' }));
  await adapter.poll();
  assert.equal(events[0].scope.root, 'C:\\old-project');

  // A new file at the same path, whose lines name no cwd of their own.
  fs.rmSync(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'from the new file' }] },
    timestamp: new Date().toISOString(),
  })}\n`, 'utf8');
  await adapter.poll();

  const latest = events[events.length - 1];
  assert.equal(latest.summary, 'claude: from the new file');
  assert.notEqual(latest.scope.root, 'C:\\old-project', 'the old cwd must not ride into the new file');
  assert.equal(latest.scope.sessionId, 'sess-context', 'the session falls back to the path, not the old line');
}));

// --- Bounds ------------------------------------------------------------------

test('lines dropped to stay inside the drain bound are reported, never silently lost', withHomes(async ({ projects, events, build }) => {
  const filePath = seedClaudeTranscript(projects, { sessionId: 'sess-flood' });
  const adapter = build({ maxLinesPerDrain: 2 });
  await adapter.start();

  let batch = '';
  for (let index = 0; index < 5; index += 1) {
    batch += claudeAssistant({ text: `turn ${index}`, sessionId: 'sess-flood' });
  }
  append(filePath, batch);
  await adapter.poll();

  assert.equal(events.length, 2, 'the drain bound holds');
  assert.ok(events[0].summary.includes('[3 earlier lines dropped]'), events[0].summary);
  assert.equal(events[0].detail.droppedLines, 3);
  assert.ok(!events[1].summary.includes('dropped'), 'the note rides one event, not every event');
}));

test('a deleted transcript stops costing a stat on every poll', withHomes(async ({ projects, build }) => {
  const filePath = seedClaudeTranscript(projects, { sessionId: 'sess-deleted' });
  const adapter = build();
  await adapter.start();
  assert.equal(adapter.trackedCount, 1);

  fs.rmSync(filePath);
  /*
   * A directory is re-listed only when its mtime moved, which is the whole scale rule. Creating and
   * deleting inside one millisecond can leave that mtime where it was, so the sweep would skip the
   * listing and the test would flake on timer resolution rather than on the behavior it pins. Any real
   * deletion has elapsed time behind it; this says so explicitly.
   */
  const deletedAt = new Date(Date.now() + 1000);
  fs.utimesSync(path.dirname(filePath), deletedAt, deletedAt);
  await adapter.discover();
  await adapter.poll();
  assert.equal(adapter.trackedCount, 0, 'a transcript its directory no longer names is gone for good');
  assert.equal(adapter.activeCount, 0);
}));

// --- Failure and lifecycle -------------------------------------------------

test('stop during an in-flight sweep leaves nothing behind when that sweep settles', withHomes(async ({ projects, build }) => {
  seedClaudeTranscript(projects, { sessionId: 'sess-racing' });
  const gate = gatedFs();
  const adapter = build({ fsPromises: gate.fsPromises });

  const started = adapter.start();
  const stopped = adapter.stop();
  gate.release();
  await Promise.allSettled([started, stopped]);

  assert.equal(adapter.trackedCount, 0, 'an in-flight sweep must not repopulate a stopped source');
  assert.equal(adapter.activeCount, 0);
  assert.equal(adapter.watchCount, 0);
  assert.equal(adapter.cachedDirCount, 0);
}));

test('nothing to watch is not evidence about watching, so the support check waits for a real root', withHomes(async ({ tmpDir, warnings, build }) => {
  const claudeHome = path.join(tmpDir, 'later-claude');
  const adapter = build({
    env: { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: path.join(tmpDir, 'none'), GROK_HOME: path.join(tmpDir, 'none') },
    watchFn: () => { throw new Error('watcher unavailable'); },
  });
  await adapter.start();
  assert.equal(adapter.isDisabled, false, 'no roots yet means no verdict on watching');
  assert.deepEqual(warnings, []);

  // The operator installs Claude Code and a projects root appears after boot.
  fs.mkdirSync(path.join(claudeHome, 'projects'), { recursive: true });
  await adapter.discover();
  assert.equal(adapter.isDisabled, true, 'the check must still run once there is something to watch');
  assert.equal(warnings.length, 1);
}));

test('a watcher that refuses every directory disables the source with one warning', withHomes(async ({ projects, warnings, build }) => {
  seedClaudeTranscript(projects, { sessionId: 'sess-watchless' });
  const adapter = build({ watchFn: () => { throw new Error('watcher unavailable'); } });
  await adapter.start();

  assert.equal(adapter.isDisabled, true);
  assert.equal(warnings.length, 1, 'one warning, not a retry loop');
  assert.ok(warnings[0].includes('agent-log source disabled'));

  // And it stays quiet rather than re-warning on every later wakeup.
  await adapter.poll();
  await adapter.discover();
  assert.equal(warnings.length, 1);
}));

test('stop closes every watcher and forgets every tail', withHomes(async ({ projects, build }) => {
  seedClaudeTranscript(projects, { sessionId: 'sess-stop' });
  const adapter = build();
  await adapter.start();
  assert.ok(adapter.watchCount > 0);
  assert.equal(adapter.trackedCount, 1);

  adapter.stop();
  assert.equal(adapter.watchCount, 0);
  assert.equal(adapter.trackedCount, 0);
  assert.equal(adapter.activeCount, 0);
}));

test('a missing vendor home is silently absent rather than an error', withHomes(async ({ tmpDir, build, warnings }) => {
  const adapter = build({ env: { CLAUDE_CONFIG_DIR: path.join(tmpDir, 'nope'), CODEX_HOME: path.join(tmpDir, 'nope'), GROK_HOME: path.join(tmpDir, 'nope') } });
  await adapter.start();
  assert.equal(adapter.isDisabled, false);
  assert.equal(adapter.trackedCount, 0);
  assert.deepEqual(warnings, []);
}));

// --- Through the lane ------------------------------------------------------

function laneWith(homes, rawConfig, overrides = {}, consumers = []) {
  const broadcasts = [];
  const lane = createIngestLane({
    config: resolveIngestConfig(rawConfig),
    broadcast: (message) => broadcasts.push(message),
    logger: { warn: () => {} },
    agentLogConsumers: consumers,
    ...inertTimers(),
    agentLogOptions: { env: homes.env, ...overrides },
  });
  return { lane, broadcasts };
}

test('an agent turn reaches the rings, the snapshot and the dispatch digest', withHomes(async (homes) => {
  const filePath = seedClaudeTranscript(homes.projects, { sessionId: 'sess-lane' });
  const { lane } = laneWith(homes, { enabled: true, sources: { agentLogs: { enabled: true } } });
  try {
    assert.equal(lane.agentLogsEnabled, true);
    await lane.agentLogs.start();
    append(filePath, claudeAssistant({ text: 'Landed M7 and the suite is green.', sessionId: 'sess-lane' }));
    await lane.agentLogs.poll();

    const [event] = lane.recentEvents();
    assert.equal(event.source, 'agentLogs');
    assert.equal(event.kind, 'agent-turn');
    assert.equal(event.summary, 'claude: Landed M7 and the suite is green.');
    assert.ok(lane.buildDigest({}).includes('agent'));
    assert.ok(JSON.stringify(lane.snapshotMessage()).includes('Landed M7'));
  } finally {
    lane.stop();
  }
}));

test('a secret in an agent transcript is scrubbed by the publish-time pass, with no second scrub here', withHomes(async (homes) => {
  const filePath = seedClaudeTranscript(homes.projects, { sessionId: 'sess-secret' });
  const { lane } = laneWith(homes, { enabled: true, sources: { agentLogs: { enabled: true } } });
  try {
    await lane.agentLogs.start();
    append(filePath, claudeAssistant({
      text: 'Exporting api_key=sk-live-DEADBEEFCAFEBABE now.',
      sessionId: 'sess-secret',
    }));
    await lane.agentLogs.poll();
    const [event] = lane.recentEvents();
    assert.ok(!event.summary.includes('sk-live-DEADBEEFCAFEBABE'));
    assert.ok(event.summary.includes('[scrubbed]'));
    assert.ok(!JSON.stringify(lane.snapshotMessage()).includes('sk-live-DEADBEEFCAFEBABE'));
  } finally {
    lane.stop();
  }
}));

/*
 * The scrub-ordering regression, pinned at ring level against the real path and in the shape the shell
 * source's own fix pinned. This source must hand its text on RAW so normalizeEvent can scrub before it
 * folds and slices: when the mapper sliced first (240 chars of turn text, 120 of tool target), a quoted
 * secret straddling the cut lost its closing quote, the scrub's quoted alternative stopped matching, and
 * its bare-token alternative took only the first WORD of the value, publishing the rest as ordinary text.
 * A tool target carries a `command`, so `Bash export TOKEN="..."` is the exact live shape.
 */
test('a secret past a long prefix in a tool command is scrubbed whole, never down to its first word', withHomes(async (homes) => {
  const filePath = seedClaudeTranscript(homes.projects, { sessionId: 'sess-target' });
  const { lane } = laneWith(homes, { enabled: true, sources: { agentLogs: { enabled: true } } });
  try {
    await lane.agentLogs.start();
    append(filePath, claudeAssistant({
      text: 'Exporting it now.',
      sessionId: 'sess-target',
      tools: [{
        name: 'Bash',
        input: { command: `echo ${'a'.repeat(90)} --password "hunter two three four five six"` },
      }],
    }));
    await lane.agentLogs.poll();

    const tool = lane.recentEvents().find((event) => event.kind === 'agent-tool');
    assert.ok(tool.summary.startsWith('claude: Bash '), `the M7 vendor prefix is gone: ${tool.summary}`);
    assert.ok(tool.summary.includes('--password [scrubbed]'), tool.summary);
    for (const word of ['hunter', 'two three four five', 'six']) {
      assert.ok(!tool.summary.includes(word), `leaked ${word}: ${tool.summary}`);
    }
  } finally {
    lane.stop();
  }
}));

test('a secret past a long prefix in a turn summary is scrubbed whole, and the ring is the only slice', withHomes(async (homes) => {
  const filePath = seedClaudeTranscript(homes.projects, { sessionId: 'sess-turn-secret' });
  const { lane } = laneWith(homes, { enabled: true, sources: { agentLogs: { enabled: true } } });
  try {
    await lane.agentLogs.start();
    append(filePath, claudeAssistant({
      text: `I ran ${'w'.repeat(200)} with --password "hunter two three four five six"`,
      sessionId: 'sess-turn-secret',
    }));
    append(filePath, claudeAssistant({ text: `a very long turn ${'z'.repeat(900)}`, sessionId: 'sess-turn-secret' }));
    await lane.agentLogs.poll();

    const events = lane.recentEvents();
    const secret = events.find((event) => event.summary.includes('--password'));
    assert.ok(secret.summary.startsWith('claude: I ran '), secret.summary);
    assert.ok(secret.summary.endsWith('--password [scrubbed]'), secret.summary);
    for (const word of ['hunter', 'two three four five', 'six']) {
      assert.ok(!secret.summary.includes(word), `leaked ${word}: ${secret.summary}`);
    }
    // The vendor prefix is composed before publish, so the ring's 400 covers the whole composed line.
    const long = events.find((event) => event.summary.includes('a very long turn'));
    assert.equal(long.summary.length, 400, 'the ring bound is the one slice in the pipeline');
    assert.ok(long.summary.startsWith('claude: '), long.summary);
  } finally {
    lane.stop();
  }
}));

test('the agentLogs source off constructs no adapter at all', withHomes(async (homes) => {
  const { lane } = laneWith(homes, { enabled: true, sources: { terminal: { enabled: true } } });
  try {
    assert.equal(lane.agentLogsEnabled, false);
    assert.equal(lane.agentLogs, null);
    assert.deepEqual(lane.sources, ['terminal']);
  } finally {
    lane.stop();
  }
}));

test('lane stop tears the agent-log source down with it', withHomes(async (homes) => {
  seedClaudeTranscript(homes.projects, { sessionId: 'sess-lane-stop' });
  const { lane } = laneWith(homes, { enabled: true, sources: { agentLogs: { enabled: true } } });
  await lane.agentLogs.start();
  assert.ok(lane.agentLogs.watchCount > 0);
  lane.stop();
  assert.equal(lane.agentLogs.watchCount, 0);
  assert.equal(lane.agentLogs.trackedCount, 0);
}));

// --- The M14 publish fan-out ----------------------------------------------

// The negative pin: with ingest on and memory off, prompt text reaches neither the rings nor the control WS.
test('with nothing asking for them, user prompts reach neither the rings nor a broadcast', withHomes(async (homes) => {
  const filePath = seedClaudeTranscript(homes.projects, { sessionId: 'sess-prompt' });
  const { lane, broadcasts } = laneWith(homes, { enabled: true, sources: { agentLogs: { enabled: true } } });
  try {
    await lane.agentLogs.start();
    append(filePath, claudeUser({ text: 'the staging password is hunter2', sessionId: 'sess-prompt' }));
    append(filePath, claudeAssistant({ text: 'Understood.', sessionId: 'sess-prompt' }));
    await lane.agentLogs.poll();
    lane.flushBatch();

    assert.deepEqual(lane.recentEvents().map((event) => event.kind), ['agent-turn']);
    const wire = JSON.stringify(broadcasts);
    assert.equal(wire.includes('hunter2'), false, 'operator prompt text must never reach the wire');
    assert.equal(wire.includes('agent-prompt'), false);
  } finally {
    lane.stop();
  }
}));

test('adding a consumer that wants prompts leaves the ring and the broadcast byte-identical', withHomes(async (homes) => {
  const filePath = seedClaudeTranscript(homes.projects, { sessionId: 'sess-both' });
  const consumed = [];
  const plain = laneWith(homes, { enabled: true, sources: { agentLogs: { enabled: true } } });
  const withConsumer = laneWith(
    homes,
    { enabled: true, sources: { agentLogs: { enabled: true } } },
    {},
    [{ name: 'memory', userPrompts: true, publish: (event) => consumed.push(event) }],
  );
  try {
    await plain.lane.agentLogs.start();
    await withConsumer.lane.agentLogs.start();
    const stamp = '2026-08-20T10:00:00.000Z';
    append(filePath, claudeUser({ text: 'ship it', sessionId: 'sess-both', ts: stamp }));
    append(filePath, claudeAssistant({ text: 'Shipped.', sessionId: 'sess-both', ts: stamp }));
    await plain.lane.agentLogs.poll();
    await withConsumer.lane.agentLogs.poll();
    plain.lane.flushBatch();
    withConsumer.lane.flushBatch();

    assert.deepEqual(withConsumer.lane.recentEvents(), plain.lane.recentEvents());
    assert.deepEqual(
      withConsumer.broadcasts.map((message) => message.events),
      plain.broadcasts.map((message) => message.events),
    );
    assert.deepEqual(consumed.map((event) => event.kind), ['agent-prompt', 'agent-turn']);
  } finally {
    plain.lane.stop();
    withConsumer.lane.stop();
  }
}));

test('the feedback-loop exclusion covers every target, not just the ring', withHomes(async ({ projects, env }) => {
  const filePath = seedClaudeTranscript(projects, { sessionId: 'sess-visions' });
  const ringEvents = [];
  const consumed = [];
  const adapter = createAgentLogIngest({
    publish: (event) => ringEvents.push(event),
    consumers: [{ name: 'memory', userPrompts: true, publish: (event) => consumed.push(event) }],
    laneMap: () => new Map([['sess-visions', 'visions']]),
    env,
    ...inertTimers(),
  });
  try {
    await adapter.start();
    append(filePath, claudeUser({ text: 'a dispatch prompt', sessionId: 'sess-visions' }));
    append(filePath, claudeAssistant({ text: 'a dispatch answer', sessionId: 'sess-visions' }));
    await adapter.poll();
    assert.deepEqual(ringEvents, []);
    assert.deepEqual(consumed, [], 'the lane must never remember what the lane itself said');
  } finally {
    adapter.stop();
  }
}));

test('a throwing target costs one warning, never the drain or the target beside it', withHomes(async ({ projects, env, warnings }) => {
  const filePath = seedClaudeTranscript(projects, { sessionId: 'sess-throw' });
  const ringEvents = [];
  const adapter = createAgentLogIngest({
    publish: (event) => ringEvents.push(event),
    consumers: [{ name: 'memory', userPrompts: true, publish: () => { throw new Error('store is down'); } }],
    env,
    logger: { warn: (message) => warnings.push(message) },
    ...inertTimers(),
  });
  try {
    await adapter.start();
    append(filePath, claudeAssistant({ text: 'still tailing', sessionId: 'sess-throw' }));
    await adapter.poll();
    assert.equal(adapter.isDisabled, false);
    assert.equal(ringEvents.length, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /memory target failed/);
  } finally {
    adapter.stop();
  }
}));
