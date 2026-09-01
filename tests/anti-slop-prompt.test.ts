// Unit tests for Lever B (session/core/anti-slop-prompt.js): the fixed preventive note
// and its spawn-arg helper. No literal em/en dash in this file (dash-literals-roundtrip).

import test from 'node:test';
import assert from 'node:assert/strict';

import { ANTI_SLOP_NOTE, buildAntiSlopArgs } from '../session/core/anti-slop-prompt.ts';

const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const ELLIPSIS = String.fromCharCode(0x2026);

test('buildAntiSlopArgs returns the append-system-prompt pair only when enabled', () => {
  assert.deepEqual(buildAntiSlopArgs(true), ['--append-system-prompt', ANTI_SLOP_NOTE]);
  assert.deepEqual(buildAntiSlopArgs(false), []);
  assert.deepEqual(buildAntiSlopArgs(undefined), []);
});

test('ANTI_SLOP_NOTE is a single compact line with no forbidden glyphs', () => {
  assert.equal(typeof ANTI_SLOP_NOTE, 'string');
  assert.ok(ANTI_SLOP_NOTE.length > 0);
  assert.equal(ANTI_SLOP_NOTE.includes('\n'), false); // single line (shim-safe)
  assert.equal(ANTI_SLOP_NOTE.includes('"'), false); // no double-quotes (cmd.exe shim-safe)
  assert.equal(ANTI_SLOP_NOTE.includes(EM_DASH), false);
  assert.equal(ANTI_SLOP_NOTE.includes(EN_DASH), false);
  assert.equal(ANTI_SLOP_NOTE.includes(ELLIPSIS), false);
});
