import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAgentLogIngest } from '../server/ingest-agent-logs.ts';
import { createMemoryIngest } from '../server/memory-ingest-wiring.ts';
import type { MemoryIngestStore } from '../server/memory-ingest-wiring.ts';
import { createMemoryStore } from '../server/memory-store.ts';
import type { MemoryStoreOptions } from '../server/memory-store.ts';
import { hashMemoryLine, resolveMemoryConfig } from '../server/core/memory-core.ts';
import type { MemoryRecord } from '../server/core/memory-core.ts';

type MemoryStore = NonNullable<ReturnType<typeof createMemoryStore>>;

interface Homes {
  tmpDir: string;
  projects: string;
  memoryDir: string;
  env: NodeJS.ProcessEnv;
}

interface HomesContext extends Homes {
  cleanups: (() => unknown)[];
}

interface AppendedInput {
  kind?: string;
  text?: string;
  project?: string | null;
  fromUserPrompt?: boolean;
  source?: { kind?: string; vendor?: string; sessionId?: string | null };
  [field: string]: unknown;
}

interface TailRow {
  size: number;
  mtimeMs: number;
  offset: number;
  ts: number;
}

interface FakeStore extends MemoryIngestStore {
  appended: AppendedInput[];
  delivered: Set<string>;
  tails: Map<string, TailRow>;
  refuseTailWrites: boolean;
  refuseAppends: boolean;
}

function makeHomes(): Homes {
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
  const park = (): NodeJS.Timeout => {
    const handle = setTimeout(() => {}, 2 ** 30);
    handle.unref();
    return handle;
  };
  return {
    setIntervalFn: () => park(),
    clearIntervalFn: (handle: NodeJS.Timeout) => { clearTimeout(handle); },
    setTimeoutFn: () => park(),
    clearTimeoutFn: (handle: NodeJS.Timeout) => { clearTimeout(handle); },
  };
}

function fakeRecord(id: string): MemoryRecord {
  return {
    id,
    ts: 0,
    kind: 'knowledge',
    layer: 'semantic',
    project: null,
    source: { kind: 'reported', vendor: 'claude', sessionId: null },
    text: '',
    validFrom: 0,
    validTo: null,
    supersedes: null,
    lineage: 'reported',
    locked: false,
  };
}

function asAppended(input: unknown): AppendedInput {
  if (typeof input !== 'object' || input === null) throw new Error('the consumer appends an object');
  return { ...input };
}

function fakeStore(dir: string): FakeStore {
  const appended: AppendedInput[] = [];
  const delivered = new Set<string>();
  const tails = new Map<string, TailRow>();
  const store: FakeStore = {
    appended,
    delivered,
    dbPath: path.join(dir, 'glissa.db'),
    tails,
    refuseTailWrites: false,
    refuseAppends: false,
    append: async (input: unknown) => {
      appended.push(asAppended(input));
      return fakeRecord(`m-${appended.length}`);
    },
    appendMany: async (inputs: unknown) => {
      const list = Array.isArray(inputs) ? inputs : [];
      if (store.refuseAppends) return { records: list.map(() => null), refused: true };
      return {
        records: list.map((input: unknown) => {
          appended.push(asAppended(input));
          return fakeRecord(`m-${appended.length}`);
        }),
        refused: false,
      };
    },
    deliveredHashes: () => delivered,
    tailState: () => ({ files: Object.fromEntries(tails) }),
    saveTailOffset: (entry) => {
      if (store.refuseTailWrites) return false;
      const { path: filePath, ...rest } = entry;
      tails.set(filePath, rest);
      return true;
    },
    forgetTails: (paths: string[]) => {
      for (const filePath of paths) tails.delete(filePath);
      return true;
    },
  };
  return store;
}

interface TranscriptTurn {
  text: string;
  sessionId?: string;
  cwd?: string;
  ts?: string | null;
}

function claudeAssistant({ text, sessionId = 'sess-1', cwd = 'C:\\repo', ts = null }: TranscriptTurn): string {
  return `${JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    cwd,
    sessionId,
    timestamp: ts || new Date().toISOString(),
  })}\n`;
}

