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
  DEFAULT_AGENT_TTL_MS,
  DEFAULT_TEAMMATE_TASK_TTL_MS,
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

test('declaredActiveCount: a weak (shell/monitor) entry counts fresh and stops counting past the weak TTL; a teammate entry keeps counting', () => {
  const entries = [{ id: 'b1', type: 'shell' }, { id: 't1', type: 'teammate' }];
  const idleIds = new Set();
  assert.equal(declaredActiveCount(entries, idleIds, 0, 100), 2, 'both count when fresh');
  assert.equal(declaredActiveCount(entries, idleIds, 99, 100), 2, 'still under the ttl');
  assert.equal(declaredActiveCount(entries, idleIds, 100, 100), 1, 'the shell entry stops counting at the ttl boundary; the teammate still counts');
});

test('declaredActiveCount: dream entries never gate, alone or mixed with gating entries', () => {
  assert.equal(declaredActiveCount([{ id: 'd1', type: 'dream' }], new Set()), 0, 'a lone dream entry never gates');
  const mixed = [{ id: 'd1', type: 'dream' }, { id: 'b1', type: 'shell' }];
  assert.equal(declaredActiveCount(mixed, new Set()), 1, 'the dream entry is skipped; the shell entry still gates');
});

test('declaredActiveCount: idleNameCount subtracts from surviving teammate-type entries', () => {
  const entries = [{ id: 't1', type: 'teammate' }, { id: 't2', type: 'teammate' }, { id: 't3', type: 'teammate' }];
  assert.equal(declaredActiveCount(entries, new Set(), 0, undefined, 0), 3, 'no idle names, nothing subtracted');
  assert.equal(declaredActiveCount(entries, new Set(), 0, undefined, 1), 2, 'one idle name drains one teammate');
  assert.equal(declaredActiveCount(entries, new Set(), 0, undefined, 3), 0, 'all three idle names drain all three teammates');
});

test('declaredActiveCount: idleNameCount is clamped to the surviving teammate count (a stale name cannot mask a shell/subagent entry)', () => {
  const entries = [
    { id: 't1', type: 'teammate' },
    { id: 't2', type: 'teammate' },
    { id: 'b1', type: 'shell' },
  ];
  // idleNameCount=5 but only 2 teammate entries exist: clamp to 2, leaving the shell entry.
  assert.equal(declaredActiveCount(entries, new Set(), 0, undefined, 5), 1);
});

test('DEFAULT_TEAMMATE_TASK_TTL_MS is a sane positive default', () => {
  assert.equal(typeof DEFAULT_TEAMMATE_TASK_TTL_MS, 'number');
  assert.ok(DEFAULT_TEAMMATE_TASK_TTL_MS > 0);
});

test('declaredActiveCount: a teammate entry counts fresh and stops counting past teammateTtlMs', () => {
  const entries = [{ id: 't1', type: 'teammate' }];
  const idleIds = new Set();
  assert.equal(declaredActiveCount(entries, idleIds, 0, undefined, 0, 100), 1, 'counts when fresh');
  assert.equal(declaredActiveCount(entries, idleIds, 99, undefined, 0, 100), 1, 'still under the ttl');
  assert.equal(declaredActiveCount(entries, idleIds, 100, undefined, 0, 100), 0, 'stops counting at the ttl boundary');
});

test('declaredActiveCount: an aged-out teammate does not absorb the idleNameCount clamp, leaving a shell entry counted', () => {
  const entries = [{ id: 't1', type: 'teammate' }, { id: 'b1', type: 'shell' }];
  // ageMs=200 ages out the teammate (teammateTtlMs=100) but is well under the weak ttl (default 5min),
  // so the shell entry still counts. The aged-out teammate must not be in teammateCount, so the idle
  // name (which no longer matches any surviving teammate) cannot wrongly subtract from the shell entry.
  assert.equal(declaredActiveCount(entries, new Set(), 200, undefined, 1, 100), 1, 'the shell entry survives; the stale idle name has nothing to clamp against');
});

test('declaredActiveCount: dream + weak-ttl + id-drain + idleNameCount compose correctly', () => {
  const entries = [
    { id: 'd1', type: 'dream' },        // never gates
    { id: 'b1', type: 'shell' },        // past weak ttl: drops out
    { id: 't1', type: 'teammate' },     // id-drained
    { id: 't2', type: 'teammate' },     // survives, then subtracted by idleNameCount
    { id: 'x1', type: 'subagent' },     // survives, always gates
  ];
  const idleIds = new Set(['t1']);
  // ageMs=100 >= weakTtlMs=100 drops the shell entry; one idle name drains t2, leaving x1.
  assert.equal(declaredActiveCount(entries, idleIds, 100, 100, 1), 1);
});
