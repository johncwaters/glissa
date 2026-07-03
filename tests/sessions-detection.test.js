'use strict';

// Integration tests: StatusSource signals -> session state transitions (§4a matrix).
// Drives the REAL path (ingestHookSignal / statusSource.ingest -> _onStatus -> transition)
// with a short conflict window so `ready` resolves quickly and deterministically.

const test = require('node:test');
const assert = require('node:assert/strict');

const { Session } = require('../sessions');
const { STATES } = require('../shared/states');

function makeSession(state, overrides = {}) {
  const s = new Session({
    id: 'test-id',
    name: 'test',
    path: process.cwd(),
    statusConflictMs: 20,
    statusDedupMs: 10,
    ...overrides,
  });
  if (state) s.state = state;
  return s;
}

// hook signal (authoritative, confidence high)
function hook(s, signal, payload = {}) {
  s.ingestHookSignal({ signal, source: 'hook', ts: Date.now(), ...payload });
}
// title signal (fallback, confidence low)
function title(s, signal) {
  s._statusSource.ingest({ signal, source: 'title', ts: Date.now() });
}

test('fresh session: first_output lands in IDLE, not RUNNING (no false "Working")', () => {
  const s = makeSession(STATES.STARTING);
  s.transition('first_output');
  assert.equal(s.state, STATES.IDLE, 'a just-spawned session must start idle, not working');
  s.destroy();
});

test('working from IDLE -> RUNNING', () => {
  const s = makeSession(STATES.IDLE);
  title(s, 'working');
  assert.equal(s.state, STATES.RUNNING);
  s.destroy();
});

test('resume (hook) from IDLE -> RUNNING (first prompt submitted wakes the idle card)', () => {
  const s = makeSession(STATES.IDLE);
  hook(s, 'resume');
  assert.equal(s.state, STATES.RUNNING);
  s.destroy();
});

test('resume (hook) from COMPLETE -> RUNNING', () => {
  const s = makeSession(STATES.COMPLETE);
  hook(s, 'resume');
  assert.equal(s.state, STATES.RUNNING);
  s.destroy();
});

test('working from WAITING -> RUNNING (user answered)', () => {
  const s = makeSession(STATES.WAITING);
  title(s, 'working');
  assert.equal(s.state, STATES.RUNNING);
  s.destroy();
});

test('ready (hook) from RUNNING -> COMPLETE', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING);
  hook(s, 'ready');
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE);
  s.destroy();
});

test('ready (hook) from WAITING -> COMPLETE (new edge, authoritative)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.WAITING);
  hook(s, 'ready');
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE);
  s.destroy();
});

test('ready (hook) from IDLE -> COMPLETE (new edge, authoritative)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.IDLE);
  hook(s, 'ready');
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE);
  s.destroy();
});

test('ready (title, low confidence) from WAITING does NOT complete', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.WAITING);
  title(s, 'ready');
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.WAITING);
  s.destroy();
});

test('ready (title) from RUNNING -> COMPLETE', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING);
  title(s, 'ready');
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE);
  s.destroy();
});

test('awaiting-input from RUNNING -> WAITING', () => {
  const s = makeSession(STATES.RUNNING);
  hook(s, 'awaiting-input');
  assert.equal(s.state, STATES.WAITING);
  s.destroy();
});

test('awaiting-input from COMPLETE -> WAITING', () => {
  const s = makeSession(STATES.COMPLETE);
  hook(s, 'awaiting-input');
  assert.equal(s.state, STATES.WAITING);
  s.destroy();
});

test('awaiting-input while WAITING stays WAITING (no-op)', () => {
  const s = makeSession(STATES.WAITING);
  const before = s.auditLog.length;
  hook(s, 'awaiting-input');
  assert.equal(s.state, STATES.WAITING);
  assert.equal(s.auditLog.length, before);
  s.destroy();
});

test('CONFLICT: Notification(idle->ready) + Stop(ready) racing awaiting-input -> WAITING, no spurious COMPLETE', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING);
  const seen = [];
  s.on('state-change', (e) => seen.push(e.to));
  hook(s, 'ready'); // Stop
  t.mock.timers.tick(5);
  hook(s, 'awaiting-input'); // permission/idle prompt within conflict window
  t.mock.timers.tick(60);
  assert.equal(s.state, STATES.WAITING);
  assert.equal(seen.includes(STATES.COMPLETE), false, 'must not flip through COMPLETE');
  s.destroy();
});

