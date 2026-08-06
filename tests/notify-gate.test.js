'use strict';

// Tests for the once-per-work-cycle notification gate (session/core/notify-gate.js) and its
// backend wiring contract, plus a NotificationManager regression guard that the 'waiting'
// escalation ping-pong is untouched by the gate change (the gate sits at the call site,
// BEFORE the manager; the manager's debounce/suppression/escalation are unchanged).

const test = require('node:test');
const assert = require('node:assert/strict');

const { createNotifyGate, decideNotification, explainNotification } = require('../session/core/notify-gate');
const { STATES } = require('../shared/states');
const { NotificationManager } = require('../notifications/notification-manager');

// ---------------------------------------------------------------------------
// Gate unit behavior
// ---------------------------------------------------------------------------

test('fire returns true once per category per cycle, false on repeats', () => {
  const gate = createNotifyGate();
  assert.equal(gate.fire('complete'), true);
  assert.equal(gate.fire('complete'), false);
  assert.equal(gate.fire('complete'), false);
});

test('categories are independent: a spent complete never blocks failed or vice versa', () => {
  const gate = createNotifyGate();
  assert.equal(gate.fire('complete'), true);
  assert.equal(gate.fire('failed'), true);
  assert.equal(gate.fire('complete'), false);
  assert.equal(gate.fire('failed'), false);
});

test('reset re-arms every category', () => {
  const gate = createNotifyGate();
  gate.fire('complete');
  gate.fire('failed');
  gate.reset();
  assert.equal(gate.fire('complete'), true);
  assert.equal(gate.fire('failed'), true);
});

test('a falsy category never fires', () => {
  const gate = createNotifyGate();
  assert.equal(gate.fire(''), false);
  assert.equal(gate.fire(null), false);
  assert.equal(gate.fire(undefined), false);
});

// ---------------------------------------------------------------------------
// Backend wiring contract. These sequences execute the SAME decideNotification
// the backend state-change listener calls (no hand-mirrored copy to drift), so
// a logic change in the production decision breaks these tests directly.
// Self-transitions never reach the listener (sessions.js transition() returns
// early without emitting), so each sequence below lists only real entered states.
// ---------------------------------------------------------------------------

function runSequence(states) {
  const gate = createNotifyGate();
  const fired = [];
  for (const to of states) {
    const category = decideNotification(to, gate);
    if (category) fired.push(category);
  }
  return fired;
}

test('wiring contract: the reset states exist in shared/states.js', () => {
  assert.equal(typeof STATES.RUNNING, 'string');
  assert.equal(typeof STATES.INITIALIZING, 'string');
  assert.notEqual(STATES.RUNNING, STATES.INITIALIZING);
});

test('AC1 reproduced bug: dismiss-opened IDLE window re-complete notifies once', () => {
  // RUNNING -> COMPLETE (notify) -> dismiss -> IDLE -> late ready -> COMPLETE (suppressed)
  const fired = runSequence([STATES.RUNNING, STATES.COMPLETE, STATES.IDLE, STATES.COMPLETE]);
  assert.deepEqual(fired, ['complete']);
});

test('AC2 exit pair: COMPLETE then DONE notifies once regardless of elapsed time', () => {
  const fired = runSequence([STATES.RUNNING, STATES.COMPLETE, STATES.DONE]);
  assert.deepEqual(fired, ['complete']);
});

test('AC3 per-category: a waiting notification does not consume the cycle complete', () => {
  // Turn ends at a prompt ('waiting' fires), then a late Stop completes it.
  const fired = runSequence([STATES.RUNNING, STATES.WAITING, STATES.COMPLETE]);
  assert.deepEqual(fired, ['waiting', 'complete']);
});

test('AC4 new cycle: a genuinely new turn re-notifies (title bounce is a new cycle by design)', () => {
  const fired = runSequence([STATES.RUNNING, STATES.COMPLETE, STATES.RUNNING, STATES.COMPLETE]);
  assert.deepEqual(fired, ['complete', 'complete']);
});

