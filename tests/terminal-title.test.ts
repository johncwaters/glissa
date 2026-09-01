import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTitleSequence, buildTitleClearSequence } from '../server/core/terminal-title.ts';

test('buildTitleSequence returns an OSC 0 title sequence', () => {
  assert.equal(buildTitleSequence('glissa :3000'), '\x1b]0;glissa :3000\x07');
});

test('buildTitleClearSequence returns an empty OSC 0 title sequence', () => {
  assert.equal(buildTitleClearSequence(), '\x1b]0;\x07');
});
