'use strict';

/*
 * Pure core of the fs ingest source (docs/plan-ingestion.md, M9): the ignore set, the root set, the
 * session-to-root derivation, the per-file coalescing state machine, and the events a settled window
 * owes.
 *
 * The scale here is deliberate. A 5000-file storm and a 20-writes-to-one-file save burst are the two
 * shapes this source exists to survive, and both are cheap to build in memory, so they are built rather
 * than argued about: the storm is pushed through a real ring to prove the caps hold, and the save burst
 * is pushed through the coalescer to prove one file costs one event.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  IGNORED_DIR_NAMES, MAX_FILES_PER_BATCH, MAX_TRACKED_FILES, TRUNCATED_SUFFIX,
  buildIgnorePatterns, createBatch, daemonWriteRules, decideFsEvents, dedupeRoots,
  deriveSessionRoots, isActiveSessionState, isIgnoredChange, isPathInside, mergeChange, normalizeRoots,
  recordChange, relativeWithin,
} = require('../server/core/ingest-fs-core');
const { createIngestStore, publishEvent, resolveIngestConfig } = require('../server/core/ingest-core');

const WIN = process.platform === 'win32';
const ROOT = WIN ? 'C:\\work\\project' : '/work/project';

function decided(batch) {
  return decideFsEvents(batch, { root: ROOT, now: 1000 });
}

// --- Coalescing -----------------------------------------------------------

test('twenty writes to one file in one window are one event', () => {
  const batch = createBatch();
  recordChange(batch, 'src/app.js', 'create');
  for (let write = 0; write < 19; write += 1) recordChange(batch, 'src/app.js', 'update');

  assert.equal(batch.files.size, 1);
  const events = decided(batch);
  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'fs');
  assert.equal(events[0].kind, 'file-change');
  assert.equal(events[0].summary, 'created src/app.js');
  assert.equal(events[0].scope.root, ROOT);
});

test('the pairs an atomic save produces resolve to what actually happened', () => {
  // A temp file that appeared and vanished inside one window changed nothing, so it publishes nothing.
  assert.equal(mergeChange('create', 'delete'), null);
  // A file replaced in place is an update, not a claim that it both vanished and appeared.
  assert.equal(mergeChange('delete', 'create'), 'update');
  assert.equal(mergeChange('update', 'delete'), 'delete');
  assert.equal(mergeChange('create', 'update'), 'create');
  assert.equal(mergeChange(null, 'update'), 'update');

  const batch = createBatch();
  for (const [relPath, type] of [
    ['.app.js.swpx', 'create'], ['.app.js.swpx', 'delete'],
    ['src/app.js', 'delete'], ['src/app.js', 'create'],
  ]) recordChange(batch, relPath, type);
  assert.deepEqual(decided(batch).map((event) => event.summary), ['updated src/app.js']);
});

test('a window under the file threshold publishes a line per file, and one over it publishes a burst', () => {
  const small = createBatch();
  for (let file = 0; file < MAX_FILES_PER_BATCH; file += 1) recordChange(small, `src/file-${file}.js`, 'update');
  assert.equal(decided(small).length, MAX_FILES_PER_BATCH, 'at the threshold every file still gets its own line');

  const big = createBatch();
  for (let file = 0; file < MAX_FILES_PER_BATCH + 1; file += 1) recordChange(big, `src/file-${file}.js`, 'update');
  const events = decided(big);
  assert.equal(events.length, 1, 'one file past the threshold collapses the whole window');
  assert.equal(events[0].summary, `${MAX_FILES_PER_BATCH + 1} files changed: ${MAX_FILES_PER_BATCH + 1} updated`);
});

test('an empty window owes nothing, and the batch refuses what it cannot describe', () => {
  assert.deepEqual(decided(createBatch()), []);
  const batch = createBatch();
  // The ignore rules run at the shell, BEFORE the batcher, so what the batch refuses is only what it
  // could not turn into an event: a change kind @parcel/watcher never emits, and a nameless path.
  assert.equal(recordChange(batch, 'src/app.js', 'renamed'), false);
  assert.equal(recordChange(batch, '', 'update'), false);
  assert.deepEqual(decided(batch), []);
});

/*
 * The storm the plan names: a 400MB dependency install, or a checkout of a large tree. It has to leave the
 * rings inside their caps AND leave the digest as roughly one line, which is two separate claims: the
 * batch collapses 5000 files into one event, and even if it did not, the ring evicts to its bound.
 */
