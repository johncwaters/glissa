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
  msUntilNextDrain,
  createTaskRegistry,
  DEFAULT_AGENT_TTL_MS,
  DEFAULT_SHELL_TASK_TTL_MS,
  DEFAULT_TEAMMATE_TASK_TTL_MS,
} = require('../session/core/agent-tracker');

test('an unknown SubagentStop leaves turn evidence that zero reconciliation cannot erase', () => {
  let now = 1000;
  const registry = createTaskRegistry({ now: () => now, agentTtlMs: 100 });
  assert.equal(registry.noteAgentStop('lost-start'), false);
  assert.equal(registry.hasOrphanStopEvidence(), true);
  registry.reconcileDeclared([]);
  assert.equal(registry.hasOrphanStopEvidence(), true);
  registry.resetTurnEvidence();
  assert.equal(registry.hasOrphanStopEvidence(), false);

  registry.noteAgentStop('another-lost-start');
  now += 100;
  assert.equal(registry.hasOrphanStopEvidence(), false, 'the agent TTL bounds an abandoned turn');
});

test('a duplicate stop for an agent started this turn is not orphan evidence', () => {
  const registry = createTaskRegistry({ now: () => 1000 });
  registry.noteAgentStart('known', 1000);
  registry.noteAgentStop('known');
  registry.noteAgentStop('known');
  assert.equal(registry.hasOrphanStopEvidence(), false);
});

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

test('the default shell task TTL covers a forty-minute external agent run', () => {
  const entries = [{ id: 'b1', type: 'shell' }];
  assert.equal(declaredActiveCount(entries, new Set(), 40 * 60 * 1000), 1);
  assert.equal(declaredActiveCount(entries, new Set(), DEFAULT_SHELL_TASK_TTL_MS), 0);
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
  // ageMs=200 ages out the teammate (teammateTtlMs=100) but is well under the default weak ttl,
  // so the shell entry still counts. The aged-out teammate must not be in teammateCount, so the idle
  // name (which no longer matches any surviving teammate) cannot wrongly subtract from the shell entry.
  assert.equal(declaredActiveCount(entries, new Set(), 200, undefined, 1, 100), 1, 'the shell entry survives; the stale idle name has nothing to clamp against');
});

// --- msUntilNextDrain: what a gate timer should wait when background work is still gating.
// The whole point is that TTLs age from the timestamp that created them, not from "now".

const TTLS = { agentTtlMs: 30 * 60 * 1000, weakTtlMs: 5 * 60 * 1000, teammateTtlMs: 90 * 1000 };

test('msUntilNextDrain: a declared teammate snapshot 60s into a 90s TTL has 30s left, not a fresh 90s', () => {
  const now = 1000000;
  const ms = msUntilNextDrain({
    declaredEntries: [{ id: 'tm1', type: 'teammate' }],
    declaredTs: now - 60000,
    now,
    ...TTLS,
  });
  assert.equal(ms, 30000);
});

test('msUntilNextDrain: picks the sooner of a weak entry and a teammate entry in the same snapshot', () => {
  const now = 1000000;
  const entries = [{ id: 'b1', type: 'shell' }, { id: 'tm1', type: 'teammate' }];
  assert.equal(
    msUntilNextDrain({ declaredEntries: entries, declaredTs: now, now, ...TTLS }),
    TTLS.teammateTtlMs,
    'the 90s teammate ttl expires before the 5min weak ttl',
  );
  assert.equal(
    msUntilNextDrain({ declaredEntries: entries, declaredTs: now, now, ...TTLS, teammateTtlMs: 10 * 60 * 1000 }),
    TTLS.weakTtlMs,
    'with a longer teammate ttl the weak entry becomes the next drain',
  );
});

test('msUntilNextDrain: a shell task can outlive the generic agent TTL', () => {
  const now = 1000000;
  const weakTtlMs = 60 * 60 * 1000;
  assert.equal(msUntilNextDrain({
    declaredEntries: [{ id: 'b1', type: 'shell' }],
    declaredTs: now,
    now,
    ...TTLS,
    weakTtlMs,
  }), weakTtlMs);
});

test('msUntilNextDrain: an untyped declared entry only drains when the whole snapshot ages out', () => {
  const now = 1000000;
  const ms = msUntilNextDrain({
    declaredEntries: [{ id: 'x1', type: 'subagent' }],
    declaredTs: now - 1000,
    now,
    ...TTLS,
  });
  assert.equal(ms, TTLS.agentTtlMs - 1000);
});

test('msUntilNextDrain: counted-only uses the OLDEST counted ts plus the agent TTL', () => {
  const now = 1000000;
  const counted = new Map([['a1', now - 5000], ['a2', now - 60000], ['a3', now - 100]]);
  const ms = msUntilNextDrain({ countedAgents: counted, now, ...TTLS });
  assert.equal(ms, TTLS.agentTtlMs - 60000);
});

test('msUntilNextDrain: the counted map and the declared snapshot are compared against each other', () => {
  const now = 1000000;
  const ms = msUntilNextDrain({
    countedAgents: new Map([['a1', now - 29 * 60 * 1000]]), // ~1min of agent ttl left
    declaredEntries: [{ id: 'tm1', type: 'teammate' }],
    declaredTs: now - 80000,                                // 10s of teammate ttl left
    now,
    ...TTLS,
  });
  assert.equal(ms, 10000);
});

test('msUntilNextDrain: a drained id and a dream entry contribute nothing (dream-only falls back)', () => {
  const now = 1000000;
  assert.equal(
    msUntilNextDrain({ declaredEntries: [{ id: 'd1', type: 'dream' }], declaredTs: now, now, ...TTLS }),
    null,
    'a dream entry never gates, so it is never the next drain',
  );
  assert.equal(
    msUntilNextDrain({
      declaredEntries: [{ id: 'tm1', type: 'teammate' }],
      declaredTs: now,
      idleIds: new Set(['tm1']),
      now,
      ...TTLS,
    }),
    null,
    'an out-of-band idled id is already drained',
  );
});

test('msUntilNextDrain: nothing gating returns null so the caller keeps its own interval', () => {
  assert.equal(msUntilNextDrain(), null);
  assert.equal(msUntilNextDrain({ countedAgents: new Map(), declaredEntries: [], now: 1, ...TTLS }), null);
});

test('msUntilNextDrain: an already-expired contributor is skipped, never reported as an instant drain', () => {
  const now = 1000000;
  // The weak entry expired 1min ago but sits in a snapshot the subagent entry keeps alive: reporting
  // it as "drains now" would re-arm the gate timer at its floor for the rest of the snapshot's life.
  const ms = msUntilNextDrain({
    declaredEntries: [{ id: 'b1', type: 'shell' }, { id: 'x1', type: 'subagent' }],
    declaredTs: now - 6 * 60 * 1000,
    now,
    ...TTLS,
  });
  assert.equal(ms, TTLS.agentTtlMs - 6 * 60 * 1000, 'the surviving subagent entry sets the next drain');
  assert.equal(
    msUntilNextDrain({ countedAgents: new Map([['a1', now - TTLS.agentTtlMs]]), now, ...TTLS }),
    null,
    'a counted entry at its ttl boundary is already prunable, so it is not a future drain',
  );
});

test('msUntilNextDrain: every returned value is strictly positive', () => {
  const now = 1000000;
  const ms = msUntilNextDrain({
    declaredEntries: [{ id: 'tm1', type: 'teammate' }],
    declaredTs: now - (TTLS.teammateTtlMs - 1),
    now,
    ...TTLS,
  });
  assert.equal(ms, 1);
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
