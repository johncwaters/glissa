import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTaskRegistry, DEFAULT_AGENT_TTL_MS, DEFAULT_SHELL_TASK_TTL_MS, DEFAULT_TEAMMATE_TASK_TTL_MS,
} from '../session/core/agent-tracker.ts';
import type { TaskRegistryOptions } from '../session/core/agent-tracker.ts';

function makeRegistry(overrides: TaskRegistryOptions = {}) {
  let clock = 1_000_000;
  const registry = createTaskRegistry({ now: () => clock, ...overrides });
  return {
    registry,
    advance: (ms: number) => { clock += ms; },
    at: () => clock,
  };
}

test('a counted sub-agent gates until its stop arrives', () => {
  const { registry } = makeRegistry();
  assert.equal(registry.activeCount(), 0);
  assert.equal(registry.noteAgentStart('a1', 1_000_000), true, 'newly added');
  assert.equal(registry.noteAgentStart('a1', 1_000_000), false, 'a duplicate start is idempotent');
  assert.equal(registry.activeCount(), 1);
  assert.equal(registry.noteAgentStop('a1'), true);
  assert.equal(registry.activeCount(), 0);
  assert.equal(registry.noteAgentStop('a1'), false, 'a duplicate stop is a no-op');
});

test('the larger of counted and declared wins, which is the query the registry exists for', () => {
  const { registry } = makeRegistry();
  registry.noteAgentStart('a1', 1_000_000);
  registry.noteAgentStart('a2', 1_000_000);
  registry.reconcileDeclared([{ id: 't1', type: 'shell' }]);
  assert.equal(registry.activeCount(), 2, 'the counted map is fresher than a pre-drain snapshot');

  registry.reconcileDeclared([
    { id: 't1', type: 'shell' }, { id: 't2', type: 'shell' }, { id: 't3', type: 'teammate' },
  ]);
  assert.equal(registry.activeCount(), 3, 'the declaration sees work the counting cannot');
});

test('a declaration of zero drains the counted map at once, not at the TTL', () => {
  const { registry } = makeRegistry();
  registry.noteAgentStart('a1', 1_000_000);
  registry.reconcileDeclared([]);
  assert.equal(registry.activeCount(), 0);
});

test('a TaskCompleted filters its id out of the declaration and out of the counted map', () => {
  const { registry } = makeRegistry();
  registry.noteAgentStart('t1', 1_000_000);
  registry.reconcileDeclared([{ id: 't1', type: 'teammate' }, { id: 't2', type: 'teammate' }]);
  assert.equal(registry.activeCount(), 2);
  registry.noteTaskCompleted({ taskId: 't1', name: 'alice' });
  assert.equal(registry.activeCount(), 1);
});

test('a forged SubagentStop cannot pre-drain a later authoritative declaration', () => {
  const { registry } = makeRegistry();
  registry.noteAgentStop('child-1');
  registry.reconcileDeclared([{ id: 'child-1', type: 'subagent' }]);
  assert.equal(registry.activeCount(), 1);
});

test('an idle teammate name drains one declared teammate, clamped to the teammate count', () => {
  const { registry } = makeRegistry();
  registry.reconcileDeclared([{ id: 't1', type: 'teammate' }, { id: 's1', type: 'subagent' }]);
  registry.noteTeammateIdle('alice', 1_000_000);
  assert.equal(registry.activeCount(), 1, 'the teammate drains, the subagent does not');
  registry.noteTeammateIdle('bob', 1_000_000);
  assert.equal(registry.activeCount(), 1, 'a stale extra idle name cannot mask the subagent');
});

test('a reactivated teammate re-gates, by TaskCreated or by an agent_id embedding its name', () => {
  const { registry } = makeRegistry();
  registry.reconcileDeclared([{ id: 't1', type: 'teammate' }]);
  registry.noteTeammateIdle('alice', 1_000_000);
  assert.equal(registry.activeCount(), 0);

  registry.noteTaskCreated({ taskId: null, name: 'alice' });
  assert.equal(registry.activeCount(), 1);

  registry.noteTeammateIdle('alice', 1_000_000);
  assert.equal(registry.activeCount(), 0);
  registry.regateByAgentId('aalice-1a2b3c');
  assert.equal(registry.activeCount(), 1, 'the mailbox-wake case, which fires no TaskCreated');
});

test('a lookalike agent_id does not re-gate a different teammate', () => {
  const { registry } = makeRegistry();
  registry.reconcileDeclared([{ id: 't1', type: 'teammate' }]);
  registry.noteTeammateIdle('foo', 1_000_000);
  registry.regateByAgentId('afoo-bar-1a2b');
  assert.equal(registry.activeCount(), 0, '"foo-bar" starting is not "foo" waking up');
});