function claudeUser({ text, sessionId = 'sess-1', cwd = 'C:\\repo' }: TranscriptTurn): string {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    cwd,
    sessionId,
    timestamp: new Date().toISOString(),
  })}\n`;
}

function seedTranscript(projects: string, { sessionId = 'sess-1', lines = [] }: { sessionId?: string; lines?: string[] } = {}): string {
  const dir = path.join(projects, 'C--repo');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, lines.join(''), 'utf8');
  return filePath;
}

function withHomes(fn: (context: HomesContext) => Promise<void>): () => Promise<void> {
  return async () => {
    const homes = makeHomes();
    const cleanups: (() => unknown)[] = [];
    try {
      await fn({ ...homes, cleanups });
    } finally {
      for (const cleanup of cleanups.reverse()) await cleanup();
      fs.rmSync(homes.tmpDir, { recursive: true, force: true });
    }
  };
}

function realStore(memoryDir: string, extra: Partial<MemoryStoreOptions> = {}): MemoryStore {
  const store = createMemoryStore({
    dir: memoryDir,
    dbPath: path.join(memoryDir, 'glissa.db'),
    config: { ...resolveMemoryConfig(null), enabled: true },
    logger: { log: () => {}, warn: () => {} },
    ...extra,
  });
  if (!store) throw new Error('this node build has no node:sqlite');
  return store;
}

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
  assert.equal(store.appended[0].source?.kind, 'reported');
  assert.equal(store.appended[0].text, 'claude: Rewired the spawn gate.');
}));

test('the consumer sees user prompts, which the ring target never does', withHomes(async ({ projects, memoryDir, env, cleanups }) => {
  const store = fakeStore(memoryDir);
  const ingest = createMemoryIngest({ store, env });
  cleanups.push(() => ingest.stop());
  const ringEvents: { kind?: unknown }[] = [];
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
  store.delivered.add(String(hashMemoryLine('claude: quoting its own memory')));
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
  const warnings: string[] = [];
  const ingest = createMemoryIngest({ store, env, logger: { log: () => {}, warn: (line: string) => { warnings.push(line); } } });
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
  const configuredProjects: { path: string }[] = [];
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
  }, null);
  await ingest.whenIdle();

  assert.equal(store.records()[0].project, projectPath);
}));

test('a backfill cut short by its byte budget resumes without writing anything twice', withHomes(async ({ projects, memoryDir, env, cleanups }) => {
  const lines: string[] = [];
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

test('a batch the substrate refused freezes that transcript offset instead of stepping over it', withHomes(async ({ projects, memoryDir, env, cleanups }) => {
  const store = fakeStore(memoryDir);
  fs.mkdirSync(memoryDir, { recursive: true });
  store.refuseAppends = true;
  const warnings: string[] = [];
  const ingest = createMemoryIngest({ store, env, logger: { log: () => {}, warn: (line: string) => { warnings.push(line); } } });
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

  store.refuseAppends = false;
  fs.appendFileSync(filePath, claudeAssistant({ text: 'a later turn that lands' }), 'utf8');
  await source.poll();
  await ingest.whenIdle();
  assert.equal(store.appended.length, 1, 'the later record still lands');
  assert.equal(store.tails.size, 0, 'and the durable offset still points before the lost range');
}));

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

test('a secret past the old pre-cut is scrubbed rather than split mid-value', withHomes(async ({ projects, memoryDir, env, cleanups }) => {
  const store = realStore(memoryDir, { config: { ...resolveMemoryConfig(null), enabled: true, maxRecordChars: 12000 } });
  cleanups.push(() => store.stop());
  const ingest = createMemoryIngest({ store, env });
  cleanups.push(() => ingest.stop());
  const source = createAgentLogIngest({ consumers: [ingest.consumer], env, ...inertTimers() });
  cleanups.push(() => source.stop());

  const filePath = seedTranscript(projects, { lines: [] });
  await source.start();

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
