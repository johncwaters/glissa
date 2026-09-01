import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../session/sessions.ts';
import { STATES } from '../shared/states.ts';
import { createOscTitleSource } from '../detection/osc-title-source.ts';
import type { SessionState } from '../shared/states.ts';
import type { SessionOptions } from '../session/sessions.ts';
const SPIN_A = '⠋';
const SPIN_B = '⠙';
const IDLE_GLYPH = '✳';

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

function feedTitle(s: Session, glyph: string) {
  s._titleSource.feed(`\x1b]0;${glyph} Claude\x07`);
}

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
  t.mock.timers.tick(20);
  assert.equal(src.getState().lastKind, 'ready');
  src.resyncWorkingLatch();
  assert.equal(src.getState().lastKind, 'ready', 'ready kind untouched');
  src.destroy();
});

test('INCIDENT: premature ready + dismiss strands IDLE; continued spinner recovers to RUNNING', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.IDLE);
  feedTitle(s, SPIN_A);
  assert.equal(s.state, STATES.RUNNING, 'spinner wakes the idle card');

  hook(s, 'ready');
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE);

  assert.equal(s.dismiss(), true);
  assert.equal(s.state, STATES.IDLE);

  feedTitle(s, SPIN_B);
  assert.equal(s.state, STATES.RUNNING, 'stuck-IDLE card must self-heal on the next spinner frame');
  s.destroy();
});

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
  t.mock.timers.tick(60);
  assert.equal(s.state, STATES.COMPLETE, 'no spurious wake from the idle glyph');
  const afterComplete = seen.slice(seen.indexOf(STATES.COMPLETE) + 1);
  assert.equal(afterComplete.includes(STATES.RUNNING), false, 'no flap');
  s.destroy();
});

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

test('flap COMPLETE -> RUNNING -> COMPLETE emits one post-turn-check per entry and settles', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.IDLE);
  let postTurnChecks = 0;
  s.on('post-turn-check', () => postTurnChecks++);

  feedTitle(s, SPIN_A);
  hook(s, 'ready');
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE);
  assert.equal(postTurnChecks, 1);

  feedTitle(s, SPIN_B);
  assert.equal(s.state, STATES.RUNNING);

  hook(s, 'ready');
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE);
  assert.equal(postTurnChecks, 2, 'exactly one post-turn-check per COMPLETE entry');

  feedTitle(s, IDLE_GLYPH);
  t.mock.timers.tick(60);
  assert.equal(s.state, STATES.COMPLETE, 'settled, no oscillation');
  assert.equal(postTurnChecks, 2);
  s.destroy();
});

test('reset() still clears hasSeenSpinner (resync is strictly weaker)', () => {
  const src = createOscTitleSource({ stabilizationMs: 15 });
  src.feed(`\x1b]0;${SPIN_A} t\x07`);
  src.reset();
  assert.deepEqual(src.getState(), { hasSeenSpinner: false, lastKind: null, lastChar: null });
  src.destroy();
});
