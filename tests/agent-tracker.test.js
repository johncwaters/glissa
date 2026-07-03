'use strict';

// Unit tests for the pure background sub-agent bookkeeping (session-core/agent-tracker.js).

const test = require('node:test');
const assert = require('node:assert/strict');

const { addAgent, removeAgent, pruneAgents, extractBackgroundTaskCount, DEFAULT_AGENT_TTL_MS } = require('../session-core/agent-tracker');

test('addAgent adds a new id and reports the change; a duplicate is idempotent (count unchanged, ts refreshed)', () => {
  const m = new Map();
  assert.equal(addAgent(m, 'a1', 1000), true);
  assert.equal(m.size, 1);
  assert.equal(addAgent(m, 'a1', 2000), false);
  assert.equal(m.size, 1);
  assert.equal(m.get('a1'), 2000);
});

test('addAgent ignores a missing id', () => {
  const m = new Map();
  assert.equal(addAgent(m, undefined, 1), false);
  assert.equal(addAgent(m, '', 1), false);
  assert.equal(m.size, 0);
});

test('removeAgent removes a known id; an unknown or missing id is a no-op', () => {
  const m = new Map([['a1', 1]]);
  assert.equal(removeAgent(m, 'a1'), true);
  assert.equal(m.size, 0);
  assert.equal(removeAgent(m, 'nope'), false);
  assert.equal(removeAgent(m, undefined), false);
});

test('pruneAgents drops only entries at or past the ttl, returns the count removed', () => {
  const now = 100000;
  const ttl = 1000;
  const m = new Map([
    ['old', now - ttl],       // exactly ttl old -> pruned (>=)
    ['older', now - ttl - 1], // pruned
    ['fresh', now - 500],     // kept
  ]);
  const removed = pruneAgents(m, now, ttl);
  assert.equal(removed, 2);
  assert.deepEqual([...m.keys()], ['fresh']);
});

test('DEFAULT_AGENT_TTL_MS is a sane positive default', () => {
  assert.equal(typeof DEFAULT_AGENT_TTL_MS, 'number');
  assert.ok(DEFAULT_AGENT_TTL_MS > 0);
});

test('extractBackgroundTaskCount reads array and numeric shapes, null otherwise', () => {
  assert.equal(extractBackgroundTaskCount({ background_tasks: [] }), 0);
  assert.equal(extractBackgroundTaskCount({ background_tasks: [{ id: 'b1' }, { id: 'b2' }] }), 2);
  assert.equal(extractBackgroundTaskCount({ background_tasks: 3 }), 3);
  assert.equal(extractBackgroundTaskCount({ background_tasks: 0 }), 0);
  // Absent/unrecognized (older Claude versions) -> null so the caller falls back to counting.
  assert.equal(extractBackgroundTaskCount({}), null);
  assert.equal(extractBackgroundTaskCount(null), null);
  assert.equal(extractBackgroundTaskCount({ background_tasks: 'two' }), null);
  assert.equal(extractBackgroundTaskCount({ background_tasks: -1 }), null);
  assert.equal(extractBackgroundTaskCount({ background_tasks: Number.NaN }), null);
});

test('extractBackgroundTaskCount ignores settled entries (idle teammate must not gate completion)', () => {
  assert.equal(extractBackgroundTaskCount({ background_tasks: [{ id: 'b1', status: 'running' }, { id: 'tm', status: 'idle' }] }), 1);
  assert.equal(extractBackgroundTaskCount({ background_tasks: [{ id: 'tm', status: 'completed' }] }), 0);
  assert.equal(extractBackgroundTaskCount({ background_tasks: [{ id: 'tm', status: 'IDLE' }] }), 0);
  // Deny-list, not allow-list: an unknown status still counts as running (err toward suppression).
  assert.equal(extractBackgroundTaskCount({ background_tasks: [{ id: 'x', status: 'starting' }] }), 1);
  assert.equal(extractBackgroundTaskCount({ background_tasks: [{ id: 'x' }] }), 1);
});

test('extractBackgroundTaskCount reads the object shape { count, tasks } (claude-code#33310)', () => {
  assert.equal(extractBackgroundTaskCount({ background_tasks: { count: 2, tasks: [{ id: 'b1', status: 'running' }, { id: 'tm', status: 'idle' }] } }), 1, 'filtered tasks beat the raw count');
  assert.equal(extractBackgroundTaskCount({ background_tasks: { count: 0, tasks: [] } }), 0);
  assert.equal(extractBackgroundTaskCount({ background_tasks: { count: 2 } }), 2);
  assert.equal(extractBackgroundTaskCount({ background_tasks: { count: -1 } }), null);
  assert.equal(extractBackgroundTaskCount({ background_tasks: {} }), null);
});