test('AC5 direct exit: RUNNING -> DONE notifies once', () => {
  const fired = runSequence([STATES.RUNNING, STATES.DONE]);
  assert.deepEqual(fired, ['complete']);
});

test('AC6 failed is gated and a restart (INITIALIZING) re-arms it', () => {
  const fired = runSequence([
    STATES.RUNNING, STATES.FAILED,
    STATES.INITIALIZING, STATES.STARTING, STATES.IDLE, STATES.RUNNING, STATES.FAILED,
  ]);
  assert.deepEqual(fired, ['failed', 'failed']);
});

test('AC6b restart after a completed exit re-arms complete', () => {
  const fired = runSequence([
    STATES.RUNNING, STATES.COMPLETE, STATES.DONE,
    STATES.INITIALIZING, STATES.STARTING, STATES.IDLE, STATES.COMPLETE,
  ]);
  // The post-restart late-ready IDLE -> COMPLETE is a fresh cycle and must notify.
  assert.deepEqual(fired, ['complete', 'complete']);
});

test('user_kill never notifies: killing a RUNNING session is not "finished working"', () => {
  const gate = createNotifyGate();
  assert.equal(decideNotification(STATES.RUNNING, gate), null); // cycle opens
  assert.equal(decideNotification(STATES.DONE, gate, 'user_kill'), null, 'kill is silent');
  // The category was NOT spent: a later real completion in a new cycle still notifies.
  assert.equal(decideNotification(STATES.COMPLETE, gate), 'complete');
});

test('DORMANT transitivity: DORMANT needs no reset entry because user_start passes INITIALIZING', () => {
  // DONE -> DORMANT (user_reset) does not reset; the only exit from DORMANT is
  // user_start -> INITIALIZING, which does. Do not add DORMANT to the reset set.
  const fired = runSequence([
    STATES.RUNNING, STATES.COMPLETE, STATES.DONE, STATES.DORMANT,
    STATES.INITIALIZING, STATES.STARTING, STATES.IDLE, STATES.COMPLETE,
  ]);
  assert.deepEqual(fired, ['complete', 'complete']);
});

// ---------------------------------------------------------------------------
// User-driven RUNNING reset (opts: { signal, hookSeen }). A RUNNING entry only starts a new
// work cycle when the user actually drove it (answered a prompt, or an authoritative resume);
// a self-wake (an orchestrator lead's title flipping to 'working' after it auto-resumes on a
// teammate's mailbox message, which fires no UserPromptSubmit) must NOT re-arm 'complete'.
// ---------------------------------------------------------------------------

test('RUNNING self-wake (signal: working, hookSeen: true) does not reset: the spent category stays spent', () => {
  const gate = createNotifyGate();
  assert.equal(decideNotification(STATES.RUNNING, gate), null); // opens the first cycle (no opts = legacy)
  assert.equal(decideNotification(STATES.COMPLETE, gate), 'complete');
  const category = decideNotification(STATES.RUNNING, gate, undefined, { signal: 'working', hookSeen: true });
  assert.equal(category, null);
  assert.equal(decideNotification(STATES.COMPLETE, gate), null, 'complete was not re-armed by the self-wake');
});

test('RUNNING via an authoritative resume signal resets: complete notifies again', () => {
  const gate = createNotifyGate();
  assert.equal(decideNotification(STATES.RUNNING, gate), null);
  assert.equal(decideNotification(STATES.COMPLETE, gate), 'complete');
  decideNotification(STATES.RUNNING, gate, undefined, { signal: 'resume', hookSeen: true });
  assert.equal(decideNotification(STATES.COMPLETE, gate), 'complete', 'an authoritative UserPromptSubmit re-arms the cycle');
});

