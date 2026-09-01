'use strict';

/*
 * The memory ingest consumer (docs/plan-visions-3.md, M14) against real temp transcripts: the live tap on
 * the agent-log source, its own durable offsets, and the budgeted cold-start backfill.
 *
 * The resumability test uses the REAL store rather than a fake one, because the property it pins is a
 * store property: an observed record derives its id from the moment plus the text, so a pass that is cut
 * short by the byte budget and run again writes the rest instead of writing everything twice.
 *
 * SAFETY: every root is a throwaway temp directory injected through CLAUDE_CONFIG_DIR, CODEX_HOME and
 * GROK_HOME, and the store writes into a temp directory of its own, so nothing here reads or writes the
 * operator's real transcripts or memory.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAgentLogIngest } = require('../server/ingest-agent-logs.ts');
const { createMemoryIngest } = require('../server/memory-ingest-wiring.ts');
const { createMemoryStore } = require('../server/memory-store.ts');
const { hashMemoryLine, resolveMemoryConfig } = require('../server/core/memory-core.ts');

function makeHomes() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-memingest-'));
  const claudeHome = path.join(tmpDir, 'claude');
  const projects = path.join(claudeHome, 'projects');
  fs.mkdirSync(projects, { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'codex', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'grok', 'sessions'), { recursive: true });
  return {
    tmpDir,
    projects,
    memoryDir: path.join(tmpDir, 'memory'),
    env: {
      CLAUDE_CONFIG_DIR: claudeHome,
      CODEX_HOME: path.join(tmpDir, 'codex'),
      GROK_HOME: path.join(tmpDir, 'grok'),
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

// Accepts everything, remembers what it was handed, and answers the seams the consumer reads.
function fakeStore(dir) {
  const appended = [];
  const delivered = new Set();
  const tails = new Map();
  return {
    appended,
    delivered,
    dir,
    dbPath: path.join(dir, 'glissa.db'),
    tails,
    refuseTailWrites: false,
    append: async (input) => {
      appended.push(input);
      return { id: `m-${appended.length}` };
    },
    appendMany: async function appendMany(inputs) {
      if (this.refuseAppends) return { records: inputs.map(() => null), refused: true };
      return {
        records: inputs.map((input) => {
          appended.push(input);
          return { id: `m-${appended.length}` };
        }),
        refused: false,
      };
    },
    refuseAppends: false,
    deliveredHashes: () => delivered,
    tailState: () => ({ files: Object.fromEntries(tails) }),
    saveTailOffset: function saveTailOffset(entry) {
      if (this.refuseTailWrites) return false;
      const { path: filePath, ...rest } = entry;
      tails.set(filePath, rest);
      return true;
    },
    forgetTails: (paths) => { for (const filePath of paths) tails.delete(filePath); },
  };
}

function claudeAssistant({ text, sessionId = 'sess-1', cwd = 'C:\\repo', ts = null }) {
  return `${JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    cwd,
    sessionId,
    timestamp: ts || new Date().toISOString(),
  })}\n`;
}

function claudeUser({ text, sessionId = 'sess-1', cwd = 'C:\\repo' }) {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    cwd,
    sessionId,
    timestamp: new Date().toISOString(),
  })}\n`;
}

function seedTranscript(projects, { sessionId = 'sess-1', lines = [] } = {}) {
  const dir = path.join(projects, 'C--repo');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, lines.join(''), 'utf8');
  return filePath;
}

function withHomes(fn) {
  return async () => {
    const homes = makeHomes();
    const cleanups = [];
    try {
      await fn({ ...homes, cleanups });
    } finally {
      for (const cleanup of cleanups.reverse()) await cleanup();
      fs.rmSync(homes.tmpDir, { recursive: true, force: true });
    }
  };
}

// --- The live tap ---------------------------------------------------------

test('an assistant turn tapped off the source reaches the store as a reported knowledge record', withHomes(async ({ projects, memoryDir, env, cleanups }) => {
  const store = fakeStore(memoryDir);
  const ingest = createMemoryIngest({ store, env });
  cleanups.push(() => ingest.stop());
  const source = createAgentLogIngest({ consumers: [ingest.consumer], env, ...inertTimers() });
  cleanups.push(() => source.stop());

  const filePath = seedTranscript(projects, { lines: [] });
  await source.start();
  fs.appendFileSync(filePath, claudeAssistant({ text: 'Rewired the spawn gate.' }), 'utf8');
  await source.poll();
  await ingest.whenIdle();

  assert.equal(store.appended.length, 1);
  assert.equal(store.appended[0].kind, 'knowledge');
  assert.equal(store.appended[0].source.kind, 'reported');
  assert.equal(store.appended[0].text, 'claude: Rewired the spawn gate.');
}));

test('the consumer sees user prompts, which the ring target never does', withHomes(async ({ projects, memoryDir, env, cleanups }) => {
  const store = fakeStore(memoryDir);
  const ingest = createMemoryIngest({ store, env });
  cleanups.push(() => ingest.stop());
  const ringEvents = [];
  const source = createAgentLogIngest({
    publish: (event) => ringEvents.push(event),
    consumers: [ingest.consumer],
    env,
    ...inertTimers(),
  });
  cleanups.push(() => source.stop());

  const filePath = seedTranscript(projects, { lines: [] });
  await source.start();
  fs.appendFileSync(filePath, claudeUser({ text: 'ship M14 today' }), 'utf8');
  fs.appendFileSync(filePath, claudeAssistant({ text: 'On it.' }), 'utf8');
  await source.poll();
  await ingest.whenIdle();

  assert.deepEqual(ringEvents.map((event) => event.kind), ['agent-turn']);
  assert.deepEqual(store.appended.map((input) => input.kind), ['prompt', 'knowledge']);
  assert.equal(store.appended[0].fromUserPrompt, true);
}));

test('a line the store already delivered is not remembered again', withHomes(async ({ projects, memoryDir, env, cleanups }) => {
  const store = fakeStore(memoryDir);
  store.delivered.add(hashMemoryLine('claude: quoting its own memory'));
  const ingest = createMemoryIngest({ store, env });
  cleanups.push(() => ingest.stop());
  const source = createAgentLogIngest({ consumers: [ingest.consumer], env, ...inertTimers() });
  cleanups.push(() => source.stop());

  const filePath = seedTranscript(projects, { lines: [] });
  await source.start();
  fs.appendFileSync(filePath, claudeAssistant({ text: 'quoting its own memory' }), 'utf8');
  await source.poll();
  await ingest.whenIdle();

  assert.deepEqual(store.appended, []);
}));

test('a store that rejects a write costs a count, never the drain', withHomes(async ({ projects, memoryDir, env, cleanups }) => {
  const store = fakeStore(memoryDir);
  store.appendMany = async () => { throw new Error('canon unwritable'); };
  const warnings = [];
  const ingest = createMemoryIngest({ store, env, logger: { log: () => {}, warn: (line) => warnings.push(line) } });
  cleanups.push(() => ingest.stop());
  const source = createAgentLogIngest({ consumers: [ingest.consumer], env, ...inertTimers() });
  cleanups.push(() => source.stop());

  const filePath = seedTranscript(projects, { lines: [] });
  await source.start();
  fs.appendFileSync(filePath, claudeAssistant({ text: 'still tailing' }), 'utf8');
  await source.poll();
  await ingest.whenIdle();

  assert.equal(source.isDisabled, false);
  assert.equal(ingest.stats().rejected, 1);
  assert.equal(warnings.join('\n').includes('still tailing'), false, 'remembered text never reaches a log line');
}));

// M12b: the offsets are rows in the same database the records land in, so a crash cannot leave one
// ahead of the other.
test('the tapped offset lands in the store beside the canon', withHomes(async ({ projects, memoryDir, env, cleanups }) => {
  const store = realStore(memoryDir);
  cleanups.push(() => store.stop());
  const ingest = createMemoryIngest({ store, env });
  cleanups.push(() => ingest.stop());
  const source = createAgentLogIngest({ consumers: [ingest.consumer], env, ...inertTimers() });
  cleanups.push(() => source.stop());

  const filePath = seedTranscript(projects, { lines: [] });
  await source.start();
  fs.appendFileSync(filePath, claudeAssistant({ text: 'one turn' }), 'utf8');
  await source.poll();
  await ingest.whenIdle();

  assert.equal(store.tailState().files[filePath].offset, fs.statSync(filePath).size);
  assert.equal(fs.existsSync(path.join(memoryDir, 'tail-state.json')), false, 'no file-era state file is written');
}));

// --- Backfill -------------------------------------------------------------

function realStore(memoryDir, extra = {}) {
  return createMemoryStore({
    dir: memoryDir,
    dbPath: path.join(memoryDir, 'glissa.db'),
    config: { ...resolveMemoryConfig(null), enabled: true },
    logger: { log: () => {}, warn: () => {} },
    ...extra,
  });
}

test('the backfill reads a transcript written while nothing was tailing', withHomes(async ({ projects, memoryDir, env, cleanups }) => {
  seedTranscript(projects, {
    lines: [
      claudeAssistant({ text: 'first turn', ts: '2026-08-20T10:00:00.000Z' }),
      claudeAssistant({ text: 'second turn', ts: '2026-08-20T10:01:00.000Z' }),
    ],
  });
  const store = realStore(memoryDir);
  cleanups.push(() => store.stop());
  const ingest = createMemoryIngest({ store, env });
  cleanups.push(() => ingest.stop());

  const result = await ingest.backfill();
  assert.equal(result.ok, true);
  assert.equal(result.partial, false);
  assert.deepEqual(store.records().map((record) => record.text), ['claude: first turn', 'claude: second turn']);
}));

test('the ingest write path tags a worktree transcript with its configured project', withHomes(async ({ projects, memoryDir, env, cleanups }) => {
  const projectPath = '/home/carbon/projects/glissa';
  const worktreePath = '/home/carbon/projects/.glissa-worktrees/glissa-abc123';
  seedTranscript(projects, {
    lines: [claudeAssistant({ text: 'worktree fact', cwd: worktreePath, ts: '2026-08-20T10:00:00.000Z' })],
  });
  const store = realStore(memoryDir, { knownProjects: [{ path: projectPath }] });
  cleanups.push(() => store.stop());
  const ingest = createMemoryIngest({ store, env });
  cleanups.push(() => ingest.stop());

  await ingest.backfill();
  assert.equal(store.records().length, 1);
  assert.equal(store.records()[0].project, projectPath);
}));

test('a project added after ingest wiring tags the next worktree event', withHomes(async ({ memoryDir, env, cleanups }) => {
  const configuredProjects = [];
  const projectPath = '/home/carbon/projects/glissa';
  const worktreePath = '/home/carbon/projects/.glissa-worktrees/glissa-abc123';
  const knownProjects = () => configuredProjects;
  const store = realStore(memoryDir, { knownProjects });
  cleanups.push(() => store.stop());
  const ingest = createMemoryIngest({ store, env, knownProjects });
  cleanups.push(() => ingest.stop());

  configuredProjects.push({ path: projectPath });
  ingest.consumer.publish({
    source: 'agentLogs',
    kind: 'agent-turn',
    ts: Date.UTC(2026, 7, 20, 10, 0, 0),
    scope: { root: worktreePath, sessionId: 'sess-1' },
    summary: 'claude: a new project configuration is live',
    detail: { vendor: 'claude' },
  });
  await ingest.whenIdle();

  assert.equal(store.records()[0].project, projectPath);
}));

test('a backfill cut short by its byte budget resumes without writing anything twice', withHomes(async ({ projects, memoryDir, env, cleanups }) => {
  const lines = [];
  for (let index = 0; index < 6; index += 1) {
    lines.push(claudeAssistant({ text: `turn number ${index}`, ts: `2026-08-20T10:0${index}:00.000Z` }));
  }
  seedTranscript(projects, { lines });
  const store = realStore(memoryDir);
  cleanups.push(() => store.stop());

  const first = createMemoryIngest({ store, env, backfillChunkBytes: 512 });
  const firstResult = await first.backfill({ budgetBytes: 512 });
  await first.stop();
  assert.equal(firstResult.partial, true);
  const afterFirst = store.records().length;
  assert.ok(afterFirst > 0 && afterFirst < 6, `a partial pass wrote ${afterFirst} of 6`);

  // A second shell, so the offsets genuinely come off disk rather than out of the first one's memory.
  const second = createMemoryIngest({ store, env });
  cleanups.push(() => second.stop());
  await second.backfill();
  const texts = store.records().map((record) => record.text);
  assert.equal(texts.length, 6);
  assert.equal(new Set(texts).size, 6, 'no line was remembered twice');
}));

test('re-running a completed backfill writes nothing new', withHomes(async ({ projects, memoryDir, env, cleanups }) => {
  seedTranscript(projects, { lines: [claudeAssistant({ text: 'only turn', ts: '2026-08-20T10:00:00.000Z' })] });
  const store = realStore(memoryDir);
  cleanups.push(() => store.stop());
  const ingest = createMemoryIngest({ store, env });
  cleanups.push(() => ingest.stop());

  await ingest.backfill();
  await ingest.backfill();
  assert.equal(store.records().length, 1);
}));

/*
 * M12b: the pre-database refusal is gone. Two shells over one store read the same durable offsets and
 * write disjoint rows, so a CLI backfill beside a live server's own pass now just works.
 */
