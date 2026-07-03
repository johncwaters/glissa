'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractVerdictToken, parseVerdict } = require('../teamlib/verdict');

test('extractVerdictToken finds the default VERDICT: marker case-insensitively', () => {
  assert.equal(extractVerdictToken('reviewed.\nverdict: ship\n'), 'SHIP');
  assert.equal(extractVerdictToken('VERDICT:FIX'), 'FIX');
  assert.equal(extractVerdictToken('no marker here'), null);
  assert.equal(extractVerdictToken(''), null);
  assert.equal(extractVerdictToken(null), null);
});

test('extractVerdictToken honors a custom marker', () => {
  assert.equal(extractVerdictToken('DECISION: BLOCK', 'DECISION:'), 'BLOCK');
  assert.equal(extractVerdictToken('VERDICT: BLOCK', 'DECISION:'), null);
});

test('extractVerdictToken is unrestricted on the token itself (loose scan)', () => {
  assert.equal(extractVerdictToken('VERDICT: Whatever'), 'WHATEVER');
});

test('parseVerdict gates the found token against verdictSpec.values', () => {
  const spec = { marker: 'VERDICT:', values: ['SHIP', 'FIX', 'BLOCK'] };
  assert.equal(parseVerdict('Reviewed.\nVERDICT: SHIP\n', spec), 'SHIP');
  assert.equal(parseVerdict('Reviewed.\nVERDICT: MAYBE\n', spec), null);
  assert.equal(parseVerdict('no marker', spec), null);
});

test('parseVerdict defaults marker and values when verdictSpec omits them', () => {
  assert.equal(parseVerdict('VERDICT: FIX', {}), 'FIX');
  assert.equal(parseVerdict('VERDICT: NOPE', {}), null);
});

test('parseVerdict returns null for empty text or a missing verdictSpec', () => {
  assert.equal(parseVerdict('', { marker: 'VERDICT:' }), null);
  assert.equal(parseVerdict('VERDICT: SHIP', null), null);
});
