import test from 'node:test';
import assert from 'node:assert/strict';
import type { FsBatch } from '../server/core/ingest-fs-core.ts';
import type { IngestRing } from '../server/core/ingest-core.ts';
import path from 'node:path';

import {
  IGNORED_DIR_NAMES, MAX_FILES_PER_BATCH, MAX_TRACKED_FILES, MAX_UNTRACKED_KEYS, TRUNCATED_SUFFIX,
  batchSize, buildIgnorePatterns, createBatch, daemonWriteRules, decideFsEvents, dedupeRoots,
  deriveSessionRoots, isActiveSessionState, isIgnoredChange, isPathInside, mergeChange, normalizeRoots,
  recordChange, relativeWithin,
} from '../server/core/ingest-fs-core.ts';
import { createIngestStore, publishEvent, resolveIngestConfig, ringStats } from '../server/core/ingest-core.ts';

const WIN = process.platform === 'win32';
const ROOT = WIN ? 'C:\\work\\project' : '/work/project';

function decided(batch: FsBatch) {
  return decideFsEvents(batch, { root: ROOT, now: 1000 });
}

test('twenty writes to one file in one window are one event', () => {
  const batch = createBatch();
  recordChange(batch, 'src/app.js', 'create');
  for (let write = 0; write < 19; write += 1) recordChange(batch, 'src/app.js', 'update');

  assert.equal(batchSize(batch), 1);
  const events = decided(batch);
  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'fs');
  assert.equal(events[0].kind, 'file-change');
  assert.equal(events[0].summary, 'created src/app.js');
  assert.equal(events[0].scope.root, ROOT);
});

test('the pairs an atomic save produces resolve to what actually happened', () => {
  assert.equal(mergeChange('create', 'delete'), null);

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
  assert.equal(events[0].detail.files, MAX_FILES_PER_BATCH + 1);
  assert.equal(events[0].detail.updated, MAX_FILES_PER_BATCH + 1);
});

test('an empty window owes nothing, and the batch refuses what it cannot describe', () => {
  assert.deepEqual(decided(createBatch()), []);
  const batch = createBatch();

  assert.equal(recordChange(batch, 'src/app.js', 'renamed'), false);
  assert.equal(recordChange(batch, '', 'update'), false);
  assert.deepEqual(decided(batch), []);
});

test('a 5000-file storm stays inside the tracked-file bound and publishes one event', () => {
  const batch = createBatch();
  for (let file = 0; file < 5000; file += 1) recordChange(batch, `packages/app/gen/file-${file}.ts`, 'create');

  assert.equal(batch.files.size, MAX_TRACKED_FILES, 'past the bound the batch counts without remembering names');
  assert.equal(batchSize(batch), 5000, 'the count is still the truth');

  const events = decided(batch);
  assert.equal(events.length, 1);
  assert.equal(events[0].summary, '5000 files changed: 2000 created');
  assert.equal(events[0].detail.files, 5000);
  assert.equal(events[0].detail.atLeast, false);
  assert.ok(String(events[0].detail.sample).startsWith('packages/app/gen/file-0.ts'));
});

test('past the tracked bound a file written twice is still one file', () => {
  const batch = createBatch();
  for (let file = 0; file < 3000; file += 1) {
    recordChange(batch, `gen/file-${file}.ts`, 'create');
    recordChange(batch, `gen/file-${file}.ts`, 'update');
  }
  assert.equal(batchSize(batch), 3000, 'create plus update on one path is one file, not two');
  assert.equal(decided(batch)[0].detail.files, 3000);
});

test('a storm past the untracked bound reports its total as a floor and says so', () => {
  const batch = createBatch();
  const distinct = MAX_TRACKED_FILES + MAX_UNTRACKED_KEYS + 500;
  for (let file = 0; file < distinct; file += 1) recordChange(batch, `gen/file-${file}.ts`, 'create');

  const ceiling = MAX_TRACKED_FILES + MAX_UNTRACKED_KEYS;
  assert.equal(batch.floored, true);
  assert.equal(batchSize(batch), ceiling, 'the batch holds at its bound rather than growing');
  const [event] = decided(batch);
  assert.equal(event.summary, `at least ${ceiling} files changed: ${MAX_TRACKED_FILES} created`);
  assert.equal(event.detail.files, ceiling);
  assert.equal(event.detail.atLeast, true, 'the number is marked as a floor, never as a count');
});