test('DEDUP: double ready (Stop double-fire) -> single COMPLETE', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING);
  const completes = [];
  s.on('state-change', (e) => { if (e.to === STATES.COMPLETE) completes.push(e); });
  hook(s, 'ready');
  hook(s, 'ready');
  t.mock.timers.tick(50);
  assert.equal(completes.length, 1);
  s.destroy();
});

test('session-start / session-end cause no transition', () => {
  const s = makeSession(STATES.RUNNING);
  const before = s.state;
  hook(s, 'session-start');
  hook(s, 'session-end');
  assert.equal(s.state, before);
  s.destroy();
});

test('state-change chain: COMPLETE and WAITING emit state-change (backend notification hook)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING);
  const events = [];
  s.on('state-change', (e) => events.push({ from: e.from, to: e.to }));
  hook(s, 'awaiting-input'); // -> WAITING
  assert.equal(events.at(-1).to, STATES.WAITING);
  title(s, 'working'); // WAITING -> RUNNING
  hook(s, 'ready'); // -> COMPLETE
  t.mock.timers.tick(40);
  assert.equal(events.at(-1).to, STATES.COMPLETE);
  s.destroy();
});

// Post-extraction (P4): the task_complete decision lives in the pure mapper, so the literal
// `transition("task_complete"` no longer appears in sessions.js. Assert the COMPLETE invariant
// at the new boundary: task_complete -> COMPLETE is the ONLY matrix edge into COMPLETE, and the
// mapper is its sole producer. Strictly >= the old bar (the behavioral tests above still prove
// the live path reaches COMPLETE only here).
test('COMPLETE is reached ONLY via the mapper task_complete (RUNNING; high-confidence WAITING/IDLE)', () => {
  const { mapSignalToEvent } = require('../session-core/status-mapper');
  // ready@RUNNING completes at any confidence; ready@WAITING/IDLE completes ONLY when authoritative (high).
  assert.equal(mapSignalToEvent('ready', STATES.RUNNING, 'low'), 'task_complete');
  assert.equal(mapSignalToEvent('ready', STATES.RUNNING, 'high'), 'task_complete');
  assert.equal(mapSignalToEvent('ready', STATES.WAITING, 'high'), 'task_complete');
  assert.equal(mapSignalToEvent('ready', STATES.IDLE, 'high'), 'task_complete');
  // Never from low-confidence WAITING/IDLE (the title fallback must not complete a prompt), nor elsewhere.
  assert.equal(mapSignalToEvent('ready', STATES.WAITING, 'low'), null);
  assert.equal(mapSignalToEvent('ready', STATES.IDLE, 'low'), null);
  assert.equal(mapSignalToEvent('ready', STATES.COMPLETE, 'high'), null);
  assert.equal(mapSignalToEvent('ready', STATES.DORMANT, 'high'), null);
});

test('no idle/silence timer or content scraping remains - sessions.js AND the mapper (fail-closed)', () => {
  const fs = require('node:fs');
  const scrape = /_resetIdleTimer|isLayer4Chrome|patternDetector|hasPendingContent/;
  // require.resolve throws on a bad path, so a moved/renamed target FAILS CLOSED (never silently passes).
  for (const rel of ['../sessions.js', '../session-core/status-mapper.js']) {
    const src = fs.readFileSync(require.resolve(rel), 'utf8');
    assert.equal(scrape.test(src), false, `scrape pattern found in ${rel}`);
  }
});

test('no require of deleted detection modules remains in sessions.js', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../sessions.js'), 'utf8');
  assert.equal(/require\(["']\.\/(patterns|ansi-tokenizer|line-assembler|notify|completion-detector)["']\)/.test(src), false);
});

test('getDetectionStats().lastSignal carries meta:true after a meta signal', () => {
  const s = makeSession(STATES.RUNNING);
  s._onMeta({ signal: 'unknown', source: 'title', ts: Date.now() });
  const last = s.getDetectionStats().lastSignal;
  assert.equal(last.meta, true);
  assert.equal(last.signal, 'unknown');
  assert.equal(last.source, 'title');
  s.destroy();
});

// --- Background sub-agent gate (subagent-start/stop tracking; ready suppressed while count > 0) ---

test('background sub-agent: a main Stop while a sub-agent is live does NOT complete', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING);
  const seen = [];
  s.on('state-change', (e) => seen.push(e.to));
  hook(s, 'subagent-start', { payload: { agent_id: 'a1' } });
  hook(s, 'ready'); // main-agent Stop, but a1 is still running
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING, 'must stay RUNNING while a background sub-agent runs');
  assert.equal(seen.includes(STATES.COMPLETE), false, 'must not flip through COMPLETE');
  s.destroy();
});

