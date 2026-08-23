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

const { createAgentLogIngest } = require('../server/ingest-agent-logs');
const { createMemoryIngest } = require('../server/memory-ingest-wiring');
const { createMemoryStore } = require('../server/memory-store');
const { resolveMemoryConfig } = require('../server/core/memory-core');

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

// Accepts everything, remembers what it was handed, and answers the two seams the consumer reads.
function fakeStore(dir) {
  const appended = [];
  const delivered = new Set();
  return {
    appended,
    delivered,
    dir,
    append: async (input) => {
      appended.push(input);
      return { id: `m-${appended.length}` };
    },
    deliveredHashes: () => delivered,
    withCanonLock: async (work) => ({ locked: true, result: await work() }),
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
  const { hashMemoryLine } = require('../server/core/memory-core');
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
  store.append = async () => { throw new Error('canon unwritable'); };
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
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].includes('still tailing'), false, 'remembered text never reaches a log line');
}));

test('the tapped offset lands in tail-state.json beside the canon', withHomes(async ({ projects, memoryDir, env, cleanups }) => {
  const store = fakeStore(memoryDir);
  fs.mkdirSync(memoryDir, { recursive: true });
  const ingest = createMemoryIngest({ store, env });
  cleanups.push(() => ingest.stop());
  const source = createAgentLogIngest({ consumers: [ingest.consumer], env, ...inertTimers() });
  cleanups.push(() => source.stop());

  const filePath = seedTranscript(projects, { lines: [] });
  await source.start();
  fs.appendFileSync(filePath, claudeAssistant({ text: 'one turn' }), 'utf8');
  await source.poll();
  await ingest.whenIdle();

  const written = JSON.parse(fs.readFileSync(path.join(memoryDir, 'tail-state.json'), 'utf8'));
  assert.equal(written.files[filePath].offset, fs.statSync(filePath).size);
}));

// --- Backfill -------------------------------------------------------------

function realStore(memoryDir) {
  return createMemoryStore({
    dir: memoryDir,
    config: { ...resolveMemoryConfig(null), enabled: true },
    logger: { log: () => {}, warn: () => {} },
    watchCanon: false,
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

test('a backfill refuses to run while another process holds the canon lock', withHomes(async ({ memoryDir, env, cleanups }) => {
  const store = realStore(memoryDir);
  cleanups.push(() => store.stop());
  const lockPath = path.join(memoryDir, 'canon.lock');
  fs.writeFileSync(lockPath, '', { flag: 'wx' });
  cleanups.push(async () => fs.rmSync(lockPath, { force: true }));
  const ingest = createMemoryIngest({ store, env });
  cleanups.push(() => ingest.stop());

  const result = await ingest.backfill();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'locked');
}));
