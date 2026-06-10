'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// diff-core is ESM (.mjs); dynamic-import it from this CJS test file.
const importCore = () => import('../public/sidebar/diff-core.mjs');

test('parseUnifiedDiff: empty input returns []', async () => {
  const { parseUnifiedDiff } = await importCore();
  assert.deepEqual(parseUnifiedDiff(''), []);
  assert.deepEqual(parseUnifiedDiff(null), []);
});

test('parseUnifiedDiff: a modified file yields typed hunk lines and exact counts', async () => {
  const { parseUnifiedDiff } = await importCore();
  const diff = [
    'diff --git a/src/foo.js b/src/foo.js',
    'index 111..222 100644',
    '--- a/src/foo.js',
    '+++ b/src/foo.js',
    '@@ -1,3 +1,4 @@',
    ' context one',
    '-removed line',
    '+added line',
    '+second added',
    ' context two',
    '',
  ].join('\n');
  const files = parseUnifiedDiff(diff);
  assert.equal(files.length, 1);
  const f = files[0];
  assert.equal(f.path, 'src/foo.js');
  assert.equal(f.status, 'modified');
  assert.equal(f.added, 2);
  assert.equal(f.removed, 1);
  assert.equal(f.hunks.length, 1);
  assert.equal(f.hunks[0].header, '@@ -1,3 +1,4 @@');
  assert.deepEqual(f.hunks[0].lines, [
    { type: 'context', text: 'context one' },
    { type: 'del', text: 'removed line' },
    { type: 'add', text: 'added line' },
    { type: 'add', text: 'second added' },
    { type: 'context', text: 'context two' },
  ]);
});

test('parseUnifiedDiff: a new file (git add -N style) is status added', async () => {
  const { parseUnifiedDiff } = await importCore();
  const diff = [
    'diff --git a/new.js b/new.js',
    'new file mode 100644',
    'index 000..abc',
    '--- /dev/null',
    '+++ b/new.js',
    '@@ -0,0 +1,2 @@',
    '+line a',
    '+line b',
  ].join('\n');
  const [f] = parseUnifiedDiff(diff);
  assert.equal(f.path, 'new.js');
  assert.equal(f.status, 'added');
  assert.equal(f.added, 2);
  assert.equal(f.removed, 0);
});

test('parseUnifiedDiff: a deleted file is status deleted', async () => {
  const { parseUnifiedDiff } = await importCore();
  const diff = [
    'diff --git a/old.js b/old.js',
    'deleted file mode 100644',
    'index abc..000',
    '--- a/old.js',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-gone one',
    '-gone two',
  ].join('\n');
  const [f] = parseUnifiedDiff(diff);
  assert.equal(f.path, 'old.js');
  assert.equal(f.status, 'deleted');
  assert.equal(f.removed, 2);
  assert.equal(f.added, 0);
});

test('parseUnifiedDiff: a rename is status renamed with oldPath', async () => {
  const { parseUnifiedDiff } = await importCore();
  const diff = [
    'diff --git a/old/name.js b/new/name.js',
    'similarity index 95%',
    'rename from old/name.js',
    'rename to new/name.js',
    'index abc..def 100644',
    '--- a/old/name.js',
    '+++ b/new/name.js',
    '@@ -1,1 +1,1 @@',
    '-x',
    '+y',
  ].join('\n');
  const [f] = parseUnifiedDiff(diff);
  assert.equal(f.status, 'renamed');
  assert.equal(f.path, 'new/name.js');
  assert.equal(f.oldPath, 'old/name.js');
});

test('parseUnifiedDiff: a binary file is flagged binary', async () => {
  const { parseUnifiedDiff } = await importCore();
  const diff = [
    'diff --git a/img.png b/img.png',
    'index abc..def 100644',
    'Binary files a/img.png and b/img.png differ',
  ].join('\n');
  const [f] = parseUnifiedDiff(diff);
  assert.equal(f.binary, true);
  assert.equal(f.path, 'img.png');
});

test('parseUnifiedDiff: handles CRLF line endings', async () => {
  const { parseUnifiedDiff } = await importCore();
  const diff = [
    'diff --git a/f.js b/f.js',
    '--- a/f.js',
    '+++ b/f.js',
    '@@ -1 +1 @@',
    '-a',
    '+b',
  ].join('\r\n');
  const [f] = parseUnifiedDiff(diff);
  assert.equal(f.path, 'f.js');
  assert.equal(f.added, 1);
  assert.equal(f.removed, 1);
  // No stray CR left on the line text.
  assert.equal(f.hunks[0].lines[1].text, 'b');
});

test('parseUnifiedDiff: two files in one diff', async () => {
  const { parseUnifiedDiff } = await importCore();
  const diff = [
    'diff --git a/one.js b/one.js',
    '--- a/one.js',
    '+++ b/one.js',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git a/two.js b/two.js',
    '--- a/two.js',
    '+++ b/two.js',
    '@@ -1 +1 @@',
    '-c',
    '+d',
  ].join('\n');
  const files = parseUnifiedDiff(diff);
  assert.equal(files.length, 2);
  assert.deepEqual(files.map((f) => f.path), ['one.js', 'two.js']);
});

test('summarizeFiles: rolls up file count and add/remove totals', async () => {
  const { parseUnifiedDiff, summarizeFiles } = await importCore();
  const diff = [
    'diff --git a/one.js b/one.js',
    '--- a/one.js',
    '+++ b/one.js',
    '@@ -1 +1,2 @@',
    '-a',
    '+b',
    '+c',
  ].join('\n');
  const s = summarizeFiles(parseUnifiedDiff(diff));
  assert.deepEqual(s, { files: 1, added: 2, removed: 1 });
  assert.deepEqual(summarizeFiles([]), { files: 0, added: 0, removed: 0 });
});

test('shouldDropDiffCache: drops on merged/none and on parked -> pending-review, keeps otherwise', async () => {
  const { shouldDropDiffCache } = await importCore();
  // Worktree gone: any cached diff is stale regardless of where it came from.
  assert.equal(shouldDropDiffCache('pending-review', 'merged'), true);
  assert.equal(shouldDropDiffCache('parked', 'merged'), true);
  assert.equal(shouldDropDiffCache('parked', 'none'), true);
  assert.equal(shouldDropDiffCache(undefined, 'none'), true);
  // A parked merge handed back as mergeable: the resolve rebase moved HEAD, the cache is stale.
  assert.equal(shouldDropDiffCache('parked', 'pending-review'), true);
  // Everything else keeps the cache.
  assert.equal(shouldDropDiffCache('parked', 'merging'), false);
  assert.equal(shouldDropDiffCache('none', 'pending-review'), false);
  assert.equal(shouldDropDiffCache(undefined, 'pending-review'), false);
  assert.equal(shouldDropDiffCache('pending-review', 'pending-review'), false);
  assert.equal(shouldDropDiffCache('parked', 'parked'), false);
  assert.equal(shouldDropDiffCache('merging', 'parked'), false);
});