test('background sub-agent: after the sub-agent stops, a later Stop completes', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING);
  hook(s, 'subagent-start', { payload: { agent_id: 'a1' } });
  hook(s, 'ready'); // suppressed (a1 live)
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING);
  hook(s, 'subagent-stop', { payload: { agent_id: 'a1' } }); // drains
  hook(s, 'ready'); // the resumed turn's Stop, count 0 -> completes
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE);
  s.destroy();
});

test('synchronous sub-agent: Start then Stop then a main Stop completes (no regression)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING);
  hook(s, 'subagent-start', { payload: { agent_id: 'a1' } });
  hook(s, 'subagent-stop', { payload: { agent_id: 'a1' } }); // finishes before the main Stop
  hook(s, 'ready');
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE);
  s.destroy();
});

test('subagent-start/stop are tracking signals: no transition of their own', () => {
  const s = makeSession(STATES.RUNNING);
  const before = s.auditLog.length;
  hook(s, 'subagent-start', { payload: { agent_id: 'a1' } });
  hook(s, 'subagent-stop', { payload: { agent_id: 'a1' } });
  assert.equal(s.state, STATES.RUNNING);
  assert.equal(s.auditLog.length, before);
  s.destroy();
});

test('agents-change tracks the live count and toSnapshot carries activeAgents', () => {
  const s = makeSession(STATES.RUNNING);
  const counts = [];
  s.on('agents-change', (e) => counts.push(e.activeAgents));
  hook(s, 'subagent-start', { payload: { agent_id: 'a1' } });
  hook(s, 'subagent-start', { payload: { agent_id: 'a2' } });
  assert.equal(s.toSnapshot().activeAgents, 2);
  hook(s, 'subagent-stop', { payload: { agent_id: 'a1' } });
  assert.equal(s.toSnapshot().activeAgents, 1);
  assert.deepEqual(counts, [1, 2, 1]);
  s.destroy();
});

test('a duplicate SubagentStart does not double-count; an unknown SubagentStop is a no-op', () => {
  const s = makeSession(STATES.RUNNING);
  hook(s, 'subagent-start', { payload: { agent_id: 'a1' } });
  hook(s, 'subagent-start', { payload: { agent_id: 'a1' } }); // dup
  assert.equal(s.toSnapshot().activeAgents, 1);
  hook(s, 'subagent-stop', { payload: { agent_id: 'ghost' } }); // never started
  assert.equal(s.toSnapshot().activeAgents, 1);
  hook(s, 'subagent-stop', { payload: { agent_id: 'a1' } });
  assert.equal(s.toSnapshot().activeAgents, 0);
  s.destroy();
});

test('a SubagentStart with no agent_id is ignored (defensive)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING);
  hook(s, 'subagent-start', { payload: {} }); // no agent_id -> untracked
  assert.equal(s.toSnapshot().activeAgents, 0);
  hook(s, 'ready'); // nothing tracked -> completes normally
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE);
  s.destroy();
});

test('detectBackgroundAgents=false restores prior behavior (Stop completes despite a sub-agent signal)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING, { detectBackgroundAgents: false });
  hook(s, 'subagent-start', { payload: { agent_id: 'a1' } });
  hook(s, 'ready');
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE);
  assert.equal(s.toSnapshot().activeAgents, 0);
  s.destroy();
});

// --- Stop payload background_tasks (v2.1.145+): authoritative gate over the counted map ---
// Covers background Bash tasks and native-team teammates, which never fire SubagentStart.

test('background_tasks on Stop suppresses completion even with zero counted sub-agents', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING);
  hook(s, 'ready', { payload: { background_tasks: [{ id: 'bash-1' }] } });
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING, 'background Bash still running: no COMPLETE');
  assert.equal(s.toSnapshot().activeAgents, 1, 'declared count rides the snapshot chip');
  s.destroy();
});

test('a later Stop with empty background_tasks completes (self-correcting drain)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING);
  hook(s, 'ready', { payload: { background_tasks: [{ id: 'bash-1' }] } });
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING);
  hook(s, 'ready', { payload: { background_tasks: [] } }); // the resumed turn's Stop
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE);
  assert.equal(s.toSnapshot().activeAgents, 0);
  s.destroy();
});

