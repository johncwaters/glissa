// Title-latch recovery (WS1): a premature hook `ready` (Stop fired mid-work) must not
// strand the card in IDLE/COMPLETE while the PTY is still spinning. The working-kind
// dedup latch in OscTitleSource is re-opened on entry to IDLE/COMPLETE so the next REAL
// braille frame re-emits `working` and the existing matrix (working + IDLE/COMPLETE ->
// new_output -> RUNNING) recovers the card. Incident: 2026-06-09 19:36, card stuck IDLE
// with title state `working` after ready/hook + user_dismiss.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../session/sessions.ts';
import { STATES } from '../shared/states.ts';
import { createOscTitleSource } from '../detection/osc-title-source.ts';
import type { SessionState } from '../shared/states.ts';
import type { SessionOptions } from '../session/sessions.ts';
const SPIN_A = '⠋'; // braille spinner frames
const SPIN_B = '⠙';
const IDLE_GLYPH = '✳'; // known idle glyph

function makeSession(state?: SessionState, overrides: Partial<SessionOptions> = {}) {
  const s = new Session({
    id: 'latch-test',
    name: 'latch-test',
    path: process.cwd(),
    statusConflictMs: 20,
    statusDedupMs: 10,
    titleStabilizationMs: 15,
    ...overrides,
  });
  if (state) s.state = state;
  return s;
}

function hook(s: Session, signal: string) {
  s.ingestHookSignal({ signal, source: 'hook', ts: Date.now() });
}

// Feed a REAL OSC-0 title through the title source (NOT the statusSource shortcut):
// the latch under test lives in OscTitleSource._processTitle.
function feedTitle(s: Session, glyph: string) {
  s._titleSource.feed(`\x1b]0;${glyph} Claude\x07`);
}

// (a) Unit: resyncWorkingLatch clears ONLY the working kind, preserving the spinner guard.
test('resyncWorkingLatch re-opens the working latch and preserves hasSeenSpinner', () => {
  const src = createOscTitleSource({ stabilizationMs: 15 });
  const signals: string[] = [];
  src.on('signal', (e) => signals.push(e.signal));
  src.feed(`\x1b]0;${SPIN_A} t\x07`);
  assert.deepEqual(signals, ['working']);
  assert.equal(src.getState().lastKind, 'working');

  src.resyncWorkingLatch();
  assert.equal(src.getState().lastKind, null, 'working latch cleared');
  assert.equal(src.getState().hasSeenSpinner, true, 'spinner guard preserved');

  src.feed(`\x1b]0;${SPIN_B} t\x07`);
  assert.deepEqual(signals, ['working', 'working'], 'next braille frame re-emits');
  src.destroy();
});

test('resyncWorkingLatch is a no-op for non-working kinds', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const src = createOscTitleSource({ stabilizationMs: 5 });
  src.feed(`\x1b]0;${SPIN_A} t\x07`);
  src.feed(`\x1b]0;${IDLE_GLYPH} t\x07`);
  t.mock.timers.tick(20); // stabilization -> ready
  assert.equal(src.getState().lastKind, 'ready');
  src.resyncWorkingLatch();
  assert.equal(src.getState().lastKind, 'ready', 'ready kind untouched');
  src.destroy();
});

// (b) Incident regression (RED on main): ready/hook -> COMPLETE -> user_dismiss -> IDLE
// while the spinner never paused; continued braille frames must recover to RUNNING.
test('INCIDENT: premature ready + dismiss strands IDLE; continued spinner recovers to RUNNING', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.IDLE);
  feedTitle(s, SPIN_A);
  assert.equal(s.state, STATES.RUNNING, 'spinner wakes the idle card');

  hook(s, 'ready'); // premature Stop mid-work
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE);

  assert.equal(s.dismiss(), true);
  assert.equal(s.state, STATES.IDLE);

  feedTitle(s, SPIN_B); // the work never stopped
  assert.equal(s.state, STATES.RUNNING, 'stuck-IDLE card must self-heal on the next spinner frame');
  s.destroy();
});

// (c) Same without dismiss: COMPLETE + continued spinner recovers.
test('premature ready without dismiss: COMPLETE + continued spinner recovers to RUNNING', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.IDLE);
  feedTitle(s, SPIN_A);
  hook(s, 'ready');
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE);

  feedTitle(s, SPIN_B);
  assert.equal(s.state, STATES.RUNNING);
  s.destroy();
});

// (d) Legit complete: idle-glyph titles after the Stop must NOT re-wake or flap.
test('legit complete: idle-glyph titles after ready keep the card COMPLETE', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.IDLE);
  const seen: unknown[] = [];
  s.on('state-change', (e) => seen.push(e.to));
  feedTitle(s, SPIN_A);
  hook(s, 'ready');
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE);

  feedTitle(s, IDLE_GLYPH);
  t.mock.timers.tick(60); // stabilization (15ms) + conflict window (20ms) fully elapsed
  assert.equal(s.state, STATES.COMPLETE, 'no spurious wake from the idle glyph');
  const afterComplete = seen.slice(seen.indexOf(STATES.COMPLETE) + 1);
  assert.equal(afterComplete.includes(STATES.RUNNING), false, 'no flap');
  s.destroy();
});

// (e) Startup guard intact: an idle-glyph-only session (never spun) emits nothing,
// and resync does not weaken that.
test('startup idle glyph still emits no ready; resync does not arm anything', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.IDLE);
  feedTitle(s, IDLE_GLYPH);
  s._titleSource.resyncWorkingLatch();
  feedTitle(s, IDLE_GLYPH);
  t.mock.timers.tick(60);
  assert.equal(s.state, STATES.IDLE, 'never-spun session stays idle');
  s.destroy();
});

// (f) Flap idempotency: COMPLETE re-entry is now routine, so each entry must emit
// post-turn-check exactly once (the backend's per-session ptDebounce closure collapses
// bursts; the notification 'complete' category debounce - pinned by
// test/test-notification-manager.js "same-session re-trigger debounced" - suppresses a
// duplicate toast within the window). Asserted here at the Session boundary: one
// emission per COMPLETE entry, and the flap settles without oscillation.
test('flap COMPLETE -> RUNNING -> COMPLETE emits one post-turn-check per entry and settles', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.IDLE);
  let postTurnChecks = 0;
  s.on('post-turn-check', () => postTurnChecks++);

  feedTitle(s, SPIN_A);
  hook(s, 'ready'); // premature
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE);
  assert.equal(postTurnChecks, 1);

  feedTitle(s, SPIN_B); // recovery
  assert.equal(s.state, STATES.RUNNING);

  hook(s, 'ready'); // the real turn end
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE);
  assert.equal(postTurnChecks, 2, 'exactly one post-turn-check per COMPLETE entry');

  feedTitle(s, IDLE_GLYPH); // genuinely done now
  t.mock.timers.tick(60);
  assert.equal(s.state, STATES.COMPLETE, 'settled, no oscillation');
  assert.equal(postTurnChecks, 2);
  s.destroy();
});

// reset() semantics unchanged: full reset still clears the spinner guard (resync must not
// have replaced or weakened it on the restart/exit paths).
test('reset() still clears hasSeenSpinner (resync is strictly weaker)', () => {
  const src = createOscTitleSource({ stabilizationMs: 15 });
  src.feed(`\x1b]0;${SPIN_A} t\x07`);
  src.reset();
  assert.deepEqual(src.getState(), { hasSeenSpinner: false, lastKind: null, lastChar: null });
  src.destroy();
});