test('a second backfill beside a live one runs instead of refusing, and remembers nothing twice', withHomes(async ({ projects, memoryDir, env, cleanups }) => {
  seedTranscript(projects, {
    lines: [
      claudeAssistant({ text: 'first turn', ts: '2026-08-20T10:00:00.000Z' }),
      claudeAssistant({ text: 'second turn', ts: '2026-08-20T10:01:00.000Z' }),
    ],
  });
  const store = realStore(memoryDir);
  cleanups.push(() => store.stop());
  const live = createMemoryIngest({ store, env });
  cleanups.push(() => live.stop());
  const cli = createMemoryIngest({ store, env });
  cleanups.push(() => cli.stop());

  const [first, second] = await Promise.all([live.backfill(), cli.backfill()]);
  assert.deepEqual([first.ok, second.ok], [true, true]);
  assert.deepEqual([first.reason, second.reason], [null, null]);
  const texts = store.records().map((record) => record.text);
  assert.equal(new Set(texts).size, texts.length, 'the id derivation is what makes a double pass idempotent');
  assert.deepEqual(texts.sort(), ['claude: first turn', 'claude: second turn']);
}));

// --- The tail-state write race --------------------------------------------

/*
 * Security review, 2026-08-23 (MEDIUM): a SQLITE_BUSY returned all-nulls, which reads exactly like the
 * write gates refusing every record, so the offsets advanced past a range nothing remembered and no later
 * pass ever re-read it. A substrate refusal now freezes that transcript's offsets for the process.
 */