test('resume clears a stale background_tasks override (new turn, fresh snapshot)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING);
  hook(s, 'ready', { payload: { background_tasks: [{ id: 'b1' }] } });
  t.mock.timers.tick(40);
  assert.equal(s.toSnapshot().activeAgents, 1);
  hook(s, 'resume'); // UserPromptSubmit
  assert.equal(s.toSnapshot().activeAgents, 0);
  s.destroy();
});

test('SubagentStop with background_tasks:[] drains the counted map (dropped-Start/Stop recovery)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING);
  hook(s, 'subagent-start', { payload: { agent_id: 'a1' } });
  hook(s, 'subagent-start', { payload: { agent_id: 'a2' } });
  assert.equal(s.toSnapshot().activeAgents, 2);
  // a1's stop was dropped; a2's stop carries the authoritative empty count.
  hook(s, 'subagent-stop', { payload: { agent_id: 'a2', background_tasks: [] } });
  assert.equal(s.toSnapshot().activeAgents, 0, 'authoritative drain beats the TTL prune');
  hook(s, 'ready');
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE);
  s.destroy();
});

test('a stale background_tasks override ages out (TTL), so a hung task cannot pin RUNNING forever', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING, { agentTtlMs: 150 });
  hook(s, 'ready', { payload: { background_tasks: [{ id: 'hung' }] } });
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING, 'suppressed while the override is fresh');
  t.mock.timers.tick(150); // past agentTtlMs with no refreshing Stop
  assert.equal(s.toSnapshot().activeAgents, 0, 'override pruned lazily like the counted map');
  hook(s, 'ready');
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE, 'completion recovers after the TTL');
  s.destroy();
});

test('detectBackgroundAgents=false ignores background_tasks payloads too', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING, { detectBackgroundAgents: false });
  hook(s, 'ready', { payload: { background_tasks: [{ id: 'b1' }] } });
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE);
  s.destroy();
});

// --- /clear latch: SessionStart(source: clear|compact) resets detection and quiets titles ---

// Feeds the REAL title listener (the latch lives there), unlike the title() helper
// which ingests directly into the StatusSource.
function titleEvent(s, signal) {
  s._titleSource.emit('signal', { signal, source: 'title', ts: Date.now() });
}

test('/clear: title spinner+idle noise after SessionStart(clear) causes no transitions', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.COMPLETE);
  const seen = [];
  s.on('state-change', (e) => seen.push(e.to));
  hook(s, 'session-start', { payload: { source: 'clear' } });
  titleEvent(s, 'working'); // TUI redraw flashes a spinner
  titleEvent(s, 'ready');   // then the idle glyph
  t.mock.timers.tick(50);
  assert.equal(s.state, STATES.COMPLETE, 'no fake work cycle from /clear redraw');
  assert.deepEqual(seen, [], 'no transitions at all');
  s.destroy();
});

test('/clear: a held ready from the pre-clear turn is cancelled by SessionStart(clear)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING);
  hook(s, 'ready'); // held for the conflict window
  hook(s, 'session-start', { payload: { source: 'clear' } }); // lands inside the window
  t.mock.timers.tick(50);
  assert.equal(s.state, STATES.RUNNING, 'stale ready must not resolve after a clear');
  s.destroy();
});

test('/clear latch: the next real prompt unlatches and titles work again', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.IDLE);
  hook(s, 'session-start', { payload: { source: 'compact' } });
  titleEvent(s, 'working');
  assert.equal(s.state, STATES.IDLE, 'latched: title working ignored');
  hook(s, 'resume'); // UserPromptSubmit -> RUNNING and unlatch
  assert.equal(s.state, STATES.RUNNING);
  hook(s, 'ready');
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE, 'post-prompt cycle completes normally');
  s.destroy();
});

test('SessionStart(source: startup) does not latch or reset (only clear/compact)', () => {
  const s = makeSession(STATES.IDLE);
  hook(s, 'session-start', { payload: { source: 'startup' } });
  titleEvent(s, 'working');
  assert.equal(s.state, STATES.RUNNING, 'titles still flow after a normal SessionStart');
  s.destroy();
});

// --- idle_prompt demotion: an idle nudge only completes from RUNNING ---

test('a low-confidence hook ready (idle_prompt) does NOT complete a fresh IDLE session', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.IDLE);
  hook(s, 'ready', { confidence: 'low' }); // Notification(idle_prompt) via mapHookConfidence
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.IDLE, 'a session that never ran must not report finished');
  s.destroy();
});

test('a low-confidence hook ready still completes from RUNNING (quiescence confirmed)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING);
  hook(s, 'ready', { confidence: 'low' });
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE);
  s.destroy();
});
