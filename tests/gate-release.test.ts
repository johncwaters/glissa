// Deferred completion (gate-held ready) release validation: session/core/gate-release.js
// plus the sessions.js stash/evaluate shell around it. Rationale for the failure shapes
// covered here: AGENTS.md, Background sub-agents / completion gate.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../session/sessions.ts';
import { STATES } from '../shared/states.ts';
import { decideGateRelease, DEFAULT_GATE_RELEASE_SETTLE_MS } from '../session/core/gate-release.ts';
import type { HookSignal } from '../detection/hook-source.ts';
const SPIN_A = '⠋'; // braille spinner frames
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

// Feed a REAL OSC-0 title, so the kind-edge latch under test is exercised (the _statusSource
// shortcut used elsewhere bypasses it).
function feedTitle(s: Session, glyph: string) {
  s._titleSource.feed(`\x1b]0;${glyph} Claude\x07`);
}

// --- pure core -------------------------------------------------------------------------

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

// --- session integration ---------------------------------------------------------------

test('stashing a held ready re-opens the title working latch', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession();
  feedTitle(s, SPIN_A);
  assert.equal(s._titleSource.getState().lastKind, 'working', 'latched by the first frame');
  hook(s, 'subagent-start', { payload: { agent_id: 'teammate-1' } });
  hook(s, 'ready');
  t.mock.timers.tick(40); // past the conflict window: the ready resolves and is stashed
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

  feedTitle(s, SPIN_A); // the card has been RUNNING with a spinning title for a long time
  hook(s, 'subagent-start', { payload: { agent_id: 'teammate-1' } });
  hook(s, 'ready'); // the lead's Stop, fired while the teammate is still running
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING, 'the gate suppresses and holds it');

  // The lead resumes on the teammate's mailbox message: no UserPromptSubmit hook, only a
  // spinning title. Then the teammate goes idle and the background count drains.
  feedTitle(s, SPIN_B);
  hook(s, 'subagent-stop', { payload: { agent_id: 'teammate-1' } });
  assert.equal(s.toSnapshot().activeAgents, 0, 'the count really did drain');
  t.mock.timers.tick(300); // well past the settle window and the TTL re-check

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
  feedTitle(s, SPIN_B); // the lead resumed: hold cancelled
  hook(s, 'subagent-stop', { payload: { agent_id: 'teammate-1' } });
  t.mock.timers.tick(300);
  assert.equal(s.state, STATES.RUNNING);

  hook(s, 'ready'); // the resumed turn's own Stop, with nothing left running
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
  hook(s, 'subagent-stop', { payload: { agent_id: 'teammate-1' } }); // drains, no further frames
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
  feedTitle(s, IDLE_GLYPH); // the lead really did stop working; only the teammate is left
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
  hook(s, 'subagent-stop', { payload: { agent_id: 'teammate-1' } }); // arms the settle window
  t.mock.timers.tick(10);
  feedTitle(s, SPIN_B); // the lead woke on the teammate's mailbox message, 1-3s later in the field
  t.mock.timers.tick(300);
  assert.equal(s.state, STATES.RUNNING);
  assert.equal(seen.includes(STATES.COMPLETE), false, 'the wake beat the release, as designed');
  s.destroy();
});