test('a batch the substrate refused freezes that transcript offset instead of stepping over it', withHomes(async ({ projects, memoryDir, env, cleanups }) => {
  const store = fakeStore(memoryDir);
  fs.mkdirSync(memoryDir, { recursive: true });
  store.refuseAppends = true;
  const warnings = [];
  const ingest = createMemoryIngest({ store, env, logger: { log: () => {}, warn: (line) => warnings.push(line) } });
  cleanups.push(() => ingest.stop());
  const source = createAgentLogIngest({ consumers: [ingest.consumer], env, ...inertTimers() });
  cleanups.push(() => source.stop());

  const filePath = seedTranscript(projects, { lines: [] });
  await source.start();
  fs.appendFileSync(filePath, claudeAssistant({ text: 'a refused turn' }), 'utf8');
  await source.poll();
  await ingest.whenIdle();

  assert.equal(store.appended.length, 0, 'nothing was remembered');
  assert.equal(store.tails.size, 0, 'so no offset may claim that range was read');
  assert.equal(ingest.stats().refused, 1);
  assert.equal(warnings.some((line) => line.includes('a refused turn')), false, 'the text never reaches a log line');

  // The database recovers, but this transcript's offsets stay frozen: a later one would step over the hole.
  store.refuseAppends = false;
  fs.appendFileSync(filePath, claudeAssistant({ text: 'a later turn that lands' }), 'utf8');
  await source.poll();
  await ingest.whenIdle();
  assert.equal(store.appended.length, 1, 'the later record still lands');
  assert.equal(store.tails.size, 0, 'and the durable offset still points before the lost range');
}));