test('a truncated path says it is truncated', () => {
  const longPath = `src/${'a'.repeat(400)}/app.js`;
  const batch = createBatch();
  recordChange(batch, longPath, 'update');

  const [event] = decided(batch);
  assert.ok(event.summary.endsWith(TRUNCATED_SUFFIX), `summary must show the truncation: ${event.summary}`);
  assert.ok(String(event.detail.path).endsWith(TRUNCATED_SUFFIX));
  assert.ok(String(event.detail.path).length < longPath.length);
  assert.ok(longPath.startsWith(String(event.detail.path).slice(0, -TRUNCATED_SUFFIX.length)), 'the kept prefix is real');

  const short = createBatch();
  recordChange(short, 'src/app.js', 'update');
  assert.equal(decided(short)[0].detail.path, 'src/app.js');
});

test('a path the scrub shrank back inside the bound is published without the truncation marker', () => {
  const batch = createBatch();
  recordChange(batch, `src/token=${'a'.repeat(400)}/app.js`, 'update');

  const [event] = decided(batch);
  assert.equal(event.detail.path, 'src/token=[scrubbed]', String(event.detail.path));
  assert.ok(!event.summary.endsWith(TRUNCATED_SUFFIX), `nothing was cut: ${event.summary}`);

  const stillLong = createBatch();
  recordChange(stillLong, `src/${'b'.repeat(400)}/app.js`, 'update');
  assert.ok(String(decided(stillLong)[0].detail.path).endsWith(TRUNCATED_SUFFIX));
});

test('a secret-shaped path never reaches the fs ring unscrubbed', () => {
  const config = resolveIngestConfig({ enabled: true, sources: { fs: { enabled: true } } });
  const store = createIngestStore(config);
  const batch = createBatch();
  recordChange(batch, `src/${'c'.repeat(190)}/password="hunter two three".txt`, 'update');
  for (const event of decided(batch)) publishEvent(store, event, 1000);

  const [stored] = (store.rings.get('fs') as IngestRing).entries.map((entry) => entry.event);
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
  const [stats] = ringStats(store).filter((entry) => entry.source === 'fs');
  assert.ok(stats.events <= config.sources.fs.maxEntries, `ring held ${stats.events} entries`);
  assert.ok(stats.bytes <= config.sources.fs.maxBytes, `ring held ${stats.bytes} bytes`);
});

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

  assert.equal(isIgnoredChange({ relPath: 'node_modules_notes/plan.md' }), false);
});

test('editor scratch and OS droppings never reach the batcher', () => {
  for (const relPath of ['src/.app.js.swp', 'src/app.js~', 'notes.tmp', 'a/b/.DS_Store', 'Thumbs.db', 'x/index.lock']) {
    assert.equal(isIgnoredChange({ relPath }), true, relPath);
  }
  assert.equal(isIgnoredChange({ relPath: 'package-lock.json' }), false, 'a real lock FILE is real activity');
});

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
    const absolutePath = path.join(ROOT, String(relPath).split('/').join(path.sep));
    assert.equal(isIgnoredChange({ relPath, absolutePath, daemonRules }), ignored, String(relPath));
  }
  assert.equal(daemonWriteRules(null), null, 'no config path means no daemon rules, never a guess');

  assert.equal(isIgnoredChange({ relPath: 'config.json', daemonRules }), false);
});

test('the backup and temp files config-store derives from the config name are refused too', () => {
  const daemonRules = daemonWriteRules(path.join(ROOT, 'config.json'));
  const ignored = ['config.json.bak', 'config.json.boot.bak', 'config.json.invalid.bak', 'config.json.tmp.12345'];
  for (const relPath of ignored) {
    const absolutePath = path.join(ROOT, relPath);
    assert.equal(isIgnoredChange({ relPath, absolutePath, daemonRules }), true, relPath);
  }

  for (const relPath of ['configuration.json', 'config.json5', 'config.jsonc', 'config-example.json']) {
    const absolutePath = path.join(ROOT, relPath);
    assert.equal(isIgnoredChange({ relPath, absolutePath, daemonRules }), false, relPath);
  }

  const elsewhere = path.join(ROOT, 'fixtures', 'config.json.bak');
  assert.equal(isIgnoredChange({ relPath: 'fixtures/config.json.bak', absolutePath: elsewhere, daemonRules }), false);
});

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

  const collapsed = dedupeRoots([path.join(ROOT, 'a'), path.join(ROOT, 'b'), path.resolve(parent)]);
  assert.deepEqual(collapsed, [path.resolve(parent)]);

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
