'use strict';

// The memory-distill lane end to end against a fake spawn (docs/plan-visions-3.md, M15). What a run may
// do to memory/dist/ is the whole surface: publish and rotate, or leave the last good build exactly
// where it was.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMemoryStore } = require('../server/memory-store');
const {
  BOOTSTRAP_PROMPT, MEMORY_DISTILL_DENY_TOOLS, PROMPT_FILE, WORK_DIR_PREFIX, createMemoryDistiller,
} = require('../server/memory-distill');
const { resolveDistillConfig } = require('../server/core/memory-distill-core');
const { resolveMemoryConfig } = require('../server/core/memory-core');
const { isDispatchWorkdir } = require('../server/core/ingest-agent-core');

const QUIET = { log() {}, warn() {} };
const START = Date.UTC(2026, 7, 23, 12, 0, 0);
const HOUR = 3600000;

const openedStores = [];

test.afterEach(async () => {
  for (const store of openedStores.splice(0)) {
    await store.stop().catch(() => {});
  }
});

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-memory-distill-'));
}

function openStore(dir, clock) {
  const store = createMemoryStore({
    dir,
    dbPath: path.join(dir, 'glissa.db'),
    config: { ...resolveMemoryConfig(null), enabled: true },
    logger: QUIET,
    now: () => clock.at,
    projectionDebounceMs: 1,
  });
  openedStores.push(store);
  return store;
}

function knowledge(text, project = '/repos/glissa') {
  return {
    kind: 'knowledge',
    layer: 'episodic',
    project,
    source: { kind: 'reported', vendor: 'claude', sessionId: 's-1' },
    text,
  };
}

/**
 * The lane with its spawn replaced by a writer of whatever result file the test wants. `written`
 * records every prompt, so a test can assert a gate spawned nothing at all.
 */
function makeLane(store, clock, { result = null, onSpawn = null, ...config } = {}) {
  const spawns = [];
  const distiller = createMemoryDistiller({
    store,
    config: { ...resolveDistillConfig(config, { memoryEnabled: true }), ...config },
    logger: QUIET,
    now: () => clock.at,
    makeWorkDir: async () => fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-distill-work-')),
    removeWorkDir: async (dir) => fs.rmSync(dir, { recursive: true, force: true }),
    spawnDistill: async ({ prompt, cwd }) => {
      const promptFile = path.join(cwd, PROMPT_FILE);
      const delivered = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : '';
      spawns.push({ prompt: delivered, argvPrompt: prompt, cwd });
      if (onSpawn) await onSpawn({ prompt: delivered, cwd });
    },
    readResult: async () => result,
  });
  return { distiller, spawns };
}

function readProjectFiles(dir) {
  const projectsDir = path.join(dir, 'dist', 'current', 'projects');
  if (!fs.existsSync(projectsDir)) return '';
  return fs.readdirSync(projectsDir).map((name) => fs.readFileSync(path.join(projectsDir, name), 'utf8')).join('\n');
}

function readCurrent(dir, relPath = 'MEMORY.md') {
  try {
    return fs.readFileSync(path.join(dir, 'dist', 'current', relPath), 'utf8');
  } catch {
    return null;
  }
}

function manifestOf(dir, slot = 'current') {
  const raw = readCurrent(dir, slot === 'current' ? 'manifest.json' : null);
  if (slot === 'current') return JSON.parse(raw);
  return JSON.parse(fs.readFileSync(path.join(dir, 'dist', slot, 'manifest.json'), 'utf8'));
}

// The lane speaks the incremental op contract now, so a full claim set reaches it as a list of adds.
function distilledResult(claims, verdict = 'DISTILLED') {
  return { verdict, summary: 'distilled the canon', ops: claims.map((claim) => ({ op: 'add', claim })) };
}

// A compaction run answers with a whole claim set for one project, which is the pre-M18 contract.
function fullResult(claims, verdict = 'DISTILLED') {
  return { verdict, summary: 'compacted one project', claims };
}

async function seed(store, clock, texts) {
  const records = [];
  for (const text of texts) {
    records.push(await store.append(knowledge(text)));
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
    assert.match(report.reason, /unresolvable/);
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
    // A timeout the test drives by hand: the injected timer fires the abort at once.
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
    assert.match(report.reason, /timed out/);
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
    const locked = await store.append({
      kind: 'preference',
      layer: 'semantic',
      project: null,
      source: { kind: 'operator', vendor: 'glissa', sessionId: null },
      text: 'never write else statements',
      locked: true,
    });
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
    assert.equal(result.ok, true);
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
    // The default makeWorkDir is the one under test, so nothing is injected over it.
    const report = await lane.runOnce();
    assert.equal(report.status, 'published');
    assert.equal(WORK_DIR_PREFIX, 'glissa-memory-distill-');
    assert.equal(isDispatchWorkdir(path.join(os.tmpdir(), `${WORK_DIR_PREFIX}work-ab12`)), true);
    // The first shipped version denied these and would have failed every real run: a bare Read deny
    // refuses the Write tool, so the result file could never be written.
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
  const warnings = [];
  try {
    const store = createMemoryStore({
      dir,
      dbPath: path.join(dir, 'glissa.db'),
      config: { ...resolveMemoryConfig(null), enabled: true },
      logger: { log() {}, warn: (line) => warnings.push(line) },
      now: () => clock.at,
      projectionDebounceMs: 1,
    });
    openedStores.push(store);
    await seed(store, clock, ['the poller ticks every 15 minutes']);
    const manifestPath = path.join(dir, 'dist', 'current', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.files = [
      { relPath: '../../../../etc/passwd', sha256: 'x' },
      { relPath: 'nested/../../hmac-key', sha256: 'x' },
      { relPath: path.join(dir, 'hmac-key'), sha256: 'x' },
      ...manifest.files,
    ];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const documents = await store.readPublishedDocuments(await store.readPublishedManifest());
    assert.equal(documents.length, manifest.files.length - 3, 'only the contained files were read');
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

    const second = await store.append(knowledge('the poller is opt in'));
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
    const locked = await store.append({
      kind: 'preference',
      layer: 'semantic',
      project: null,
      source: { kind: 'operator', vendor: 'glissa', sessionId: null },
      text: 'never write else statements',
      locked: true,
    });
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

    const second = await store.append(knowledge('the poller is opt in'));
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
    // The superseder is a record of its own, so a run reads it before the prune it caused can be seen.
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
    const other = await store.append(knowledge('a fact from another checkout', '/repos/other'));
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
    assert.match(report.reason, /no fewer than/);
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