test('one reaper ages out a weak entry, a teammate entry, and a counted id on their own bounds', () => {
  const { registry, advance } = makeRegistry();
  registry.noteAgentStart('a1', 1_000_000);
  registry.reconcileDeclared([{ id: 's1', type: 'shell' }, { id: 't1', type: 'teammate' }]);
  assert.equal(registry.activeCount(), 2);

  advance(DEFAULT_TEAMMATE_TASK_TTL_MS);
  assert.equal(registry.activeCount(), 1, 'the teammate entry aged out; the shell entry and the counted id have not');

  advance(DEFAULT_AGENT_TTL_MS - DEFAULT_TEAMMATE_TASK_TTL_MS);
  assert.equal(registry.activeCount(), 1, 'the counted id aged out, leaving the longer shell declaration');
  assert.equal(registry.getBreakdown().declared, 1);
  assert.equal(registry.getBreakdown().counted, 0);

  advance(DEFAULT_SHELL_TASK_TTL_MS - DEFAULT_AGENT_TTL_MS);
  assert.equal(registry.activeCount(), 0, 'the shell declaration ages out last');
});

test('a whole declaration whose refreshing Stop never came ages out', () => {
  const { registry, advance } = makeRegistry();
  registry.reconcileDeclared([{ id: 't1', type: 'subagent' }]);
  assert.equal(registry.hasDeclared(), true);
  advance(DEFAULT_AGENT_TTL_MS);
  assert.equal(registry.activeCount(), 0);
  assert.equal(registry.hasDeclared(), false, 'the reaper drops it rather than suppressing forever');
});

test('a shell declaration outlives the generic agent TTL and drains at its own backstop', () => {
  const { registry, advance } = makeRegistry({ agentTtlMs: 100, shellTaskTtlMs: 200 });
  registry.reconcileDeclared([{ id: 'b1', type: 'shell' }]);
  advance(100);
  assert.equal(registry.activeCount(), 1);
  assert.equal(registry.hasDeclared(), true);
  advance(100);
  assert.equal(registry.activeCount(), 0);
  assert.equal(registry.hasDeclared(), false);
});

test('a stale idle-name record cannot mask a future same-named teammate forever', () => {
  const { registry, advance } = makeRegistry();
  registry.noteTeammateIdle('alice', 1_000_000);
  advance(DEFAULT_AGENT_TTL_MS);
  registry.activeCount();
  assert.equal(registry.inspect().idleTeammateNames.size, 0);
});

test('a departed teammate evicts the name idled against it', () => {
  const { registry } = makeRegistry();
  registry.reconcileDeclared([{ id: 't1', type: 'teammate' }]);
  registry.noteTeammateIdle('alice', 1_000_000);
  assert.equal(registry.activeCount(), 0);

  registry.reconcileDeclared([{ id: 't2', type: 'teammate' }]);
  assert.equal(registry.activeCount(), 1);
});

test('the breakdown names which source gated, for the decision trace', () => {
  const { registry } = makeRegistry();
  registry.noteAgentStart('a1', 1_000_000);
  registry.reconcileDeclared([{ id: 't1', type: 'teammate' }, { id: 't2', type: 'teammate' }]);
  registry.noteTeammateIdle('alice', 1_000_000);
  registry.noteTaskCompleted({ taskId: 't2' });
  registry.activeCount();
  assert.deepEqual(registry.getBreakdown(), { counted: 1, declared: 0, idleNames: 1, idleTasks: 1 });
});

test('clear drops everything, which is what a PTY exit needs', () => {
  const { registry } = makeRegistry();
  registry.noteAgentStart('a1', 1_000_000);
  registry.reconcileDeclared([{ id: 't1', type: 'teammate' }]);
  registry.noteTeammateIdle('alice', 1_000_000);
  registry.noteTaskCompleted({ taskId: 't1' });
  registry.clear();
  assert.equal(registry.activeCount(), 0);
  const view = registry.inspect();
  assert.equal(view.counted.size, 0);
  assert.equal(view.declared, null);
  assert.equal(view.idleTaskIds.size, 0);
  assert.equal(view.idleTeammateNames.size, 0);
  assert.equal(view.declaredTeammateIds.size, 0);
});

test('clearDeclared reports whether there was one, so the caller can skip the delta', () => {
  const { registry } = makeRegistry();
  assert.equal(registry.clearDeclared(), false);
  registry.reconcileDeclared([{ id: 't1', type: 'shell' }]);
  assert.equal(registry.clearDeclared(), true);
  assert.equal(registry.clearDeclared(), false);
});

test('the next drain is reported from each contributor own timestamp, not from now', () => {
  const { registry, advance, at } = makeRegistry();
  registry.reconcileDeclared([{ id: 't1', type: 'teammate' }]);
  advance(DEFAULT_TEAMMATE_TASK_TTL_MS - 1000);
  assert.equal(registry.msUntilNextDrain(at()), 1000, 'the snapshot ages from the Stop that declared it');
});

test('with nothing TTL-bound gating, there is no next drain to wait for', () => {
  const { registry, at } = makeRegistry();
  assert.equal(registry.msUntilNextDrain(at()), null);
});
