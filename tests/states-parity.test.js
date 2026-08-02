'use strict';

// shared/states.js (CJS) and shared/states.esm.js (ESM) are hand-duplicated mirrors with
// nothing else catching drift between them. This locks them to deep-equal values.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const cjs = require('../shared/states');

// states.esm.js has a plain .js extension (Vite aliases /shared/states.mjs to it for the
// browser), so this package's "type": "commonjs" makes a normal import() of the path treat it
// as CJS and choke on `export`. Load its source as a data: URL instead, which Node's ESM
// loader always treats as a module regardless of the origin file's extension.
function importEsm() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'shared', 'states.esm.js'), 'utf8');
  const dataUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  return import(dataUrl);
}

test('CJS and ESM states mirrors export the same keys', async () => {
  const esm = await importEsm();
  assert.deepEqual(Object.keys(cjs).sort(), Object.keys(esm).filter((k) => k !== 'default').sort());
});

test('STATES match between CJS and ESM', async () => {
  const esm = await importEsm();
  assert.deepEqual(cjs.STATES, esm.STATES);
});

test('BADGE_LABELS match between CJS and ESM', async () => {
  const esm = await importEsm();
  assert.deepEqual(cjs.BADGE_LABELS, esm.BADGE_LABELS);
});

test('STATE_GLYPHS match between CJS and ESM', async () => {
  const esm = await importEsm();
  assert.deepEqual(cjs.STATE_GLYPHS, esm.STATE_GLYPHS);
});

test('KILLABLE_STATES match between CJS and ESM', async () => {
  const esm = await importEsm();
  assert.deepEqual(cjs.KILLABLE_STATES, esm.KILLABLE_STATES);
});

test('RESTARTABLE_STATES match between CJS and ESM', async () => {
  const esm = await importEsm();
  assert.deepEqual(cjs.RESTARTABLE_STATES, esm.RESTARTABLE_STATES);
});

test('MERGEABLE_LIVE_STATES match between CJS and ESM', async () => {
  const esm = await importEsm();
  assert.deepEqual(cjs.MERGEABLE_LIVE_STATES, esm.MERGEABLE_LIVE_STATES);
});