test('a 5000-file storm stays inside the tracked-file bound and publishes one floored event', () => {
  const batch = createBatch();
  for (let file = 0; file < 5000; file += 1) recordChange(batch, `packages/app/gen/file-${file}.ts`, 'create');

  assert.equal(batch.files.size, MAX_TRACKED_FILES, 'the batch holds at its bound rather than growing');
  assert.equal(batch.floored, true);

  const events = decided(batch);
  assert.equal(events.length, 1);
  // Past the bound the batch can no longer tell a new path from a repeat, so it reports a floor it can
  // stand behind rather than a total that would be quietly short.
  assert.equal(events[0].summary, `at least ${MAX_TRACKED_FILES} files changed: ${MAX_TRACKED_FILES} created`);
});

/*
 * Under the bound the count has to be of distinct FILES, not of events. @parcel/watcher reports a create
 * AND an update for one written file, so counting events reported a 500-file checkout as 1000: a number
 * the digest states as fact and that is wrong by the factor of how often the watcher saw each path.
 */
test('a file written twice inside one window is still one file', () => {
  const batch = createBatch();
  for (let file = 0; file < 500; file += 1) {
    recordChange(batch, `gen/file-${file}.ts`, 'create');
    recordChange(batch, `gen/file-${file}.ts`, 'update');
  }
  assert.equal(batch.files.size, 500, 'create plus update on one path is one file, not two');
  assert.equal(decided(batch)[0].summary, '500 files changed: 500 created');
});

/*
 * A path too long to hold is truncated, and two files sharing a 200-char prefix then merge, which
 * truncation cannot avoid. What it can avoid is doing so QUIETLY: before the marker the published path
 * read exactly like a real one, so a digest reader had no way to know it named no file on disk.
 */
test('a truncated path says it is truncated', () => {
  const longPath = `src/${'a'.repeat(400)}/app.js`;
  const batch = createBatch();
  recordChange(batch, longPath, 'update');

  const [event] = decided(batch);
  assert.ok(event.summary.endsWith(TRUNCATED_SUFFIX), `summary must show the truncation: ${event.summary}`);
  assert.ok(event.summary.length < longPath.length);
  assert.ok(longPath.startsWith(event.summary.slice('updated '.length, -TRUNCATED_SUFFIX.length)), 'the kept prefix is real');

  // A path that fits is untouched, so the marker only ever appears where something was actually cut.
  const short = createBatch();
  recordChange(short, 'src/app.js', 'update');
  assert.equal(decided(short)[0].summary, 'updated src/app.js');
});

/*
 * An over-long path is scrubbed BEFORE it is cut, since a cut taken ahead of the publish-time scrub can
 * split a quoted value out of its closing quote. The scrub can then shrink the path back inside the
 * bound, and the marker must follow what was actually published: claiming a truncation that did not
 * happen tells a reader this names no exact file when it names one exactly.
 */
test('a path the scrub shrank back inside the bound is published without the truncation marker', () => {
  const batch = createBatch();
  recordChange(batch, `src/token=${'a'.repeat(400)}/app.js`, 'update');

  const [event] = decided(batch);
  assert.equal(event.summary, 'updated src/token=[scrubbed]', event.summary);
  assert.ok(!event.summary.endsWith(TRUNCATED_SUFFIX), `nothing was cut: ${event.summary}`);

  // A path still over the bound after the scrub keeps saying so.
  const stillLong = createBatch();
  recordChange(stillLong, `src/${'b'.repeat(400)}/app.js`, 'update');
  assert.ok(decided(stillLong)[0].summary.endsWith(TRUNCATED_SUFFIX));
});

test('a secret-shaped path never reaches the fs ring unscrubbed', () => {
  const config = resolveIngestConfig({ enabled: true, sources: { fs: { enabled: true } } });
  const store = createIngestStore(config);
  const batch = createBatch();
  recordChange(batch, `src/${'c'.repeat(190)}/password="hunter two three".txt`, 'update');
  for (const event of decided(batch)) publishEvent(store, event, 1000);

  const [stored] = store.rings.get('fs').entries.map((entry) => entry.event);
  assert.ok(!stored.summary.includes('hunter'), stored.summary);
  assert.ok(!stored.summary.includes('two three'), stored.summary);
});

test('even unbatched, a storm of per-file events cannot push the fs ring past its caps', () => {
  const config = resolveIngestConfig({ enabled: true, sources: { fs: { enabled: true } } });
  const store = createIngestStore(config);
  for (let file = 0; file < 5000; file += 1) {
    publishEvent(store, {
      source: 'fs', kind: 'file-change', scope: { root: ROOT }, summary: `updated gen/file-${file}.ts`,
    }, 1000);
  }
  const ring = store.rings.get('fs');
  assert.ok(ring.entries.length <= config.sources.fs.maxEntries, `ring held ${ring.entries.length} entries`);
  assert.ok(ring.totalBytes <= config.sources.fs.maxBytes, `ring held ${ring.totalBytes} bytes`);
});