// A refused offset write costs a re-read of that range, never the range itself.
test('an offset write the store refuses is skipped, and the record still lands', withHomes(async ({ projects, memoryDir, env, cleanups }) => {
  const store = fakeStore(memoryDir);
  fs.mkdirSync(memoryDir, { recursive: true });
  store.refuseTailWrites = true;
  const ingest = createMemoryIngest({ store, env });
  cleanups.push(() => ingest.stop());
  const source = createAgentLogIngest({ consumers: [ingest.consumer], env, ...inertTimers() });
  cleanups.push(() => source.stop());

  const filePath = seedTranscript(projects, { lines: [] });
  await source.start();
  fs.appendFileSync(filePath, claudeAssistant({ text: 'one turn' }), 'utf8');
  await source.poll();
  await ingest.whenIdle();

  assert.equal(store.appended.length, 1, 'the record still landed');
  assert.ok(ingest.stats().offsetsSkipped > 0);
  assert.equal(store.tails.size, 0);
}));

// --- Backfill bounds and the lane floor -----------------------------------

test('the file cap is enforced inside a directory, not only between directories', withHomes(async ({ projects, memoryDir, env, cleanups }) => {
  const dir = path.join(projects, 'C--repo');
  fs.mkdirSync(dir, { recursive: true });
  for (let index = 0; index < 12; index += 1) {
    fs.writeFileSync(
      path.join(dir, `sess-${index}.jsonl`),
      claudeAssistant({ text: `turn ${index}`, sessionId: `sess-${index}`, ts: '2026-08-20T10:00:00.000Z' }),
      'utf8',
    );
  }
  const store = realStore(memoryDir);
  cleanups.push(() => store.stop());
  const ingest = createMemoryIngest({ store, env, maxBackfillFiles: 3 });
  cleanups.push(() => ingest.stop());

  const result = await ingest.backfill();
  assert.equal(result.files, 3, 'one directory of twelve cannot walk past the cap');
}));

