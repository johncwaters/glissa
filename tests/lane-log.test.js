'use strict';

// The one logger wrapper every lane and lane source shares (server/lane-log.js).

const test = require('node:test');
const assert = require('node:assert/strict');

const { createLaneLog } = require('../server/lane-log');

function capture(options = {}) {
  const notes = [];
  const warnings = [];
  const log = createLaneLog({
    prefix: '[ingest]',
    logger: { log: (message) => notes.push(message), warn: (message) => warnings.push(message) },
    ...options,
  });
  return { log, notes, warnings };
}

test('note and warn carry the prefix and go to their own logger channel', () => {
  const { log, notes, warnings } = capture();
  log.note('the git source started');
  log.warn('the git source disabled: no git');
  assert.deepEqual(notes, ['[ingest] the git source started']);
  assert.deepEqual(warnings, ['[ingest] the git source disabled: no git']);
});

// Every lane injects its own logger, and a partial one must not fault the caller.
test('a logger missing a channel silently drops that level', () => {
  const notes = [];
  const log = createLaneLog({ prefix: '[visions]', logger: { log: (message) => notes.push(message) } });
  log.warn('nowhere to go');
  log.note('kept');
  assert.deepEqual(notes, ['[visions] kept']);

  const silent = createLaneLog({ prefix: '[visions]', logger: null });
  silent.note('no logger at all');
  silent.warn('no logger at all');
});

test('debugNote is off by default and never builds the message it would have logged', () => {
  const { log, notes } = capture();
  let built = 0;
  log.debugNote(() => { built += 1; return 'expensive'; });
  assert.equal(built, 0, 'a line nobody wants costs no interpolation');
  assert.deepEqual(notes, []);
});

test('debugNote accepts a boolean flag or a getter, and the getter is read per line', () => {
  const fixed = capture({ debugFlag: true });
  fixed.log.debugNote(() => 'always on');
  assert.deepEqual(fixed.notes, ['[ingest] always on']);

  let live = false;
  const dynamic = capture({ debugFlag: () => live });
  dynamic.log.debugNote(() => 'before');
  live = true;
  dynamic.log.debugNote(() => 'after');
  assert.deepEqual(dynamic.notes, ['[ingest] after'], 'the setting moves while the lane stays up');
});

// A logging decision must never fault whatever it rode in on.
test('a debug getter that throws reads as off rather than propagating', () => {
  const { log, notes, warnings } = capture({ debugFlag: () => { throw new Error('settings unavailable'); } });
  assert.doesNotThrow(() => log.debugNote(() => 'suppressed'));
  assert.deepEqual(notes, []);
  assert.deepEqual(warnings, [], 'a failed debug check is not itself news');
});
