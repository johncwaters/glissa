import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STAMP_HASH_CHARS,
  buildStampLine,
  needsDistill,
  normalizeStampSources,
  parseStampLine,
  shortHash,
} from '../server/core/distill-core.ts';

const SOURCES = [
  { path: 'AGENTS.md', sha256: 'a'.repeat(64) },
  { path: 'docs/plan.md', sha256: 'b'.repeat(64) },
];

function fileWith(stampLine: string, body = 'the distilled brief\n') {
  return `${stampLine}\n\n${body}`;
}

test('a stamp round-trips through parse, hashes truncated to the stamped length', () => {
  const parsed = parseStampLine(fileWith(buildStampLine(SOURCES)));
  assert.deepEqual(parsed?.sources, [
    { path: 'AGENTS.md', sha256: 'a'.repeat(STAMP_HASH_CHARS) },
    { path: 'docs/plan.md', sha256: 'b'.repeat(STAMP_HASH_CHARS) },
  ]);
});

test('the stamp is one line, and identical for the same sources in any order', () => {
  const line = buildStampLine(SOURCES);
  assert.equal(line.includes('\n'), false);
  assert.equal(buildStampLine([...SOURCES].reverse()), line);
  assert.equal(buildStampLine(SOURCES.map((s) => ({ ...s, sha256: shortHash(s.sha256) }))), line);
});

test('a source added, removed, or edited changes the stamp', () => {
  const base = buildStampLine(SOURCES);
  assert.notEqual(buildStampLine([SOURCES[0]]), base);
  assert.notEqual(buildStampLine([...SOURCES, { path: 'docs/new.md', sha256: 'c'.repeat(64) }]), base);
  assert.notEqual(buildStampLine([{ ...SOURCES[0], sha256: 'd'.repeat(64) }, SOURCES[1]]), base);
});

test('the stamp ignores extra keys on a source record, so the builder can carry fullPath', () => {
  const withFullPath = SOURCES.map((s) => ({ ...s, fullPath: `C:/repo/${s.path}` }));
  assert.equal(buildStampLine(withFullPath), buildStampLine(SOURCES));
});

test('parseStampLine only reads line 1, and rejects anything that is not a stamp', () => {
  assert.equal(parseStampLine(`# Brief\n${buildStampLine(SOURCES)}\n`), null, 'stamp on line 2 does not count');
  assert.equal(parseStampLine(''), null);
  assert.equal(parseStampLine(null), null);
  assert.equal(parseStampLine('<!-- glissa-distill v1 not json -->\n'), null);
  assert.equal(parseStampLine('<!-- glissa-distill v1 {"path":"a"} -->\n'), null, 'payload must be an array');
  assert.equal(parseStampLine('<!-- glissa-distill v1 ["AGENTS.md"] -->\n'), null, 'entries must be records');
  assert.equal(parseStampLine('<!-- some other comment -->\n'), null);
});

test('parseStampLine tolerates a CRLF line ending', () => {
  const parsed = parseStampLine(`${buildStampLine(SOURCES)}\r\n\r\nbody\r\n`);
  assert.equal(parsed?.sources.length, 2);
});

test('normalizeStampSources drops junk records and dedupes by path', () => {
  const normalized = normalizeStampSources([
    { path: 'a.md', sha256: '1'.repeat(64) },
    { path: 'a.md', sha256: '2'.repeat(64) },
    { path: 'b.md' },
    null,
    'nope',
  ]);
  assert.deepEqual(normalized, [{ path: 'a.md', sha256: '2'.repeat(STAMP_HASH_CHARS) }]);
});

test('needsDistill: a missing output is stale', () => {
  assert.deepEqual(needsDistill(SOURCES, null), { stale: true, reason: 'output file is missing' });
  assert.equal(needsDistill(SOURCES, '').stale, true);
});

test('needsDistill: an output with no stamp is stale', () => {
  const result = needsDistill(SOURCES, '# Brief\n\nno stamp here\n');
  assert.equal(result.stale, true);
  assert.match(result.reason as string, /no distill stamp/);
});

test('needsDistill: a stamp matching the current sources is current', () => {
  assert.deepEqual(needsDistill(SOURCES, fileWith(buildStampLine(SOURCES))), { stale: false, reason: null });
});

test('needsDistill: an edited, added, or removed source is stale', () => {
  const stamped = fileWith(buildStampLine(SOURCES));
  const edited = [{ ...SOURCES[0], sha256: 'f'.repeat(64) }, SOURCES[1]];
  assert.match(needsDistill(edited, stamped).reason as string, /sources changed/);
  assert.equal(needsDistill([SOURCES[0]], stamped).stale, true);
  assert.equal(needsDistill([...SOURCES, { path: 'docs/new.md', sha256: 'c'.repeat(64) }], stamped).stale, true);
});

test('needsDistill: a full-length hash in the stamp still compares equal to a truncated one', () => {
  const longStamp = `<!-- glissa-distill v1 ${JSON.stringify(SOURCES)} -->`;
  assert.equal(needsDistill(SOURCES, fileWith(longStamp)).stale, false);
});
