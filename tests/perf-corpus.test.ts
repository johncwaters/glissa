import test from 'node:test';
import assert from 'node:assert/strict';

import { generateCorpus } from '../public/perf-corpus.ts';

function countMatches(haystack: string, pattern: RegExp): number {
  return haystack.match(pattern)?.length ?? 0;
}

test('generateCorpus is deterministic for a seed', () => {
  assert.equal(generateCorpus(50, 7), generateCorpus(50, 7));
  assert.notEqual(generateCorpus(50, 7), generateCorpus(50, 8));
});

test('generateCorpus is SGR/cursor-dense with CRLF lines', () => {
  const corpus = generateCorpus(50, 3);
  const escapes = countMatches(corpus, /\x1b\[/g);
  assert.ok(escapes > 50 * 4, `expected dense escapes, got ${escapes}`);
  assert.ok(corpus.includes('\r\n'), 'CRLF line breaks present');
  assert.equal(countMatches(corpus, /\r\n/g), 50, 'one CRLF per line');
});

test('generateCorpus scales with line count', () => {
  assert.ok(generateCorpus(200, 1).length > generateCorpus(50, 1).length);
});