test('a transcript older than the lane ledger is skipped, since nothing can vouch for its lane', withHomes(async ({ projects, memoryDir, env, cleanups }) => {
  const filePath = seedTranscript(projects, {
    sessionId: 'sess-ancient',
    lines: [claudeAssistant({ text: 'a pr-review turn from before the ledger', ts: '2026-08-20T10:00:00.000Z' })],
  });
  const longAgo = new Date(Date.now() - 90 * 86400000);
  fs.utimesSync(filePath, longAgo, longAgo);
  const store = realStore(memoryDir);
  cleanups.push(() => store.stop());
  const ingest = createMemoryIngest({ store, env, laneFloorMs: () => Date.now() - 86400000 });
  cleanups.push(() => ingest.stop());

  await ingest.backfill();
  assert.deepEqual(store.records(), []);
  assert.equal(ingest.stats().laneSkipped, 1);
}));

test('with no ledger to speak of, the floor skips nothing', withHomes(async ({ projects, memoryDir, env, cleanups }) => {
  const filePath = seedTranscript(projects, {
    sessionId: 'sess-old',
    lines: [claudeAssistant({ text: 'an ordinary old turn', ts: '2026-08-20T10:00:00.000Z' })],
  });
  const longAgo = new Date(Date.now() - 90 * 86400000);
  fs.utimesSync(filePath, longAgo, longAgo);
  const store = realStore(memoryDir);
  cleanups.push(() => store.stop());
  const ingest = createMemoryIngest({ store, env, laneFloorMs: () => null });
  cleanups.push(() => ingest.stop());

  await ingest.backfill();
  assert.equal(store.records().length, 1);
  assert.equal(ingest.stats().laneSkipped, 0);
}));

