'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// perf-corpus is ESM (.mjs); dynamic-import it from this CJS test file.
const importCorpus = () => import('../public/perf-corpus.mjs');

test('generateCorpus is deterministic for a seed', async () => {
  const { generateCorpus } = await importCorpus();
  assert.equal(generateCorpus(50, 7), generateCorpus(50, 7));
  assert.notEqual(generateCorpus(50, 7), generateCorpus(50, 8));
});

test('generateCorpus is SGR/cursor-dense with CRLF lines', async () => {
  const { generateCorpus } = await importCorpus();
  const s = generateCorpus(50, 3);
  const escapes = (s.match(/\x1b\[/g) || []).length;
  assert.ok(escapes > 50 * 4, `expected dense escapes, got ${escapes}`);
  assert.ok(s.includes('\r\n'), 'CRLF line breaks present');
  assert.equal(s.match(/\r\n/g).length, 50, 'one CRLF per line');
});

test('generateCorpus scales with line count', async () => {
  const { generateCorpus } = await importCorpus();
  assert.ok(generateCorpus(200, 1).length > generateCorpus(50, 1).length);
});
