import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemoryStore } from '../server/memory-store.ts';
import {
  BOOTSTRAP_PROMPT, MEMORY_DISTILL_DENY_TOOLS, PROMPT_FILE, WORK_DIR_PREFIX, createMemoryDistiller,
} from '../server/memory-distill.ts';
import type { MemoryDistillerOptions } from '../server/memory-distill.ts';
import { resolveDistillConfig } from '../server/core/memory-distill-core.ts';
import type { DistillConfig } from '../server/core/memory-distill-core.ts';
import { resolveMemoryConfig } from '../server/core/memory-core.ts';
import type { MemoryRecord } from '../server/core/memory-core.ts';
import { isDispatchWorkdir } from '../server/core/ingest-agent-core.ts';

type MemoryStore = NonNullable<ReturnType<typeof createMemoryStore>>;
type DistillResult = Record<string, unknown>;

interface Clock {
  at: number;
}

interface DistilledClaim {
  kind: string;
  project: string | null;
  rank: string;
  ids: string[];
  text: string;
  [field: string]: unknown;
}

interface KnowledgeInput {
  kind: string;
  layer: string;
  project: string | null;
  source: { kind: string; vendor: string; sessionId: string | null };
  text: string;
}

interface LaneOptions extends Partial<DistillConfig> {
  result?: DistillResult | null;
  onSpawn?: ((spawn: { prompt: string; cwd: string }) => Promise<void> | void) | null;
}

interface RecordedSpawn {
  prompt: string;
  argvPrompt: string;
  cwd: string;
}

const QUIET = { log() {}, warn() {} };
const START = Date.UTC(2026, 7, 23, 12, 0, 0);
const HOUR = 3600000;

const openedStores: MemoryStore[] = [];

test.afterEach(async () => {
  for (const store of openedStores.splice(0)) {
    await store.stop().catch(() => {});
  }
});

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-memory-distill-'));
}

function openStore(dir: string, clock: Clock): MemoryStore {
  const store = createMemoryStore({
    dir,
    dbPath: path.join(dir, 'glissa.db'),
    config: { ...resolveMemoryConfig(null), enabled: true },
    logger: QUIET,
    now: () => clock.at,
    projectionDebounceMs: 1,
  });
  if (!store) throw new Error('this node build has no node:sqlite');
  openedStores.push(store);
  return store;
}

function requireRecord(record: MemoryRecord | null): MemoryRecord {
  if (!record) throw new Error('the store refused the seeded record');
  return record;
}

function knowledge(text: string, project: string | null = '/repos/glissa'): KnowledgeInput {
  return {
    kind: 'knowledge',
    layer: 'episodic',
    project,
    source: { kind: 'reported', vendor: 'claude', sessionId: 's-1' },
    text,
  };
}

function makeLane(store: MemoryStore, clock: Clock, { result = null, onSpawn = null, ...config }: LaneOptions = {}): {
  distiller: ReturnType<typeof createMemoryDistiller>;
  spawns: RecordedSpawn[];
} {
  const spawns: RecordedSpawn[] = [];
  const options: MemoryDistillerOptions = {
    store,
    config: { ...resolveDistillConfig(config, { memoryEnabled: true }), ...config },
    logger: QUIET,
    now: () => clock.at,
    makeWorkDir: async () => fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-distill-work-')),
    removeWorkDir: async (dir: string) => fs.rmSync(dir, { recursive: true, force: true }),
    spawnDistill: async ({ prompt, cwd }) => {
      const promptFile = path.join(cwd, PROMPT_FILE);
      const delivered = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : '';
      spawns.push({ prompt: delivered, argvPrompt: prompt, cwd });
      if (onSpawn) await onSpawn({ prompt: delivered, cwd });
    },
    readResult: async () => result,
  };
  return { distiller: createMemoryDistiller(options), spawns };
}

function readProjectFiles(dir: string): string {
  const projectsDir = path.join(dir, 'dist', 'current', 'projects');
  if (!fs.existsSync(projectsDir)) return '';
  return fs.readdirSync(projectsDir).map((name) => fs.readFileSync(path.join(projectsDir, name), 'utf8')).join('\n');
}

function readCurrent(dir: string, relPath = 'MEMORY.md'): string | null {
  try {
    return fs.readFileSync(path.join(dir, 'dist', 'current', relPath), 'utf8');
  } catch {
    return null;
  }
}