// --- Ignore rules ---------------------------------------------------------

test('the watcher ignore list carries every name in the three shapes a nested copy needs', () => {
  const patterns = buildIgnorePatterns();
  for (const name of ['.git', 'node_modules', '.glissa']) {
    assert.ok(patterns.includes(name), `${name} must be ignored at the root`);
    assert.ok(patterns.includes(`**/${name}`), `a nested ${name} directory must be ignored`);
    assert.ok(patterns.includes(`**/${name}/**`), `everything under a nested ${name} must be ignored`);
  }
  assert.ok(patterns.includes('**/*.swp'));
  assert.ok(patterns.includes('**/.DS_Store'));
  assert.deepEqual(buildIgnorePatterns(['my-generated']).filter((p) => p === 'my-generated'), ['my-generated']);
});

test('an event inside an ignored directory is dropped wherever it sits', () => {
  for (const name of IGNORED_DIR_NAMES) {
    assert.equal(isIgnoredChange({ relPath: `${name}/thing.js` }), true, `${name} at the root`);
    assert.equal(isIgnoredChange({ relPath: `packages/app/${name}/deep/thing.js` }), true, `${name} nested`);
  }
  assert.equal(isIgnoredChange({ relPath: 'src/app.js' }), false);
  // A name that merely CONTAINS an ignored name is a real directory a carbon unit made.
  assert.equal(isIgnoredChange({ relPath: 'node_modules_notes/plan.md' }), false);
});

test('editor scratch and OS droppings never reach the batcher', () => {
  for (const relPath of ['src/.app.js.swp', 'src/app.js~', 'notes.tmp', 'a/b/.DS_Store', 'Thumbs.db', 'x/index.lock']) {
    assert.equal(isIgnoredChange({ relPath }), true, relPath);
  }
  assert.equal(isIgnoredChange({ relPath: 'package-lock.json' }), false, 'a real lock FILE is real activity');
});

/*
 * The feedback loop this closes: in a dev checkout the resolved config file IS the repo's own
 * config.json, and the daemon writes it on every hook that carries a Claude session id. Since M7.5 every
 * published event advances the navigator's movement signal, so glissa's own bookkeeping would poke the
 * next dispatch, once per turn, forever.
 */
test('the daemon\'s own writes beside its config file are not project activity', () => {
  const configPath = path.join(ROOT, 'config.json');
  const daemonRules = daemonWriteRules(configPath);
  const cases = [
    ['config.json', true],
    ['usage-lanes.json', true],
    ['usage-warehouse.json', true],
    ['usage-budget-state.json', true],
    ['pairings.json', true],
    ['recordings/session-abc.jsonl', true],
    ['uploads/p1/shot.png', true],
    ['src/app.js', false],
    ['docs/config.json', false],
  ];
  for (const [relPath, ignored] of cases) {
    const absolutePath = path.join(ROOT, relPath.split('/').join(path.sep));
    assert.equal(isIgnoredChange({ relPath, absolutePath, daemonRules }), ignored, relPath);
  }
  assert.equal(daemonWriteRules(null), null, 'no config path means no daemon rules, never a guess');
  // Without the absolute path there is nothing to compare against, so the segment rules are all that run.
  assert.equal(isIgnoredChange({ relPath: 'config.json', daemonRules }), false);
});

/*
 * The names config-store DERIVES from the config file, which no exact-path list can hold: every
 * content-changing save writes `<config>.bak`, boot writes `<config>.boot.bak`, a parse failure writes
 * `<config>.invalid.bak`, and every save stages through `<config>.tmp.<pid>`, whose pid is new each run.
 * `config.json.bak` is not INSIDE `config.json`, so before the prefix rule a wasActive flip published
 * "updated config.json.bak" and spent navigator movement signal once per turn in a dev checkout.
 */
