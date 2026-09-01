import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../session/sessions.ts';
import { STATES } from '../shared/states.ts';
import { decideGateRelease, DEFAULT_GATE_RELEASE_SETTLE_MS } from '../session/core/gate-release.ts';
import type { HookSignal } from '../detection/hook-source.ts';
const SPIN_A = '⠋';
const SPIN_B = '⠙';
const IDLE_GLYPH = '✳';

function makeSession(overrides = {}) {
  const s = new Session({
    id: 'gate-release-test',
    name: 'gate-release-test',
    path: process.cwd(),
    statusConflictMs: 20,
    statusDedupMs: 10,
    titleStabilizationMs: 15,
    gateReleaseSettleMs: 30,
    ...overrides,
  });
  s.state = STATES.RUNNING;
  return s;
}

function hook(s: Session, signal: string, payload: Partial<HookSignal> = {}) {
  s.ingestHookSignal({ signal, source: 'hook', ts: Date.now(), ...payload });
}

function feedTitle(s: Session, glyph: string) {
  s._titleSource.feed(`\x1b]0;${glyph} Claude\x07`);
}

test('decideGateRelease cancels when the session moved to another state', () => {
  const d = decideGateRelease({
    heldState: STATES.RUNNING, currentState: STATES.WAITING, activeAgents: 0,
    stashTs: 1000, quietSince: 1000, now: 99000, settleMs: 10,
  });
  assert.equal(d.decision, 'cancel');
});

test('decideGateRelease cancels when activity was seen AFTER the stash (the incident)', () => {
  const d = decideGateRelease({
    heldState: STATES.RUNNING, currentState: STATES.RUNNING, activeAgents: 0,
    stashTs: 1000, lastActivitySeq: 2, stashSeq: 1, quietSince: 1000, now: 99000, settleMs: 10,
  });
  assert.equal(d.decision, 'cancel', 'a new turn since the stash supersedes the held Stop');
});

test('decideGateRelease cancels superseded holds even while background work is still live', () => {
  const d = decideGateRelease({
    heldState: STATES.RUNNING, currentState: STATES.RUNNING, activeAgents: 3,
    stashTs: 1000, lastActivitySeq: 9, stashSeq: 4, quietSince: 1000, now: 3000, settleMs: 10,
  });
  assert.equal(d.decision, 'cancel', 'the hold is dead regardless of the count');
});

test('decideGateRelease orders by arrival, not by clock (a same-millisecond Stop wins)', () => {
  const d = decideGateRelease({
    heldState: STATES.RUNNING, currentState: STATES.RUNNING, activeAgents: 0,
    stashSeq: 7, lastActivitySeq: 6, stashTs: 1000, quietSince: 1000, now: 5000, settleMs: 10,
  });
  assert.equal(d.decision, 'release', 'the activity arrived before the Stop that superseded it');
});

test('decideGateRelease keeps holding while background work is live', () => {
  const d = decideGateRelease({
    heldState: STATES.RUNNING, currentState: STATES.RUNNING, activeAgents: 1,
    stashTs: 1000, quietSince: 1000, now: 99000, settleMs: 10,
  });
  assert.equal(d.decision, 'gated');
});

test('decideGateRelease waits out the remaining quiet window, then releases', () => {
  const base = {
    heldState: STATES.RUNNING, currentState: STATES.RUNNING, activeAgents: 0,
    stashTs: 1000, quietSince: 1000, settleMs: 100,
  };
  const waiting = decideGateRelease({ ...base, now: 1040 });
  assert.equal(waiting.decision, 'wait');
  assert.equal(waiting.waitMs, 60, 'asks to be re-checked when the window actually elapses');
  assert.equal(decideGateRelease({ ...base, now: 1100 }).decision, 'release');
});

test('decideGateRelease measures the quiet window from the last still-gated moment', () => {
  const d = decideGateRelease({
    heldState: STATES.RUNNING, currentState: STATES.RUNNING, activeAgents: 0,
    stashTs: 1000, quietSince: 9000, now: 9050, settleMs: 100,
  });
  assert.equal(d.decision, 'wait');
  assert.equal(d.waitMs, 50, 'a long-gated hold still owes a full quiet window after it drains');
});