test('a lane worktree caught by shape is excluded from the backfill too', withHomes(async ({ projects, memoryDir, env, cleanups }) => {
  const dir = path.join(projects, '-tmp-glissa-wt-pr-review-ab12cd');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'sess-pr.jsonl'),
    claudeAssistant({
      text: 'a pr-review verdict', sessionId: 'sess-pr', cwd: '/tmp/glissa-wt-pr-review-ab12cd', ts: '2026-08-20T10:00:00.000Z',
    }),
    'utf8',
  );
  const store = realStore(memoryDir);
  cleanups.push(() => store.stop());
  const ingest = createMemoryIngest({ store, env });
  cleanups.push(() => ingest.stop());

  await ingest.backfill();
  assert.deepEqual(store.records(), [], 'the lane must never remember what the lane itself said');
}));

// --- The pre-scrub cut ----------------------------------------------------

/*
 * The 4000-char pre-cut used to run AHEAD of every scrub, and on a single unbroken line it cut mid-value:
 * the quoted alternative then went unmatched and the bare-token one took only the first WORD, so the rest
 * of the secret published as innocent words. The whole line now reaches the scrub, which cuts after.
 */
test('a secret past the old pre-cut is scrubbed rather than split mid-value', withHomes(async ({ projects, memoryDir, env, cleanups }) => {
  const store = createMemoryStore({
    dir: memoryDir,
    dbPath: path.join(memoryDir, 'glissa.db'),
    config: { ...resolveMemoryConfig(null), enabled: true, maxRecordChars: 12000 },
    logger: { log: () => {}, warn: () => {} },
  });
  cleanups.push(() => store.stop());
  const ingest = createMemoryIngest({ store, env });
  cleanups.push(() => ingest.stop());
  const source = createAgentLogIngest({ consumers: [ingest.consumer], env, ...inertTimers() });
  cleanups.push(() => source.stop());

  const filePath = seedTranscript(projects, { lines: [] });
  await source.start();
  // One unbroken line whose assignment sits past 4000 characters, which is where the old cut landed.
  const padding = 'a lot of ordinary prose. '.repeat(220);
  fs.appendFileSync(filePath, claudeAssistant({
    text: `${padding} export API_TOKEN="s3cret-value-nobody-should-remember"`,
  }), 'utf8');
  await source.poll();
  await ingest.whenIdle();

  const remembered = store.records().map((record) => record.text).join('\n');
  assert.ok(remembered.length > 4000, 'the whole line reached the record, so the cut is genuinely tested');
  assert.equal(remembered.includes('s3cret-value-nobody-should-remember'), false, remembered.slice(-160));
  assert.equal(remembered.includes('value-nobody-should-remember'), false, 'no tail of the value survives either');
  assert.ok(remembered.includes('[scrubbed]'), 'the scrub reached it rather than the cut hiding it');
}));
