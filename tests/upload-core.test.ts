import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_UPLOAD_BYTES,
  UPLOAD_RETAIN_FILES,
  buildUploadFilename,
  decideUploadType,
  exceedsUploadCap,
  extensionForImageMime,
  extensionForUploadName,
  framePathPaste,
  isSafePathSegment,
  isUploadFilename,
  planUploadRetention,
} from '../server/core/upload-core.ts';

test('extensionForImageMime maps the four accepted image types and nothing else', () => {
  assert.equal(extensionForImageMime('image/png'), '.png');
  assert.equal(extensionForImageMime('image/jpeg'), '.jpg');
  assert.equal(extensionForImageMime('image/webp'), '.webp');
  assert.equal(extensionForImageMime('image/gif'), '.gif');
  assert.equal(extensionForImageMime('image/svg+xml'), null);
  assert.equal(extensionForImageMime('application/pdf'), null);
  assert.equal(extensionForImageMime('text/plain'), null);
  assert.equal(extensionForImageMime(''), null);
  assert.equal(extensionForImageMime(undefined), null);
});

test('extensionForImageMime tolerates the charset parameter and casing a browser may send', () => {
  assert.equal(extensionForImageMime('image/PNG'), '.png');
  assert.equal(extensionForImageMime('image/jpeg; charset=binary'), '.jpg');
  assert.equal(extensionForImageMime('  image/webp  '), '.webp');
});

test('decideUploadType lets an image MIME win over whatever the client called the file', () => {
  assert.deepEqual(decideUploadType('image/png'), { ok: true, extension: '.png' });
  assert.deepEqual(decideUploadType('image/png', 'shot.pdf'), { ok: true, extension: '.png' });
});

test('decideUploadType refuses 415 only when neither an image MIME nor a name reaches it', () => {
  const refused = decideUploadType('application/zip');
  assert.ok(!refused.ok);
  assert.equal(refused.status, 415);
  assert.equal(refused.error, 'unsupported upload type');

  const absent = decideUploadType(undefined);
  assert.ok(!absent.ok, 'an absent content type with no name is refused too');
  assert.equal(absent.status, 415);

  const undecodable = decideUploadType('application/zip', '%');
  assert.ok(!undecodable.ok, 'a name that fails to decode counts as absent');
  assert.equal(undecodable.status, 415);

  const empty = decideUploadType('application/zip', '');
  assert.ok(!empty.ok, 'an empty name header counts as absent');
});

test('decideUploadType takes an extension from the client name once the MIME is not an image', () => {
  assert.deepEqual(decideUploadType('application/pdf', 'report.pdf'), { ok: true, extension: '.pdf' });
  assert.deepEqual(decideUploadType('text/markdown', 'notes.md'), { ok: true, extension: '.md' });
  assert.deepEqual(decideUploadType('application/gzip', 'archive.tar.gz'), { ok: true, extension: '.gz' });
  assert.deepEqual(decideUploadType('application/pdf', 'report.PDF'), { ok: true, extension: '.pdf' });
  assert.deepEqual(decideUploadType('application/octet-stream', 'Makefile'), { ok: true, extension: '' });
  assert.deepEqual(decideUploadType(undefined, 'notes.txt'), { ok: true, extension: '.txt' });
});

test('extensionForUploadName keeps nothing but the trailing alphanumeric extension', () => {
  assert.equal(extensionForUploadName(encodeURIComponent('../../etc/passwd')), '', 'a traversal name leaks no extension');
  assert.equal(extensionForUploadName(encodeURIComponent('../../etc/passwd.conf')), '.conf', 'only the extension survives');
  assert.equal(extensionForUploadName('a.abcdefghijklmnopq'), '', 'a 17 character extension is not one');
  assert.equal(extensionForUploadName('a.abcdefghijklmnop'), '.abcdefghijklmnop', 'sixteen characters still is');
  assert.equal(extensionForUploadName(encodeURIComponent('resume.pdf ')), '', 'a trailing space is not an extension');
  assert.equal(extensionForUploadName(encodeURIComponent('quarterly.p\u00e5')), '', 'a non ascii extension is dropped');
  assert.equal(extensionForUploadName('.gitignore'), '.gitignore');
  assert.equal(extensionForUploadName(undefined), null, 'an absent name is distinct from one with no extension');
  assert.equal(extensionForUploadName('%'), null);
});

test('exceedsUploadCap trips only past the cap', () => {
  assert.equal(MAX_UPLOAD_BYTES, 15 * 1024 * 1024);
  assert.equal(exceedsUploadCap(0), false);
  assert.equal(exceedsUploadCap(MAX_UPLOAD_BYTES), false, 'exactly the cap is still accepted');
  assert.equal(exceedsUploadCap(MAX_UPLOAD_BYTES + 1), true);
  assert.equal(exceedsUploadCap(11, 10), true, 'the cap is overridable for tests');
});