test('the backup and temp files config-store derives from the config name are refused too', () => {
  const daemonRules = daemonWriteRules(path.join(ROOT, 'config.json'));
  const ignored = ['config.json.bak', 'config.json.boot.bak', 'config.json.invalid.bak', 'config.json.tmp.12345'];
  for (const relPath of ignored) {
    const absolutePath = path.join(ROOT, relPath);
    assert.equal(isIgnoredChange({ relPath, absolutePath, daemonRules }), true, relPath);
  }
  // The prefix is `config.json.`, not a loose startsWith on `config`: a repo file that merely begins the
  // same way is a carbon unit's own file and must still publish.
  for (const relPath of ['configuration.json', 'config.json5', 'config.jsonc', 'config-example.json']) {
    const absolutePath = path.join(ROOT, relPath);
    assert.equal(isIgnoredChange({ relPath, absolutePath, daemonRules }), false, relPath);
  }
  // And the rule is anchored to the config file's own directory, so a same-named backup elsewhere in the
  // repo is not the daemon talking.
  const elsewhere = path.join(ROOT, 'fixtures', 'config.json.bak');
  assert.equal(isIgnoredChange({ relPath: 'fixtures/config.json.bak', absolutePath: elsewhere, daemonRules }), false);
});

// --- Roots ----------------------------------------------------------------

test('config roots are normalized to strings, trimmed and deduped', () => {
  assert.deepEqual(normalizeRoots([' /a ', '/a', '', null, 42, '/b']), ['/a', '/b']);
  assert.deepEqual(normalizeRoots('not an array'), []);
  assert.deepEqual(normalizeRoots(undefined), []);
});

test('a root inside another root is dropped, so one change is never reported twice', () => {
  const parent = path.join(ROOT, '..');
  assert.deepEqual(dedupeRoots([ROOT, path.join(ROOT, 'src')]), [ROOT]);
  assert.deepEqual(dedupeRoots([path.join(ROOT, 'src'), ROOT]), [ROOT], 'order cannot decide which survives');
  assert.deepEqual(dedupeRoots([ROOT, ROOT]), [ROOT]);
  // The widest root wins even when it arrives last, which is the explicit-fs.roots-covering-a-session case.
  const collapsed = dedupeRoots([path.join(ROOT, 'a'), path.join(ROOT, 'b'), path.resolve(parent)]);
  assert.deepEqual(collapsed, [path.resolve(parent)]);
  // Siblings are independent, which is the ordinary two-projects case.
  assert.equal(dedupeRoots([path.join(ROOT, '..', 'one'), path.join(ROOT, '..', 'two')]).length, 2);
});

test('two spellings of one Windows directory are one root', { skip: !WIN }, () => {
  assert.deepEqual(dedupeRoots(['C:\\Work\\Project', 'c:\\work\\project']), ['C:\\Work\\Project']);
  assert.equal(isPathInside('C:\\Work', 'c:\\work\\project\\src'), true);
});

test('isPathInside reads a path, never a prefix of its spelling', () => {
  assert.equal(isPathInside(ROOT, ROOT), true, 'a root contains itself');
  assert.equal(isPathInside(ROOT, path.join(ROOT, 'src', 'app.js')), true);
  assert.equal(isPathInside(ROOT, `${ROOT}-other`), false, 'a sibling sharing a name prefix is outside');
  assert.equal(isPathInside(ROOT, path.join(ROOT, '..', 'other')), false);
  assert.equal(isPathInside(null, ROOT), false);
});

test('an event naming something outside its root has no relative path', () => {
  assert.equal(relativeWithin(ROOT, path.join(ROOT, 'src', 'app.js')), 'src/app.js');
  assert.equal(relativeWithin(ROOT, path.join(ROOT, '..', 'sibling', 'x.js')), null);
  assert.equal(relativeWithin(ROOT, ROOT), null, 'the root itself names no file');
  assert.equal(relativeWithin(ROOT, null), null);
});

// --- Sessions -------------------------------------------------------------

test('a session contributes both halves of its checkout, and nothing it does not have', () => {
  assert.deepEqual(deriveSessionRoots({ path: '/p' }), ['/p']);
  assert.deepEqual(deriveSessionRoots({ path: '/p', worktreeDir: '/w' }), ['/p', '/w']);
  assert.deepEqual(deriveSessionRoots({ path: '/p', worktreeDir: '/p' }), ['/p'], 'one directory, one root');
  assert.deepEqual(deriveSessionRoots({ path: '', worktreeDir: null }), []);
  assert.deepEqual(deriveSessionRoots(null), []);
});

test('a session is a watched checkout from the moment it starts until it exits', () => {
  for (const state of ['INITIALIZING', 'STARTING', 'RUNNING', 'WAITING', 'IDLE', 'COMPLETE']) {
    assert.equal(isActiveSessionState(state), true, state);
  }
  for (const state of ['DORMANT', 'DONE', 'FAILED', '', null, undefined]) {
    assert.equal(isActiveSessionState(state), false, String(state));
  }
});
