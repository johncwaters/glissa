'use strict';

// Unit tests for the pure background sub-agent bookkeeping (session/core/agent-tracker.js).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  addAgent,
  removeAgent,
  pruneAgents,
  extractBackgroundTasks,
  declaredActiveCount,
  soleActiveTeammateId,
  drainPendingTeammateIdles,
  DEFAULT_AGENT_TTL_MS,
} = require('../session/core/agent-tracker');

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

test('extractBackgroundTasks reads the array shape only (hooks never send other shapes)', () => {
  assert.deepEqual(extractBackgroundTasks({ background_tasks: [] }), []);
  assert.deepEqual(
    extractBackgroundTasks({ background_tasks: [{ id: 'b1', type: 'shell', status: 'running' }] }),
    [{ id: 'b1', type: 'shell' }],
  );
  assert.deepEqual(extractBackgroundTasks({ background_tasks: [{}] }), [{ id: null, type: null }]);
  // Absent/unrecognized (older Claude versions, non-hook shapes) -> null so the caller
  // falls back to the counted map alone. The { count, tasks } shape (claude-code#33310)
  // is a statusLine surface, never sent to hooks: deliberately unparsed.
  assert.equal(extractBackgroundTasks({}), null);
  assert.equal(extractBackgroundTasks(null), null);
  assert.equal(extractBackgroundTasks({ background_tasks: 3 }), null);
  assert.equal(extractBackgroundTasks({ background_tasks: { count: 2, tasks: [] } }), null);
});

test('extractBackgroundTasks drops settled entries (defensive; emitter pre-filters to running|pending)', () => {
  const entries = extractBackgroundTasks({
    background_tasks: [
      { id: 'b1', type: 'shell', status: 'running' },
      { id: 'tm', type: 'teammate', status: 'idle' },
      { id: 'tm2', type: 'teammate', status: 'IDLE' },
      // Deny-list, not allow-list: an unknown status still counts as running.
      { id: 'x', type: 'subagent', status: 'starting' },
    ],
  });
  assert.deepEqual(entries, [{ id: 'b1', type: 'shell' }, { id: 'x', type: 'subagent' }]);
});

test('declaredActiveCount filters out-of-band idled ids; an id-less entry always counts', () => {
  const entries = [{ id: 'a', type: 'teammate' }, { id: null, type: 'shell' }, { id: 'b', type: 'shell' }];
  assert.equal(declaredActiveCount(entries, new Set()), 3);
  assert.equal(declaredActiveCount(entries, new Set(['a'])), 2);
  assert.equal(declaredActiveCount(entries, new Set(['a', 'b'])), 1);
  assert.equal(declaredActiveCount(null, new Set(['a'])), 0);
});

test('soleActiveTeammateId returns the single unambiguous live teammate id, else null', () => {
  assert.equal(soleActiveTeammateId([{ id: 't1', type: 'teammate' }], new Set()), 't1');
  assert.equal(soleActiveTeammateId([{ id: 't1', type: 'teammate' }, { id: 'b1', type: 'shell' }], new Set()), 't1');
  assert.equal(soleActiveTeammateId([{ id: 't1', type: 'teammate' }, { id: 't2', type: 'teammate' }], new Set()), null, 'two live teammates is ambiguous');
  assert.equal(soleActiveTeammateId([{ id: 't1', type: 'teammate' }, { id: 't2', type: 'teammate' }], new Set(['t1'])), 't2', 'an already-idled teammate is excluded');
  assert.equal(soleActiveTeammateId(null, new Set()), null);
  assert.equal(soleActiveTeammateId([{ id: null, type: 'teammate' }], new Set()), null);
});

test('declaredActiveCount: a weak (shell/monitor) entry counts fresh and stops counting past the weak TTL; a teammate entry keeps counting', () => {
  const entries = [{ id: 'b1', type: 'shell' }, { id: 't1', type: 'teammate' }];
  const idleIds = new Set();
  assert.equal(declaredActiveCount(entries, idleIds, 0, 100), 2, 'both count when fresh');
  assert.equal(declaredActiveCount(entries, idleIds, 99, 100), 2, 'still under the ttl');
  assert.equal(declaredActiveCount(entries, idleIds, 100, 100), 1, 'the shell entry stops counting at the ttl boundary; the teammate still counts');
});

test('drainPendingTeammateIdles drains the sole live teammate against one pending entry', () => {
  const entries = [{ id: 't1', type: 'teammate' }];
  const idleIds = new Set();
  const pending = new Map([['x', 1000]]);
  const drained = drainPendingTeammateIdles(entries, idleIds, pending, 2000);
  assert.equal(drained, 1);
  assert.ok(idleIds.has('t1'));
  assert.equal(pending.size, 0);
});

test('drainPendingTeammateIdles expires stale pending entries without draining', () => {
  const entries = [{ id: 't1', type: 'teammate' }];
  const idleIds = new Set();
  const pending = new Map([['x', 1000]]);
  const drained = drainPendingTeammateIdles(entries, idleIds, pending, 10000, 5000); // 9000ms old, ttl 5000
  assert.equal(drained, 0);
  assert.equal(idleIds.size, 0);
  assert.equal(pending.size, 0, 'the stale entry is dropped, not retried');
});

test('drainPendingTeammateIdles is ambiguity-safe: two live teammates leaves the pending entry retained', () => {
  const entries = [{ id: 't1', type: 'teammate' }, { id: 't2', type: 'teammate' }];
  const idleIds = new Set();
  const pending = new Map([['x', 1000]]);
  const drained = drainPendingTeammateIdles(entries, idleIds, pending, 2000);
  assert.equal(drained, 0);
  assert.equal(idleIds.size, 0);
  assert.equal(pending.size, 1, 'nothing resolvable, so the pending entry is kept for a later retry');
});