test('RUNNING via event user_input resets, even with a self-wake-looking signal', () => {
  const gate = createNotifyGate();
  assert.equal(decideNotification(STATES.RUNNING, gate), null);
  assert.equal(decideNotification(STATES.COMPLETE, gate), 'complete');
  decideNotification(STATES.RUNNING, gate, 'user_input', { signal: 'working', hookSeen: true });
  assert.equal(decideNotification(STATES.COMPLETE, gate), 'complete', 'the user answering a WAITING prompt always re-arms');
});

test('RUNNING on a degraded title-only session (hookSeen: false) keeps the legacy per-RUNNING reset', () => {
  const gate = createNotifyGate();
  assert.equal(decideNotification(STATES.RUNNING, gate), null);
  assert.equal(decideNotification(STATES.COMPLETE, gate), 'complete');
  decideNotification(STATES.RUNNING, gate, undefined, { signal: 'working', hookSeen: false });
  assert.equal(decideNotification(STATES.COMPLETE, gate), 'complete', 'no hook ever seen: no resume signal to key off, so every RUNNING still resets');
});

test('INITIALIZING always resets regardless of opts', () => {
  const gate = createNotifyGate();
  assert.equal(decideNotification(STATES.RUNNING, gate), null);
  assert.equal(decideNotification(STATES.COMPLETE, gate), 'complete');
  decideNotification(STATES.INITIALIZING, gate, undefined, { signal: 'working', hookSeen: true });
  assert.equal(decideNotification(STATES.COMPLETE, gate), 'complete', 'a restart always re-arms, opts or not');
});

test('omitted opts on RUNNING preserves legacy behavior (always resets)', () => {
  const gate = createNotifyGate();
  assert.equal(decideNotification(STATES.RUNNING, gate), null);
  assert.equal(decideNotification(STATES.COMPLETE, gate), 'complete');
  decideNotification(STATES.RUNNING, gate); // no opts at all, exactly like the old call sites
  assert.equal(decideNotification(STATES.COMPLETE, gate), 'complete');
});

test('MEDIUM fix: an out-of-band gate.reset() (the user-prompt listener) re-arms complete even when the RUNNING transition lost the race to a title working signal', () => {
  // Both 'working' (title) and 'resume' (hook) are immediate in status-source.js, so the
  // racing title spinner can win the IDLE/COMPLETE->RUNNING transition and carry signal
  // 'working' in its detail even though a real UserPromptSubmit is also in flight. The gate
  // must still notify again once the session's 'user-prompt' event calls gate.reset()
  // directly (see server/backend.js), independent of the transition's own decideNotification.
  const gate = createNotifyGate();
  assert.equal(decideNotification(STATES.RUNNING, gate), null);
  assert.equal(decideNotification(STATES.COMPLETE, gate), 'complete');
  const category = decideNotification(STATES.RUNNING, gate, undefined, { signal: 'working', hookSeen: true });
  assert.equal(category, null, 'the transition itself does not reset: title working lost the resume race');
  assert.equal(decideNotification(STATES.COMPLETE, gate), null, 'still spent: the transition alone never re-armed it');
  gate.reset(); // the backend's sess.on('user-prompt', () => notifyGate.reset()) listener
  assert.equal(decideNotification(STATES.COMPLETE, gate), 'complete', 're-armed by the out-of-band reset, not by the transition');
});

// ---------------------------------------------------------------------------
// explainNotification: the same decision plus the reason the decision trace records
// (session/core/decision-log.js). decideNotification is its category-only wrapper, so these
// mirror the cases above and additionally pin the reason each branch reports.
// ---------------------------------------------------------------------------

test('explainNotification reports the reset reason for INITIALIZING and a user-driven RUNNING', () => {
  const gate = createNotifyGate();
  assert.deepEqual(explainNotification(STATES.INITIALIZING, gate), { category: null, reason: 'cycle-reset-restart' });
  assert.deepEqual(
    explainNotification(STATES.RUNNING, gate, 'user_input', { signal: 'working', hookSeen: true }),
    { category: null, reason: 'cycle-reset-user-driven' },
  );
  assert.deepEqual(
    explainNotification(STATES.RUNNING, gate, undefined, { signal: 'resume', hookSeen: true }),
    { category: null, reason: 'cycle-reset-user-driven' },
  );
});