test('buildUploadFilename is Windows-safe, sorts by time, and carries no client string', () => {
  const name = buildUploadFilename({
    now: Date.UTC(2026, 7, 9, 12, 30, 15, 123),
    randomSuffix: 'a1b2c3d4',
    extension: '.png',
  });
  assert.equal(name, '2026-08-09T12-30-15-123Z-a1b2c3d4.png');
  assert.equal(/[:*?"<>|/\\]/.test(name), false, 'no character Windows refuses in a filename');

  const later = buildUploadFilename({
    now: Date.UTC(2026, 7, 9, 12, 30, 16, 0),
    randomSuffix: 'a1b2c3d4',
    extension: '.png',
  });
  assert.equal([later, name].sort().at(-1), later, 'later uploads sort last');
});

test('framePathPaste wraps the path in bracketed paste with a trailing space and no submit', () => {
  const framed = framePathPaste('/home/op/.glissa/uploads/s1/2026-08-09T12-30-15-123Z-ab.png');
  assert.equal(
    framed,
    '\x1b[200~/home/op/.glissa/uploads/s1/2026-08-09T12-30-15-123Z-ab.png \x1b[201~',
  );
  assert.equal(framed.includes('\r'), false, 'never submits the prompt for the operator');
  assert.equal(framed.includes('\n'), false);
  assert.equal(framed.endsWith(' \x1b[201~'), true, 'the operator can type words right after the path');
});

test('isSafePathSegment refuses anything that could climb out of the uploads root', () => {
  assert.equal(isSafePathSegment('9f1c0f2a-1c3d-4a5b-9f00-abcdef012345'), true);
  assert.equal(isSafePathSegment('..'), false);
  assert.equal(isSafePathSegment('.'), false);
  assert.equal(isSafePathSegment('../etc'), false);
  assert.equal(isSafePathSegment('a/b'), false);
  assert.equal(isSafePathSegment('a\\b'), false);
  assert.equal(isSafePathSegment(''), false);
  assert.equal(isSafePathSegment(null), false);
});

test('planUploadRetention keeps the newest files and never the one just written', () => {
  assert.equal(UPLOAD_RETAIN_FILES, 20);
  const names: string[] = [];
  for (let i = 0; i < 23; i += 1) {
    names.push(`2026-08-09T12-00-${String(i).padStart(2, '0')}-000Z-aabbccdd.png`);
  }
  const justWritten = names.at(-1);
  assert.ok(justWritten);
  const doomed = planUploadRetention(names, { justWritten });
  assert.equal(doomed.length, 3, '23 files, 20 kept');
  assert.deepEqual(doomed.slice().sort(), names.slice(0, 3), 'the three oldest go');
  assert.equal(doomed.includes(justWritten), false);
});

test('planUploadRetention counts a just-written file the directory listing has not caught up with', () => {
  const names = ['2026-08-09T12-00-00-000Z-aaaaaaaa.png', '2026-08-09T12-00-01-000Z-bbbbbbbb.png'];
  const doomed = planUploadRetention(names, { keep: 2, justWritten: '2026-08-09T12-00-02-000Z-cccccccc.png' });
  assert.deepEqual(doomed, ['2026-08-09T12-00-00-000Z-aaaaaaaa.png']);
});

test('planUploadRetention ignores non-upload entries and an under-cap directory', () => {
  const names = ['notes.txt', 'sub-dir', '2026-08-09T12-00-00-000Z-aabbccdd.png'];
  assert.deepEqual(planUploadRetention(names, { keep: 1 }), []);
  assert.deepEqual(planUploadRetention([], {}), []);
  assert.deepEqual(planUploadRetention(null, {}), []);
});

test('isUploadFilename recognises what buildUploadFilename writes and refuses a foreign neighbour', () => {
  assert.equal(isUploadFilename('2026-08-09T12-30-15-123Z-a1b2c3d4.png'), true);
  assert.equal(isUploadFilename('2026-08-09T12-30-15-123Z-a1b2c3d4.pdf'), true);
  assert.equal(isUploadFilename('2026-08-09T12-30-15-123Z-a1b2c3d4'), true, 'an extensionless upload is still ours');
  assert.equal(
    isUploadFilename(buildUploadFilename({ now: Date.UTC(2026, 7, 9, 12, 30, 15, 123), randomSuffix: 'a1b2c3d4', extension: '' })),
    true,
  );
  assert.equal(isUploadFilename('notes.pdf'), false);
  assert.equal(isUploadFilename('2026-08-09T12-30-15-123Z-a1b2c3d4.png.bak'), false);
  assert.equal(isUploadFilename('2026-08-09T12-30-15-123Z-zzzzzzzz.png'), false, 'the suffix is hex');
  assert.equal(isUploadFilename('2026-08-09T12-30-15-123Z-a1b2c3d.png'), false, 'the suffix is eight characters');
  assert.equal(isUploadFilename(null), false);
});

test('planUploadRetention sweeps non-image uploads and never a foreign file in the directory', () => {
  const names: string[] = ['keep-me.pdf', 'notes.txt'];
  for (let i = 0; i < 22; i += 1) {
    names.push(`2026-08-09T12-00-${String(i).padStart(2, '0')}-000Z-aabbccdd.pdf`);
  }
  names.push('2026-08-09T12-00-30-000Z-aabbccdd');
  const doomed = planUploadRetention(names, { justWritten: '2026-08-09T12-00-30-000Z-aabbccdd' });
  assert.equal(doomed.length, 3, '23 uploads, 20 kept');
  assert.deepEqual(doomed.slice().sort(), [
    '2026-08-09T12-00-00-000Z-aabbccdd.pdf',
    '2026-08-09T12-00-01-000Z-aabbccdd.pdf',
    '2026-08-09T12-00-02-000Z-aabbccdd.pdf',
  ]);
  assert.equal(doomed.includes('keep-me.pdf'), false, 'a file the operator put there is never swept');
  assert.equal(doomed.includes('notes.txt'), false);
});
