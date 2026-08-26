'use strict';

// Pending-wakeup indicator (WS2): scheduled self-revivals (ScheduleWakeup / cron tasks seen via
// PostToolUse hooks with a tool-name matcher) surface as ADVISORY snapshot metadata
// (pendingWakeup) and a session-wakeup delta. NEVER a transition or completion gate: a Stop with
// a pending wakeup is a finished turn. Entries self-expire (Esc-cancel fires no hook,
// claude-code#58235). Kill switch: detectScheduledWakeups=false.

const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: sleep } = require('node:timers/promises');

const { Session } = require('../session/sessions');
const { STATES } = require('../shared/states');
const { mapHookToSignal } = require('../detection/hook-source');
const { buildHookSettings, WAKEUP_TOOL_MATCHER, HOOK_EVENTS } = require('../detection/settings-injector');
const wakeupTracker = require('../session/core/wakeup-tracker');

function makeSession(state, overrides = {}) {
  const s = new Session({
    id: 'wakeup-test',
    name: 'wakeup-test',
    path: process.cwd(),
    statusConflictMs: 20,
    statusDedupMs: 10,
    ...overrides,
  });
  if (state) s.state = state;
  return s;
}

function hook(s, signal, payload = {}) {
  s.ingestHookSignal({ signal, source: 'hook', ts: Date.now(), payload });
}

// -- Pure tracker --

test('addWakeup/removeWakeup report set changes; duplicate add refreshes without change', () => {
  const m = new Map();
  assert.equal(wakeupTracker.addWakeup(m, 'k1', { kind: 'wakeup', fireAt: 100, reason: null, ts: 0 }), true);
  assert.equal(wakeupTracker.addWakeup(m, 'k1', { kind: 'wakeup', fireAt: 200, reason: null, ts: 0 }), false);
  assert.equal(wakeupTracker.removeWakeup(m, 'ghost'), false);
  assert.equal(wakeupTracker.removeWakeup(m, 'k1'), true);
  assert.equal(m.size, 0);
});

test('pruneWakeups: one-shot expires at fireAt + grace, cron at the hard TTL', () => {
  const m = new Map();
  wakeupTracker.addWakeup(m, 'w1', { kind: 'wakeup', fireAt: 1000, reason: null, ts: 0 });
  wakeupTracker.addWakeup(m, 'c1', { kind: 'cron', fireAt: null, reason: null, ts: 0 });
  // Before fireAt + grace: nothing pruned.
  assert.equal(wakeupTracker.pruneWakeups(m, 1000, { graceMs: 500, cronTtlMs: 10000 }), 0);
  // Past fireAt + grace: the one-shot goes, cron stays.
  assert.equal(wakeupTracker.pruneWakeups(m, 1500, { graceMs: 500, cronTtlMs: 10000 }), 1);
  assert.equal(m.has('c1'), true);
  // Past the cron TTL: cron goes too.
  assert.equal(wakeupTracker.pruneWakeups(m, 10000, { graceMs: 500, cronTtlMs: 10000 }), 1);
  assert.equal(m.size, 0);
});

test('addWakeup evicts the oldest entry at the hard cap (flood bound)', () => {
  const m = new Map();
  for (let i = 0; i < wakeupTracker.MAX_WAKEUPS + 5; i++) {
    wakeupTracker.addWakeup(m, `w${i}`, { kind: 'wakeup', fireAt: 1e15, reason: null, ts: i });
  }
  assert.equal(m.size, wakeupTracker.MAX_WAKEUPS, 'capped');
  assert.equal(m.has('w0'), false, 'oldest evicted');
  assert.equal(m.has(`w${wakeupTracker.MAX_WAKEUPS + 4}`), true, 'newest kept');
});

test('earliestWakeup prefers the soonest timed entry over a timeless cron entry', () => {
  const m = new Map();
  wakeupTracker.addWakeup(m, 'c1', { kind: 'cron', fireAt: null, reason: null, ts: 0 });
  wakeupTracker.addWakeup(m, 'w2', { kind: 'wakeup', fireAt: 2000, reason: 'b', ts: 0 });
  wakeupTracker.addWakeup(m, 'w1', { kind: 'wakeup', fireAt: 1000, reason: 'a', ts: 0 });
  assert.equal(wakeupTracker.earliestWakeup(m).reason, 'a');
  assert.equal(wakeupTracker.earliestWakeup(new Map()), null);
});

test('extractCronTaskId probes tool_input then tool_response, defensively', () => {
  assert.equal(wakeupTracker.extractCronTaskId({ tool_input: { task_id: 'abc12345' } }), 'abc12345');
  assert.equal(wakeupTracker.extractCronTaskId({ tool_response: { id: 'xyz' } }), 'xyz');
  assert.equal(wakeupTracker.extractCronTaskId({ tool_response: 'not-an-object' }), null);
  assert.equal(wakeupTracker.extractCronTaskId(null), null);
});

// -- Hook mapping (server-side defense in depth behind the matcher) --

test('PostToolUse maps by tool_name; unknown tools are ignored', () => {
  assert.equal(mapHookToSignal('PostToolUse', { tool_name: 'ScheduleWakeup' }), 'wakeup-scheduled');
  assert.equal(mapHookToSignal('PostToolUse', { tool_name: 'CronCreate' }), 'cron-created');
  assert.equal(mapHookToSignal('PostToolUse', { tool_name: 'CronDelete' }), 'cron-deleted');
  assert.equal(mapHookToSignal('PostToolUse', { tool_name: 'Bash' }), null, 'matcher-bypass flood maps to null');
  assert.equal(mapHookToSignal('PostToolUse', {}), null);
});

