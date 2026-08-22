'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  pathOfFileUri,
  normalizeShapePath,
  isUriInProjects,
} = require('../server/core/visions-scope-core');

test('pathOfFileUri normalizes plain and percent-encoded file uris', () => {
  assert.equal(pathOfFileUri('file:///home/me/project/README.md'), '/home/me/project/README.md');
  assert.equal(pathOfFileUri('file:///home/me/project/My%20Plan.md'), '/home/me/project/My Plan.md');
  assert.equal(pathOfFileUri('file:///home/me/project/a/../b/./c.md'), '/home/me/project/b/c.md');
});

test('pathOfFileUri folds Windows drive-letter file uri spellings to one shape', () => {
  assert.equal(pathOfFileUri('file:///c:/Repo/Doc.md'), 'c:/repo/doc.md');
  assert.equal(pathOfFileUri('file:///C%3A/Repo/Doc.md'), 'c:/repo/doc.md');
  assert.equal(pathOfFileUri('file:///C:/Repo%5CDoc.md'), 'c:/repo/doc.md');
});

test('pathOfFileUri folds UNC file uri spellings by shape', () => {
  assert.equal(pathOfFileUri('file://Server/Share/Doc.md'), '//server/share/doc.md');
  assert.equal(pathOfFileUri('file:////Server/Share/Doc.md'), '//server/share/doc.md');
});

test('pathOfFileUri rejects non-file, empty and malformed uris', () => {
  assert.equal(pathOfFileUri('untitled:Untitled-1'), null);
  assert.equal(pathOfFileUri('https://example.test/doc.md'), null);
  assert.equal(pathOfFileUri('file:///%E0%A4%A'), null);
  assert.equal(pathOfFileUri(''), null);
  assert.equal(pathOfFileUri(null), null);
});

test('normalizeShapePath uses the same shape folding as uri paths', () => {
  assert.equal(normalizeShapePath('C:\\Repo\\Sub\\'), 'c:/repo/sub');
  assert.equal(normalizeShapePath('\\\\Server\\Share\\Repo\\'), '//server/share/repo');
  assert.equal(normalizeShapePath('/home/me/Repo'), '/home/me/Repo');
});

test('isUriInProjects accepts exact and nested paths only on a segment boundary', () => {
  const paths = ['/a/b'];
  assert.equal(isUriInProjects('file:///a/b', paths), true);
  assert.equal(isUriInProjects('file:///a/b/c.md', paths), true);
  assert.equal(isUriInProjects('file:///a/bc/c.md', paths), false);
  assert.equal(isUriInProjects('file:///a', paths), false);
});

test('isUriInProjects folds slashes and case for Windows and UNC shapes', () => {
  assert.equal(isUriInProjects('file:///C:/Repo/Sub/Doc.md', [normalizeShapePath('c:\\repo')]), true);
  assert.equal(isUriInProjects('file://SERVER/Share/Repo/Doc.md', [normalizeShapePath('\\\\server\\share\\repo')]), true);
});

test('isUriInProjects treats null and empty lists as unscoped', () => {
  assert.equal(isUriInProjects('untitled:Untitled-1', null), true);
  assert.equal(isUriInProjects('file:///any/path.md', []), true);
  assert.equal(isUriInProjects('untitled:Untitled-1', ['/a/b']), false);
});