test('decideGateRelease defaults the settle window to the shared constant', () => {
  assert.equal(DEFAULT_GATE_RELEASE_SETTLE_MS, 10 * 1000);
  const d = decideGateRelease({
    heldState: STATES.RUNNING, currentState: STATES.RUNNING, activeAgents: 0,
    stashTs: 0, quietSince: 0, now: DEFAULT_GATE_RELEASE_SETTLE_MS - 1,
  });
  assert.equal(d.decision, 'wait');
});

test('stashing a held ready re-opens the title working latch', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession();
  feedTitle(s, SPIN_A);
  assert.equal(s._titleSource.getState().lastKind, 'working', 'latched by the first frame');
  hook(s, 'subagent-start', { payload: { agent_id: 'teammate-1' } });
  hook(s, 'ready');
  t.mock.timers.tick(40);
  assert.equal(
    s._titleSource.getState().lastKind, null,
    'the next real spinner frame must be able to report the turn is still open',
  );
  s.destroy();
});

test('INCIDENT: a held ready must NOT complete a card whose title is still spinning', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession();
  const seen: unknown[] = [];
  s.on('state-change', (e) => seen.push(e.to));

  feedTitle(s, SPIN_A);
  hook(s, 'subagent-start', { payload: { agent_id: 'teammate-1' } });
  hook(s, 'ready');
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING, 'the gate suppresses and holds it');

  feedTitle(s, SPIN_B);
  hook(s, 'subagent-stop', { payload: { agent_id: 'teammate-1' } });
  assert.equal(s.toSnapshot().activeAgents, 0, 'the count really did drain');
  t.mock.timers.tick(300);

  assert.equal(s.state, STATES.RUNNING, 'still working: the held Stop describes a finished turn');
  assert.equal(seen.includes(STATES.COMPLETE), false, 'never completed, not even transiently');
  s.destroy();
});

test('the card still completes normally once the resumed turn really ends', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession();
  feedTitle(s, SPIN_A);
  hook(s, 'subagent-start', { payload: { agent_id: 'teammate-1' } });
  hook(s, 'ready');
  t.mock.timers.tick(40);
  feedTitle(s, SPIN_B);
  hook(s, 'subagent-stop', { payload: { agent_id: 'teammate-1' } });
  t.mock.timers.tick(300);
  assert.equal(s.state, STATES.RUNNING);

  hook(s, 'ready');
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE, 'no stuck-WORKING: the next real Stop completes');
  s.destroy();
});

test('a drained hold on a genuinely quiet title releases after the settle window', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession();
  const completed: { detail: Record<string, unknown> | null } = { detail: null };
  s.on('state-change', (e) => { if (e.to === STATES.COMPLETE) completed.detail = e.detail; });

  feedTitle(s, SPIN_A);
  hook(s, 'subagent-start', { payload: { agent_id: 'teammate-1' } });
  hook(s, 'ready');
  t.mock.timers.tick(40);
  hook(s, 'subagent-stop', { payload: { agent_id: 'teammate-1' } });
  assert.equal(s.state, STATES.RUNNING, 'not instant: the mailbox wake gets its window');
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE, 'a genuinely settled session still completes');
  assert.equal(completed.detail?.deferred, true);
  s.destroy();
});

test('an idle-glyph title after the stash does not block the release', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession();
  feedTitle(s, SPIN_A);
  hook(s, 'subagent-start', { payload: { agent_id: 'teammate-1' } });
  hook(s, 'ready');
  t.mock.timers.tick(40);
  feedTitle(s, IDLE_GLYPH);
  hook(s, 'subagent-stop', { payload: { agent_id: 'teammate-1' } });
  t.mock.timers.tick(60);
  assert.equal(s.state, STATES.COMPLETE, 'quiescence evidence, not activity evidence');
  s.destroy();
});

test('a spinner frame during the settle window cancels the pending release', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession();
  const seen: unknown[] = [];
  s.on('state-change', (e) => seen.push(e.to));
  feedTitle(s, SPIN_A);
  hook(s, 'subagent-start', { payload: { agent_id: 'teammate-1' } });
  hook(s, 'ready');
  t.mock.timers.tick(40);
  hook(s, 'subagent-stop', { payload: { agent_id: 'teammate-1' } });
  t.mock.timers.tick(10);
  feedTitle(s, SPIN_B);
  t.mock.timers.tick(300);
  assert.equal(s.state, STATES.RUNNING);
  assert.equal(seen.includes(STATES.COMPLETE), false, 'the wake beat the release, as designed');
  s.destroy();
});