// -- Settings injection (matcher group, kill switch) --

test('buildHookSettings emits a matched PostToolUse group by default and none when switched off', () => {
  const base = { port: 1234, glissaId: 'abc', token: 'tok', timeoutSec: 5 };
  const on = buildHookSettings(base);
  assert.equal(on.hooks.PostToolUse.length, 1);
  assert.equal(on.hooks.PostToolUse[0].matcher, WAKEUP_TOOL_MATCHER, 'matcher is mandatory: matcher-less would POST every tool call');
  assert.match(on.hooks.PostToolUse[0].hooks[0].url, /\/hook\/abc\/posttooluse\?t=tok$/);
  // Existing events keep their matcher-less shape.
  for (const event of HOOK_EVENTS) {
    assert.equal(Object.hasOwn(on.hooks[event][0], 'matcher'), false, `${event} stays matcher-less`);
  }
  const off = buildHookSettings({ ...base, detectScheduledWakeups: false });
  assert.equal('PostToolUse' in off.hooks, false, 'kill switch removes the group at the source');
});

// -- Session integration --

test('ScheduleWakeup populates pendingWakeup and emits wakeup-change; no transition', () => {
  const s = makeSession(STATES.COMPLETE);
  const deltas = [];
  s.on('wakeup-change', (e) => deltas.push(e.pendingWakeup));
  const before = s.auditLog.length;
  hook(s, 'wakeup-scheduled', { tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: 300, reason: 'watching CI run' } });
  assert.equal(s.state, STATES.COMPLETE, 'tracking signal causes no transition');
  assert.equal(s.auditLog.length, before);
  const pw = s.toSnapshot().pendingWakeup;
  assert.equal(pw.kind, 'wakeup');
  assert.equal(pw.reason, 'watching CI run');
  assert.equal(pw.at > Date.now() + 290 * 1000, true, 'fireAt approx now + delaySeconds');
  assert.equal(deltas.length, 1);
  s.destroy();
});

test('a Stop with a pending wakeup still COMPLETEs (advisory, never a completion gate)', async () => {
  const s = makeSession(STATES.RUNNING);
  hook(s, 'wakeup-scheduled', { tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: 600, reason: 'idle tick' } });
  hook(s, 'ready');
  await sleep(40);
  assert.equal(s.state, STATES.COMPLETE, 'pendingWakeup must NOT suppress task_complete');
  assert.notEqual(s.toSnapshot().pendingWakeup, null, 'chip persists across the COMPLETE');
  s.destroy();
});

test('cron lifecycle: CronCreate tracks by task id, CronDelete clears it', () => {
  const s = makeSession(STATES.COMPLETE);
  hook(s, 'cron-created', { tool_name: 'CronCreate', tool_response: { task_id: 'abcd1234' } });
  assert.equal(s.toSnapshot().pendingWakeup.kind, 'cron');
  assert.equal(s.toSnapshot().pendingWakeup.at, null, 'no cron fire-time computation in v1');
  hook(s, 'cron-deleted', { tool_name: 'CronDelete', tool_input: { task_id: 'abcd1234' } });
  assert.equal(s.toSnapshot().pendingWakeup, null);
  s.destroy();
});

test('one-shot self-expires at fireAt + grace via the lazy prune (invisible Esc-cancel bound)', () => {
  const s = makeSession(STATES.COMPLETE);
  // Inject a wakeup already past its grace directly through the tracker (the prune runs at read time).
  wakeupTracker.addWakeup(s.backgroundTracking.wakeups(), 'w-old', {
    kind: 'wakeup',
    fireAt: Date.now() - wakeupTracker.DEFAULT_WAKEUP_GRACE_MS - 1000,
    reason: 'stale',
    ts: Date.now() - 2 * wakeupTracker.DEFAULT_WAKEUP_GRACE_MS,
  });
  assert.equal(s.toSnapshot().pendingWakeup, null, 'stale entry pruned on read');
  s.destroy();
});

test('malformed payloads are dropped: no delaySeconds, no task id on delete', () => {
  const s = makeSession(STATES.COMPLETE);
  hook(s, 'wakeup-scheduled', { tool_name: 'ScheduleWakeup', tool_input: {} });
  hook(s, 'wakeup-scheduled', { tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: -5 } });
  hook(s, 'cron-deleted', { tool_name: 'CronDelete', tool_input: {} });
  assert.equal(s.toSnapshot().pendingWakeup, null);
  s.destroy();
});

test('detectScheduledWakeups=false ignores the signals entirely (behavior as before)', () => {
  const s = makeSession(STATES.COMPLETE, { detectScheduledWakeups: false });
  const deltas = [];
  s.on('wakeup-change', (e) => deltas.push(e));
  hook(s, 'wakeup-scheduled', { tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: 300, reason: 'x' } });
  assert.equal(s.toSnapshot().pendingWakeup, null);
  assert.equal(deltas.length, 0);
  s.destroy();
});

test('wakeup signals never reach the StatusSource (tracking-only, like subagents)', () => {
  const s = makeSession(STATES.IDLE);
  hook(s, 'wakeup-scheduled', { tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: 60, reason: 'x' } });
  hook(s, 'cron-created', { tool_name: 'CronCreate', tool_response: { task_id: 'aaaa1111' } });
  assert.equal(s.state, STATES.IDLE, 'no transition from tracking signals');
  assert.equal(s.getDetectionStats().lastSignal, null, 'nothing resolved through the StatusSource');
  s.destroy();
});
