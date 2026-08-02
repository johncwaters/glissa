'use strict';

// Unit tests for agent-tracker.evictDepartedTeammateNames (the departed-teammate-name
// eviction that drains the completion gate when a declared teammate id disappears).

const test = require('node:test');
const assert = require('node:assert/strict');

const { evictDepartedTeammateNames } = require('../session/core/agent-tracker');

test('no departure: idle names and declared ids survive untouched', () => {
  const idleNames = new Map([['alice', 100]]);
  const declaredIds = new Set(['t1', 't2']);
  const entries = [
    { id: 't1', type: 'teammate' },
    { id: 't2', type: 'teammate' },
  ];
  const next = evictDepartedTeammateNames(idleNames, declaredIds, entries);
  assert.deepEqual([...idleNames.keys()], ['alice']);
  assert.deepEqual(next, new Set(['t1', 't2']));
});

test('one teammate departs: evicts the single oldest idle name', () => {
  const idleNames = new Map([
    ['alice', 100],
    ['bob', 200],
  ]);
  const declaredIds = new Set(['t1', 't2']);
  // t2 is gone from this snapshot -> one departure -> evict the oldest (alice, inserted first).
  const entries = [{ id: 't1', type: 'teammate' }];
  const next = evictDepartedTeammateNames(idleNames, declaredIds, entries);
  assert.deepEqual([...idleNames.keys()], ['bob']);
  assert.deepEqual(next, new Set(['t1']));
});

test('multiple departures evict that many oldest names, stopping once the idle map is empty', () => {
  const idleNames = new Map([['alice', 100]]);
  const declaredIds = new Set(['t1', 't2', 't3']);
  // t1, t2, t3 all gone -> 3 departures, but only one idle name exists to evict.
  const entries = [];
  const next = evictDepartedTeammateNames(idleNames, declaredIds, entries);
  assert.deepEqual([...idleNames.keys()], []);
  assert.deepEqual(next, new Set());
});

test('non-teammate and id-less entries are excluded from the current-teammate-id set', () => {
  const idleNames = new Map();
  const declaredIds = new Set(['t1']);
  const entries = [
    { id: 't1', type: 'teammate' },
    { id: 's1', type: 'shell' },
    { type: 'teammate' }, // no id: ignored
  ];
  const next = evictDepartedTeammateNames(idleNames, declaredIds, entries);
  assert.deepEqual(next, new Set(['t1']));
});

test('returns the current declared-teammate-id set even when idleTeammateNames is already empty', () => {
  const idleNames = new Map();
  const declaredIds = new Set(['t1']);
  const entries = [{ id: 't2', type: 'teammate' }];
  const next = evictDepartedTeammateNames(idleNames, declaredIds, entries);
  assert.deepEqual(next, new Set(['t2']));
  assert.equal(idleNames.size, 0);
});