test('explainNotification distinguishes a self-wake RUNNING from a user-driven one', () => {
  const gate = createNotifyGate();
  const explained = explainNotification(STATES.RUNNING, gate, undefined, { signal: 'working', hookSeen: true });
  assert.deepEqual(explained, { category: null, reason: 'self-wake-no-reset' });
});

test('explainNotification reports why a terminal state stayed silent', () => {
  const gate = createNotifyGate();
  explainNotification(STATES.RUNNING, gate);
  assert.deepEqual(explainNotification(STATES.COMPLETE, gate), { category: 'complete', reason: 'first-this-cycle' });
  assert.deepEqual(
    explainNotification(STATES.DONE, gate),
    { category: null, reason: 'already-notified-this-cycle' },
    'the exit pair is the gate doing its job, and now it says so',
  );
});

test('explainNotification names the kill and the non-notifying states', () => {
  const gate = createNotifyGate();
  assert.deepEqual(explainNotification(STATES.DONE, gate, 'user_kill'), { category: null, reason: 'user-kill-silent' });
  assert.deepEqual(explainNotification(STATES.WAITING, gate), { category: 'waiting', reason: 'waiting-not-gated' });
  assert.deepEqual(explainNotification(STATES.IDLE, gate), { category: null, reason: 'not-a-notifying-state' });
  assert.deepEqual(explainNotification(STATES.FAILED, gate), { category: 'failed', reason: 'first-this-cycle' });
  assert.deepEqual(explainNotification(STATES.FAILED, gate), { category: null, reason: 'already-notified-this-cycle' });
});

test('decideNotification is exactly explainNotification().category (same gate side effects)', () => {
  const viaDecide = createNotifyGate();
  const viaExplain = createNotifyGate();
  const sequence = [
    [STATES.RUNNING, undefined], [STATES.COMPLETE, undefined], [STATES.DONE, undefined],
    [STATES.RUNNING, undefined], [STATES.WAITING, undefined], [STATES.COMPLETE, undefined],
    [STATES.DONE, 'user_kill'], [STATES.FAILED, undefined],
  ];
  for (const [to, event] of sequence) {
    assert.equal(decideNotification(to, viaDecide, event), explainNotification(to, viaExplain, event).category);
  }
});

// ---------------------------------------------------------------------------
// NotificationManager regression: 'waiting' escalation ping-pong is untouched.
// First direct coverage for notification-manager.js.
// ---------------------------------------------------------------------------

test('waiting escalation still re-delivers on the interval and stops on acknowledge', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const manager = new NotificationManager({ escalationIntervalMs: 1000, debounceMs: 0 });
  const deliveries = [];
  manager.registerChannel('test', (_session, category, _message, context) => {
    deliveries.push({ category, escalationCount: context.escalationCount });
  });

  manager.trigger('s1', 'waiting', 'needs input');
  assert.equal(deliveries.length, 1);

  t.mock.timers.tick(1000); // DELIVERED -> ESCALATED re-delivery
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[1].escalationCount, 1);

  t.mock.timers.tick(1000); // ESCALATED -> DELIVERED ping-pong re-delivery
  assert.equal(deliveries.length, 3);

  manager.acknowledge('s1');
  t.mock.timers.tick(10000);
  assert.equal(deliveries.length, 3, 'no re-delivery after acknowledge');

  manager.destroy();
});

test('complete delivers once with no escalation timer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const manager = new NotificationManager({ escalationIntervalMs: 1000, debounceMs: 0 });
  const deliveries = [];
  manager.registerChannel('test', (_session, category) => deliveries.push(category));

  manager.trigger('s1', 'complete', 'finished working');
  assert.equal(deliveries.length, 1);

  t.mock.timers.tick(60000);
  assert.equal(deliveries.length, 1, 'complete never escalates');

  manager.destroy();
});