function manifestOf(dir: string, slot = 'current'): Record<string, unknown> {
  const raw = slot === 'current'
    ? readCurrent(dir, 'manifest.json')
    : fs.readFileSync(path.join(dir, 'dist', slot, 'manifest.json'), 'utf8');
  if (raw === null) throw new Error(`no manifest in dist/${slot}`);
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('a manifest is a JSON object');
  return { ...parsed };
}

function distilledResult(claims: DistilledClaim[], verdict = 'DISTILLED'): DistillResult {
  return { verdict, summary: 'distilled the canon', ops: claims.map((claim) => ({ op: 'add', claim })) };
}

function fullResult(claims: DistilledClaim[], verdict = 'DISTILLED'): DistillResult {
  return { verdict, summary: 'compacted one project', claims };
}

async function seed(store: MemoryStore, clock: Clock, texts: string[]): Promise<MemoryRecord[]> {
  const records: MemoryRecord[] = [];
  for (const text of texts) {
    records.push(requireRecord(await store.append(knowledge(text))));
    clock.at += 1;
  }
  await store.flushProjection();
  return records;
}

test('a DISTILLED run publishes the claims and rotates the fallback build to previous', async () => {
  const dir = tempDir();
  const clock = { at: START };
  try {
    const store = openStore(dir, clock);
    const [first, second] = await seed(store, clock, ['the poller ticks every 15 minutes', 'the poller is opt in']);
    assert.equal(readProjectFiles(dir).includes('the poller ticks every 15 minutes'), true);

    clock.at += 2 * HOUR;
    const { distiller, spawns } = makeLane(store, clock, {
      result: distilledResult([{
        kind: 'knowledge',
        project: '/repos/glissa',
        rank: 'model',
        ids: [first.id, second.id],
        text: 'the opt-in poller ticks every 15 minutes',
      }]),
    });
    const report = await distiller.runOnce();
    assert.equal(report.status, 'published');
    assert.equal(report.published, true);
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].prompt.includes(first.id), true);
    assert.equal(spawns[0].argvPrompt, BOOTSTRAP_PROMPT);
    assert.equal(Buffer.byteLength(spawns[0].argvPrompt, 'utf8') < 131072, true, 'one argv string is capped at MAX_ARG_STRLEN');

    const published = readProjectFiles(dir);
    assert.equal(published.includes('the opt-in poller ticks every 15 minutes'), true);
    assert.equal(published.includes(`[${first.id} ${second.id}]`), true, 'every line names the records it came from');
    const manifest = manifestOf(dir);
    assert.equal(manifest.source, 'distill');
    assert.equal(manifest.verdict, 'DISTILLED');
    assert.equal(manifest.claimCount, 1);
    assert.equal(manifest.version, report.version);
    assert.equal(manifestOf(dir, 'previous').source, 'trivial', 'the last good build is one rotation back');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a NO_CHANGE run writes nothing at all', async () => {
  const dir = tempDir();
  const clock = { at: START };
  try {
    const store = openStore(dir, clock);
    await seed(store, clock, ['the poller ticks every 15 minutes']);
    const before = readCurrent(dir);
    const beforeVersion = manifestOf(dir).version;

    clock.at += 2 * HOUR;
    const { distiller } = makeLane(store, clock, { result: distilledResult([], 'NO_CHANGE') });
    const report = await distiller.runOnce();
    assert.equal(report.status, 'current');
    assert.equal(report.verdict, 'NO_CHANGE');
    assert.equal(readCurrent(dir), before);
    assert.equal(manifestOf(dir).version, beforeVersion);
    assert.equal(fs.existsSync(path.join(dir, 'dist', 'previous')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable or hallucinating result leaves the published build untouched', async () => {
  const dir = tempDir();
  const clock = { at: START };
  try {
    const store = openStore(dir, clock);
    await seed(store, clock, ['the poller ticks every 15 minutes']);
    const before = readCurrent(dir);

    clock.at += 2 * HOUR;
    const missing = makeLane(store, clock, { result: null });
    assert.equal((await missing.distiller.runOnce()).status, 'error');
    assert.equal(readCurrent(dir), before);

    clock.at += 2 * HOUR;
    const hallucinated = makeLane(store, clock, {
      result: distilledResult([{
        kind: 'knowledge', project: '/repos/glissa', rank: 'model', ids: ['m-deadbeefdeadbeef'], text: 'invented',
      }]),
    });
    const report = await hallucinated.distiller.runOnce();
    assert.equal(report.status, 'error');
    assert.match(String(report.reason), /unresolvable/);
    assert.equal(readCurrent(dir), before);
    assert.equal(manifestOf(dir).source, 'trivial');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a run past its timeout publishes nothing', async () => {
  const dir = tempDir();
  const clock = { at: START };
  try {
    const store = openStore(dir, clock);
    await seed(store, clock, ['the poller ticks every 15 minutes']);
    const before = readCurrent(dir);

    clock.at += 2 * HOUR;

    const raced = createMemoryDistiller({
      store,
      config: { ...resolveDistillConfig(null, { memoryEnabled: true }), timeoutSeconds: 60 },
      logger: QUIET,
      now: () => clock.at,
      makeWorkDir: async () => fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-distill-work-')),
      removeWorkDir: async (workDir) => fs.rmSync(workDir, { recursive: true, force: true }),
      spawnDistill: () => new Promise((resolve) => { setTimeout(resolve, 200); }),
      readResult: async () => distilledResult([]),
      setTimeoutFn: (fn) => setTimeout(fn, 0),
    });
    const report = await raced.runOnce();
    assert.equal(report.status, 'error');
    assert.match(String(report.reason), /timed out/);
    assert.equal(readCurrent(dir), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unmoved canon and a canon still being appended to both spawn nothing', async () => {
  const dir = tempDir();
  const clock = { at: START };
  try {
    const store = openStore(dir, clock);
    const [first] = await seed(store, clock, ['the poller ticks every 15 minutes']);
    const claims = [{
      kind: 'knowledge', project: '/repos/glissa', rank: 'model', ids: [first.id], text: 'the poller ticks every 15 minutes',
    }];
    clock.at += 2 * HOUR;
    assert.equal((await makeLane(store, clock, { result: distilledResult(claims) }).distiller.runOnce()).status, 'published');

    clock.at += 25 * HOUR;
    const unchanged = makeLane(store, clock, { result: distilledResult(claims) });
    assert.equal((await unchanged.distiller.runOnce()).status, 'unchanged');
    assert.equal(unchanged.spawns.length, 0);

    await store.append(knowledge('the poller is opt in'));
    const busy = makeLane(store, clock, { result: distilledResult(claims), quietMs: 60000 });
    assert.equal((await busy.distiller.runOnce()).status, 'busy');
    assert.equal(busy.spawns.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a distilled build is not re-run before its interval has elapsed', async () => {
  const dir = tempDir();
  const clock = { at: START };
  try {
    const store = openStore(dir, clock);
    const [first] = await seed(store, clock, ['the poller ticks every 15 minutes']);
    clock.at += 2 * HOUR;
    const claims = [{
      kind: 'knowledge', project: '/repos/glissa', rank: 'model', ids: [first.id], text: 'the poller ticks every 15 minutes',
    }];
    const lane = makeLane(store, clock, { result: distilledResult(claims) });
    assert.equal((await lane.distiller.runOnce()).status, 'published');

    await store.append(knowledge('the poller is opt in'));
    clock.at += HOUR;
    const soon = makeLane(store, clock, { result: distilledResult(claims) });
    assert.equal((await soon.distiller.runOnce()).status, 'cooling');
    assert.equal(soon.spawns.length, 0);

    clock.at += 25 * HOUR;
    const later = makeLane(store, clock, { result: distilledResult(claims) });
    assert.equal((await later.distiller.runOnce()).status, 'published');
    assert.equal(later.spawns.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a build that would re-render a locked record is held for review, never published', async () => {
  const dir = tempDir();
  const clock = { at: START };
  try {
    const store = openStore(dir, clock);
    const locked = requireRecord(await store.append({
      kind: 'preference',
      layer: 'semantic',
      project: null,
      source: { kind: 'operator', vendor: 'glissa', sessionId: null },
      text: 'never write else statements',
      locked: true,
    }));
    clock.at += 1;
    await store.flushProjection();
    const before = readCurrent(dir);

    clock.at += 2 * HOUR;
    const { distiller } = makeLane(store, clock, {
      result: distilledResult([{
        kind: 'preference', project: null, rank: 'model', ids: [locked.id], text: 'else statements are banned',
      }]),
    });
    const report = await distiller.runOnce();
    assert.equal(report.status, 'pending');
    assert.equal(report.pending, true);
    assert.equal(readCurrent(dir), before, 'the published build is byte-identical');
    assert.equal(manifestOf(dir).source, 'trivial');
    const held = fs.readFileSync(path.join(dir, 'dist-pending', 'MEMORY.md'), 'utf8');
    assert.equal(held.includes('else statements are banned'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('once a distilled build is published the fallback renderer stops overwriting it', async () => {
  const dir = tempDir();
  const clock = { at: START };
  try {
    const store = openStore(dir, clock);
    const [first] = await seed(store, clock, ['the poller ticks every 15 minutes']);
    clock.at += 2 * HOUR;
    const { distiller } = makeLane(store, clock, {
      result: distilledResult([{
        kind: 'knowledge', project: '/repos/glissa', rank: 'model', ids: [first.id], text: 'one distilled claim',
      }]),
    });
    assert.equal((await distiller.runOnce()).status, 'published');

    await store.append(knowledge('a raw fact nobody distilled yet'));
    await store.flushProjection();
    const published = readProjectFiles(dir);
    assert.equal(published.includes('one distilled claim'), true);
    assert.equal(published.includes('a raw fact nobody distilled yet'), false);
    assert.equal(manifestOf(dir).source, 'distill');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a forget forces the expunged text out of a distilled build without waiting for the next run', async () => {
  const dir = tempDir();
  const clock = { at: START };
  try {
    const store = openStore(dir, clock);
    const [doomed] = await seed(store, clock, ['the staging passphrase is in the prompt']);
    clock.at += 2 * HOUR;
    const { distiller } = makeLane(store, clock, {
      result: distilledResult([{
        kind: 'knowledge', project: '/repos/glissa', rank: 'model', ids: [doomed.id], text: 'the staging passphrase is in the prompt',
      }]),
    });
    assert.equal((await distiller.runOnce()).status, 'published');

    const result = await store.forget(doomed.id);
    assert.equal(result?.ok, true);
    assert.equal(`${readCurrent(dir)}${readProjectFiles(dir)}`.includes('passphrase'), false);
    assert.equal(manifestOf(dir).source, 'trivial', 'the fallback owns dist/ again until the next distill run');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the lane is inert without a store and without its own enabled flag', async () => {
  const none = createMemoryDistiller({ store: null, logger: QUIET });
  assert.equal(none.isEnabled(), false);
  assert.equal((await none.runOnce()).status, 'disabled');
  await none.start();
  await none.stop();
});

test('the scratch cwd carries the prefix the ingest exclusion recognizes', async () => {
  const dir = tempDir();
  const clock = { at: START };
  try {
    const store = openStore(dir, clock);
    const [first] = await seed(store, clock, ['the poller ticks every 15 minutes']);
    clock.at += 2 * HOUR;
    const lane = createMemoryDistiller({
      store,
      config: resolveDistillConfig(null, { memoryEnabled: true }),
      logger: QUIET,
      now: () => clock.at,
      spawnDistill: async () => {},
      readResult: async () => distilledResult([{
        kind: 'knowledge', project: '/repos/glissa', rank: 'model', ids: [first.id], text: 'one claim',
      }]),
    });

    const report = await lane.runOnce();
    assert.equal(report.status, 'published');
    assert.equal(WORK_DIR_PREFIX, 'glissa-memory-distill-');
    assert.equal(isDispatchWorkdir(path.join(os.tmpdir(), `${WORK_DIR_PREFIX}work-ab12`)), true);

    for (const tool of ['Read', 'Write', 'Glob', 'Grep']) {
      assert.equal(MEMORY_DISTILL_DENY_TOOLS.includes(tool), false, tool);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a poisoned manifest cannot walk the read out of the published build', async () => {
  const dir = tempDir();
  const clock = { at: START };
  const warnings: string[] = [];
  try {
    const store = createMemoryStore({
      dir,
      dbPath: path.join(dir, 'glissa.db'),
      config: { ...resolveMemoryConfig(null), enabled: true },
      logger: { log() {}, warn: (line: string) => { warnings.push(line); } },
      now: () => clock.at,
      projectionDebounceMs: 1,
    });
    if (!store) throw new Error('this node build has no node:sqlite');
    openedStores.push(store);
    await seed(store, clock, ['the poller ticks every 15 minutes']);
    const manifestPath = path.join(dir, 'dist', 'current', 'manifest.json');
    const manifest = manifestOf(dir);
    const publishedFiles = manifest.files;
    if (!Array.isArray(publishedFiles)) throw new Error('a manifest lists its files');
    const plantedFiles = [
      { relPath: '../../../../etc/passwd', sha256: 'x' },
      { relPath: 'nested/../../hmac-key', sha256: 'x' },
      { relPath: path.join(dir, 'hmac-key'), sha256: 'x' },
      ...publishedFiles,
    ];
    manifest.files = plantedFiles;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const documents = await store.readPublishedDocuments(await store.readPublishedManifest());
    assert.equal(documents.length, plantedFiles.length - 3, 'only the contained files were read');
    for (const document of documents) assert.equal(document.includes('root:'), false);
    assert.equal(warnings.filter((line) => line.includes('outside the build')).length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a run reads only the records above the cursor and moves it once the build is verified', async () => {
  const dir = tempDir();
  const clock = { at: START };
  try {
    const store = openStore(dir, clock);
    const [first] = await seed(store, clock, ['the poller ticks every 15 minutes']);
    assert.equal(store.distillCursorSeq(), 0);

    clock.at += 2 * HOUR;
    const firstRun = makeLane(store, clock, {
      result: distilledResult([{
        kind: 'knowledge', project: '/repos/glissa', rank: 'model', ids: [first.id], text: 'the poller ticks every 15 minutes',
      }]),
    });
    assert.equal((await firstRun.distiller.runOnce()).status, 'published');
    assert.equal(store.distillCursorSeq(), first.seq);
    assert.equal(firstRun.spawns[0].prompt.includes(first.id), true);

    const second = requireRecord(await store.append(knowledge('the poller is opt in')));
    clock.at += 25 * HOUR;
    const secondRun = makeLane(store, clock, {
      result: distilledResult([{
        kind: 'knowledge', project: '/repos/glissa', rank: 'model', ids: [second.id], text: 'the poller is opt in',
      }]),
    });
    const report = await secondRun.distiller.runOnce();
    assert.equal(report.status, 'published');
    assert.equal(report.delta, 1, 'only the new record was read');
    assert.equal(secondRun.spawns[0].prompt.includes(first.id), false);
    assert.equal(secondRun.spawns[0].prompt.includes(second.id), true);
    assert.equal(store.distillCursorSeq(), second.seq);

    const published = readProjectFiles(dir);
    assert.equal(published.includes('the poller ticks every 15 minutes'), true, 'the unread claim survived the merge');
    assert.equal(published.includes('the poller is opt in'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed run leaves the cursor where it was and counts against the delta window', async () => {
  const dir = tempDir();
  const clock = { at: START };
  try {
    const store = openStore(dir, clock);
    const [first] = await seed(store, clock, ['the poller ticks every 15 minutes']);
    clock.at += 2 * HOUR;
    assert.equal((await makeLane(store, clock, {
      result: distilledResult([{
        kind: 'knowledge', project: '/repos/glissa', rank: 'model', ids: [first.id], text: 'the poller ticks every 15 minutes',
      }]),
    }).distiller.runOnce()).status, 'published');
    const cursor = store.distillCursorSeq();

    await store.append(knowledge('a record the run chokes on'));
    clock.at += 25 * HOUR;
    const broken = makeLane(store, clock, { result: null });
    assert.equal((await broken.distiller.runOnce()).status, 'error');
    assert.equal(store.distillCursorSeq(), cursor, 'the delta is left to be read again');
    assert.equal(store.distillFailures(), 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a held locked diff blocks the cursor, so the same delta is re-read once the operator has ruled', async () => {
  const dir = tempDir();
  const clock = { at: START };
  try {
    const store = openStore(dir, clock);
    const locked = requireRecord(await store.append({
      kind: 'preference',
      layer: 'semantic',
      project: null,
      source: { kind: 'operator', vendor: 'glissa', sessionId: null },
      text: 'never write else statements',
      locked: true,
    }));
    clock.at += 1;
    await store.flushProjection();
    clock.at += 2 * HOUR;
    const { distiller } = makeLane(store, clock, {
      result: distilledResult([{
        kind: 'preference', project: null, rank: 'model', ids: [locked.id], text: 'else statements are banned',
      }]),
    });
    assert.equal((await distiller.runOnce()).status, 'pending');
    assert.equal(store.distillCursorSeq(), 0);
    assert.equal(store.distillFailures(), 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a NO_CHANGE verdict publishes nothing and still moves the cursor past what it read', async () => {
  const dir = tempDir();
  const clock = { at: START };
  try {
    const store = openStore(dir, clock);
    const [first] = await seed(store, clock, ['the poller ticks every 15 minutes']);
    clock.at += 2 * HOUR;
    assert.equal((await makeLane(store, clock, {
      result: distilledResult([{
        kind: 'knowledge', project: '/repos/glissa', rank: 'model', ids: [first.id], text: 'the poller ticks every 15 minutes',
      }]),
    }).distiller.runOnce()).status, 'published');
    const version = manifestOf(dir).version;

    const second = requireRecord(await store.append(knowledge('the poller is opt in')));
    clock.at += 25 * HOUR;
    const report = await makeLane(store, clock, { result: distilledResult([], 'NO_CHANGE') }).distiller.runOnce();
    assert.equal(report.status, 'current');
    assert.equal(report.verdict, 'NO_CHANGE');
    assert.equal(manifestOf(dir).version, version, 'nothing was republished');
    assert.equal(store.distillCursorSeq(), second.seq);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a superseded record loses its claim mechanically, with nothing spawned at all', async () => {
  const dir = tempDir();
  const clock = { at: START };
  try {
    const store = openStore(dir, clock);
    const [stale, kept] = await seed(store, clock, ['the poller ticks every 5 minutes', 'the poller is opt in']);
    clock.at += 2 * HOUR;
    assert.equal((await makeLane(store, clock, {
      result: distilledResult([
        {
          kind: 'knowledge', project: '/repos/glissa', rank: 'model', ids: [stale.id], text: 'the poller ticks every 5 minutes',
        },
        {
          kind: 'knowledge', project: '/repos/glissa', rank: 'model', ids: [kept.id], text: 'the poller is opt in',
        },
      ]),
    }).distiller.runOnce()).status, 'published');
    assert.equal(readProjectFiles(dir).includes('the poller ticks every 5 minutes'), true);

    await store.append({ ...knowledge('the poller ticks every 15 minutes'), supersedes: stale.id });
    clock.at += 25 * HOUR;

    assert.equal((await makeLane(store, clock, { result: distilledResult([], 'NO_CHANGE') }).distiller.runOnce()).status, 'current');

    clock.at += 25 * HOUR;
    const reconciled = makeLane(store, clock, { result: null });
    const report = await reconciled.distiller.runOnce();
    assert.equal(reconciled.spawns.length, 0, 'a prune needs no model');
    assert.equal(report.status, 'published');
    const published = readProjectFiles(dir);
    assert.equal(published.includes('the poller ticks every 5 minutes'), false);
    assert.equal(published.includes('the poller is opt in'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a project past its claim threshold is re-distilled in full, and only that project is rewritten', async () => {
  const dir = tempDir();
  const clock = { at: START };
  try {
    const store = openStore(dir, clock);
    const big = await seed(store, clock, ['big one', 'big two', 'big three']);
    const other = requireRecord(await store.append(knowledge('a fact from another checkout', '/repos/other')));
    clock.at += 2 * HOUR;
    const seeded = makeLane(store, clock, {
      maxProjectClaims: 20,
      result: distilledResult([
        ...big.map((entry) => ({
          kind: 'knowledge', project: '/repos/glissa', rank: 'model', ids: [entry.id], text: `standing ${entry.text}`,
        })),
        {
          kind: 'knowledge', project: '/repos/other', rank: 'model', ids: [other.id], text: 'a standing claim elsewhere',
        },
      ]),
    });
    assert.equal((await seeded.distiller.runOnce()).status, 'published');
    const cursor = store.distillCursorSeq();

    clock.at += 25 * HOUR;
    const compacting = makeLane(store, clock, {
      maxProjectClaims: 2,
      result: fullResult([{
        kind: 'knowledge', project: '/repos/glissa', rank: 'model', ids: big.map((entry) => entry.id), text: 'one compacted claim',
      }]),
    });
    const report = await compacting.distiller.runOnce();
    assert.equal(report.mode, 'full');
    assert.equal(report.status, 'published');
    assert.equal(compacting.spawns[0].prompt.includes(other.id), false, 'a compaction reads one project only');
    const published = readProjectFiles(dir);
    assert.equal(published.includes('one compacted claim'), true);
    assert.equal(published.includes('standing big one'), false);
    assert.equal(published.includes('a standing claim elsewhere'), true, 'every other project is untouched');
    assert.equal(store.distillCursorSeq(), cursor, 'a compaction never moves the delta cursor');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the published projection is capped in bytes, whatever the model asked to publish', async () => {
  const dir = tempDir();
  const clock = { at: START };
  try {
    const store = openStore(dir, clock);
    const seeds = await seed(store, clock, ['one', 'two', 'three']);
    clock.at += 2 * HOUR;
    const lane = makeLane(store, clock, {
      maxProjectChars: 1200,
      result: distilledResult(seeds.map((entry, index) => ({
        kind: 'knowledge',
        project: '/repos/glissa',
        rank: 'model',
        ids: [entry.id],
        text: `standing ${index} ${'x'.repeat(500)}`,
      }))),
    });
    assert.equal((await lane.distiller.runOnce()).status, 'published');
    const published = readProjectFiles(dir);
    assert.equal(published.length <= 1200, true, 'the delivered bytes are the wall, not the claim count');
    assert.equal(published.includes('standing 0'), true, 'a capped project is never emptied');
    assert.equal(published.includes('standing 2'), false, 'the last claim over the line is dropped');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a compaction that does not shrink its project is refused rather than published', async () => {
  const dir = tempDir();
  const clock = { at: START };
  try {
    const store = openStore(dir, clock);
    const seeds = await seed(store, clock, ['one', 'two', 'three']);
    clock.at += 2 * HOUR;
    const claims = seeds.map((entry) => ({
      kind: 'knowledge', project: '/repos/glissa', rank: 'model', ids: [entry.id], text: `standing ${entry.text}`,
    }));
    assert.equal((await makeLane(store, clock, {
      maxProjectClaims: 20, result: distilledResult(claims),
    }).distiller.runOnce()).status, 'published');
    const version = manifestOf(dir).version;

    clock.at += 25 * HOUR;
    const report = await makeLane(store, clock, {
      maxProjectClaims: 2, result: fullResult(claims),
    }).distiller.runOnce();
    assert.equal(report.status, 'error');
    assert.match(String(report.reason), /no smaller than/);
    assert.equal(manifestOf(dir).version, version);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a forget drops the distilled claims, so the cursor falls back and the canon is read again', async () => {
  const dir = tempDir();
  const clock = { at: START };
  try {
    const store = openStore(dir, clock);
    const [doomed, kept] = await seed(store, clock, ['the staging passphrase is hunter2', 'the poller is opt in']);
    clock.at += 2 * HOUR;
    assert.equal((await makeLane(store, clock, {
      result: distilledResult([
        {
          kind: 'knowledge', project: '/repos/glissa', rank: 'model', ids: [doomed.id], text: 'the staging passphrase is hunter2',
        },
        {
          kind: 'knowledge', project: '/repos/glissa', rank: 'model', ids: [kept.id], text: 'the poller is opt in',
        },
      ]),
    }).distiller.runOnce()).status, 'published');
    assert.equal(store.distillCursorSeq() > 0, true);

    await store.forget('hunter2');
    assert.equal(readProjectFiles(dir).includes('hunter2'), false);
    assert.equal(manifestOf(dir).source, 'trivial');

    clock.at += 25 * HOUR;
    const after = makeLane(store, clock, {
      result: distilledResult([{
        kind: 'knowledge', project: '/repos/glissa', rank: 'model', ids: [kept.id], text: 'the poller is opt in',
      }]),
    });
    assert.equal((await after.distiller.runOnce()).status, 'published');
    assert.equal(after.spawns[0].prompt.includes(kept.id), true, 'the canon is re-read from the start');
    assert.equal(readProjectFiles(dir).includes('hunter2'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
