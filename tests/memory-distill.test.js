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
const { createMemoryDistiller } = require('../server/memory-distill');
const { resolveDistillConfig } = require('../server/core/memory-distill-core');
const { resolveMemoryConfig } = require('../server/core/memory-core');

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
    config: { ...resolveMemoryConfig(null), enabled: true },
    logger: QUIET,
    now: () => clock.at,
    projectionDebounceMs: 1,
    watchCanon: false,
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
      spawns.push({ prompt, cwd });
      if (onSpawn) await onSpawn({ prompt, cwd });
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

function distilledResult(claims, verdict = 'DISTILLED') {
  return { verdict, summary: 'distilled the canon', claims };
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
