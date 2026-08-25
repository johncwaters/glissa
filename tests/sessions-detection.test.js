'use strict';

// Integration tests: StatusSource signals -> session state transitions (§4a matrix).
// Drives the REAL path (ingestHookSignal / statusSource.ingest -> _onStatus -> transition)
// with a short conflict window so `ready` resolves quickly and deterministically.

const test = require('node:test');
const assert = require('node:assert/strict');

const { Session } = require('../session/sessions');
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

// --- 'user-prompt' event: fired ONLY for an authoritative hook resume (UserPromptSubmit), so
// the backend's notify-cycle reset does not depend on winning the resume-vs-title-working race
// (both are immediate in status-source.js; see notify-gate.js and the MEDIUM fix notes) ---

test('a hook resume signal emits "user-prompt" (authoritative UserPromptSubmit)', () => {
  const s = makeSession(STATES.IDLE);
  const seen = [];
  s.on('user-prompt', () => seen.push('user-prompt'));
  hook(s, 'resume');
  assert.deepEqual(seen, ['user-prompt']);
  s.destroy();
});

test('a title working signal does NOT emit "user-prompt" (self-wake, not an authoritative prompt)', () => {
  const s = makeSession(STATES.IDLE);
  const seen = [];
  s.on('user-prompt', () => seen.push('user-prompt'));
  title(s, 'working');
  assert.deepEqual(seen, []);
  s.destroy();
});

test('subagent/task lifecycle signals do NOT emit "user-prompt"', () => {
  const s = makeSession(STATES.RUNNING);
  const seen = [];
  s.on('user-prompt', () => seen.push('user-prompt'));
  hook(s, 'subagent-start', { payload: { agent_id: 'a1' } });
  hook(s, 'subagent-stop', { payload: { agent_id: 'a1' } });
  hook(s, 'task-created', { payload: { task_id: 't1', teammate_name: 'x' } });
  hook(s, 'teammate-idle', { payload: { teammate_name: 'x' } });
  assert.deepEqual(seen, []);
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
  const { mapSignalToEvent } = require('../session/core/status-mapper');
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

// --- pendingPromptKind (WS3): advisory "what is this WAITING session waiting on" chip. Mirrors
// activeAgents/pendingWakeup - never gates a transition. See hook-source.js mapHookPromptKind. ---

test('awaiting-input with promptKind sets pendingPromptKind, surfaces in snapshot, emits prompt-kind-change once', () => {
  const s = makeSession(STATES.RUNNING);
  const deltas = [];
  s.on('prompt-kind-change', (e) => deltas.push(e.pendingPromptKind));
  hook(s, 'awaiting-input', { promptKind: 'permission' });
  assert.equal(s.state, STATES.WAITING);
  assert.equal(s.toSnapshot().pendingPromptKind, 'permission');
  assert.deepEqual(deltas, ['permission']);
  s.destroy();
});

test('awaiting-input with no promptKind leaves pendingPromptKind null (no false chip)', () => {
  const s = makeSession(STATES.RUNNING);
  const deltas = [];
  s.on('prompt-kind-change', (e) => deltas.push(e));
  hook(s, 'awaiting-input');
  assert.equal(s.toSnapshot().pendingPromptKind, null);
  assert.deepEqual(deltas, [], 'no change from null -> null, nothing emitted');
  s.destroy();
});

test('a resume signal clears pendingPromptKind', () => {
  const s = makeSession(STATES.RUNNING);
  hook(s, 'awaiting-input', { promptKind: 'elicitation' });
  assert.equal(s.toSnapshot().pendingPromptKind, 'elicitation');
  hook(s, 'resume');
  assert.equal(s.toSnapshot().pendingPromptKind, null);
  s.destroy();
});

test('a working signal (user answered) clears pendingPromptKind', () => {
  const s = makeSession(STATES.WAITING);
  hook(s, 'awaiting-input', { promptKind: 'permission' });
  title(s, 'working');
  assert.equal(s.state, STATES.RUNNING);
  assert.equal(s.toSnapshot().pendingPromptKind, null);
  s.destroy();
});

test('any transition leaving WAITING clears pendingPromptKind (direct user_input, not just working)', () => {
  const s = makeSession(STATES.RUNNING);
  hook(s, 'awaiting-input', { promptKind: 'permission' });
  assert.equal(s.state, STATES.WAITING);
  s.transition('user_input'); // backend.js manual-answer path (WAITING -> RUNNING)
  assert.equal(s.state, STATES.RUNNING);
  assert.equal(s.toSnapshot().pendingPromptKind, null);
  s.destroy();
});

test('/clear (SessionStart source: clear) clears pendingPromptKind', () => {
  const s = makeSession(STATES.RUNNING);
  hook(s, 'awaiting-input', { promptKind: 'elicitation' });
  s.ingestHookSignal({ signal: 'session-start', source: 'hook', ts: Date.now(), payload: { source: 'clear' } });
  assert.equal(s.toSnapshot().pendingPromptKind, null);
  s.destroy();
});

test('PTY exit clears pendingPromptKind', async () => {
  const s = makeSession(STATES.RUNNING);
  hook(s, 'awaiting-input', { promptKind: 'permission' });
  assert.equal(s.toSnapshot().pendingPromptKind, 'permission');
  await s._handlePtyExit(0, null);
  assert.equal(s.toSnapshot().pendingPromptKind, null);
  s.destroy();
});

test('restart (start()) clears a stale pendingPromptKind from a prior run', async () => {
  function fakePty(pid = 2147483646) {
    return { pid, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
  }
  const s = makeSession(STATES.WAITING, {
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: () => fakePty(),
  });
  hook(s, 'awaiting-input', { promptKind: 'permission' });
  assert.equal(s.toSnapshot().pendingPromptKind, 'permission');
  await s.start();
  assert.equal(s.toSnapshot().pendingPromptKind, null);
  s.destroy();
});

test('no idle/silence timer or content scraping remains - sessions.js AND the mapper (fail-closed)', () => {
  const fs = require('node:fs');
  const scrape = /_resetIdleTimer|isLayer4Chrome|patternDetector|hasPendingContent/;
  // require.resolve throws on a bad path, so a moved/renamed target FAILS CLOSED (never silently passes).
  for (const rel of ['../session/sessions.js', '../session/core/status-mapper.js']) {
    const src = fs.readFileSync(require.resolve(rel), 'utf8');
    assert.equal(scrape.test(src), false, `scrape pattern found in ${rel}`);
  }
});

test('no require of deleted detection modules remains in sessions.js', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../session/sessions.js'), 'utf8');
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

test('a forged SubagentStop cannot pre-drain a later authoritative Stop declaration', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING);
  hook(s, 'subagent-stop', { payload: { agent_id: 'future-agent' } });
  hook(s, 'ready', {
    payload: { background_tasks: [{ id: 'future-agent', type: 'subagent', status: 'running' }] },
  });
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING);
  assert.equal(s.toSnapshot().activeAgents, 1);
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

// --- Deferred completion: a gate-suppressed ready is HELD and released on drain, not dropped ---

test('a ready suppressed by a live sub-agent completes when the count drains (held, not dropped)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING, { gateReleaseSettleMs: 30 });
  hook(s, 'subagent-start', { payload: { agent_id: 'a1' } });
  hook(s, 'ready');
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING, 'gate suppresses while the sub-agent runs');
  hook(s, 'subagent-stop', { payload: { agent_id: 'a1' } });
  assert.equal(s.state, STATES.RUNNING, 'the drain starts the settle window, it does not complete instantly');
  assert.equal(s.toSnapshot().activeAgents, 0);
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE, 'drain releases the held ready once the settle window elapses');
  s.destroy();
});

// --- Settle window: a drain does not release instantly (a TeammateIdle/SubagentStop drain
// usually precedes the lead auto-resuming on the teammate's mailbox message a few seconds
// later, which fires no UserPromptSubmit hook) ---

test('a working signal inside the settle window cancels the release entirely (no COMPLETE ever fires)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING, { gateReleaseSettleMs: 30 });
  const seen = [];
  s.on('state-change', (e) => seen.push(e.to));
  hook(s, 'subagent-start', { payload: { agent_id: 'a1' } });
  hook(s, 'ready');
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING, 'gate suppresses while the sub-agent runs');
  hook(s, 'subagent-stop', { payload: { agent_id: 'a1' } }); // drains: arms the settle window
  title(s, 'working'); // the lead auto-resumed on the teammate's mailbox message
  t.mock.timers.tick(60); // well past the settle window
  assert.equal(s.state, STATES.RUNNING, 'the resume cancelled the pending release; still working');
  assert.equal(seen.includes(STATES.COMPLETE), false, 'must never have completed, not even transiently');
  s.destroy();
});

test('a quiet drain releases only after the settle window elapses, with detail.deferred true', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING, { gateReleaseSettleMs: 30 });
  let deferredDetail = null;
  s.on('state-change', (e) => { if (e.to === STATES.COMPLETE) deferredDetail = e.detail; });
  hook(s, 'subagent-start', { payload: { agent_id: 'a1' } });
  hook(s, 'ready');
  t.mock.timers.tick(40);
  hook(s, 'subagent-stop', { payload: { agent_id: 'a1' } }); // drains
  assert.equal(s.state, STATES.RUNNING, 'still RUNNING immediately after the drain, before the settle window elapses');
  t.mock.timers.tick(10);
  assert.equal(s.state, STATES.RUNNING, 'still RUNNING partway through the settle window');
  t.mock.timers.tick(25); // past the 30ms settle window
  assert.equal(s.state, STATES.COMPLETE, 'released once the settle window elapses with no cancelling activity');
  assert.equal(deferredDetail?.deferred, true, 'a released held ready carries deferred:true, like the old immediate release');
  s.destroy();
});

// --- Stale quiet window: gate evaluations are event/TTL driven, so a drain can land minutes
// after the last gated look. The first look after the drain must start a FRESH settle window;
// trusting the stale quiet timestamp released instantly and falsely COMPLETEd a card whose
// lead resumed on the teammate's mailbox message 8.5s later (incident 2026-08-14) ---

test('a drain long after the last gated look still waits the full settle window (2026-08-14)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING, { gateReleaseSettleMs: 30 });
  const seen = [];
  s.on('state-change', (e) => seen.push(e.to));
  hook(s, 'subagent-start', { payload: { agent_id: 'a1' } });
  hook(s, 'ready');
  t.mock.timers.tick(40); // stash + gated look; the recheck timer sits at the far-off teammate TTL
  assert.equal(s.state, STATES.RUNNING, 'held while a1 is live');
  t.mock.timers.tick(200); // long gap with no evaluation, well past the settle window
  hook(s, 'subagent-stop', { payload: { agent_id: 'a1' } }); // drain lands mid-gap
  assert.equal(s.state, STATES.RUNNING, 'the drain starts a fresh settle window, it does not release against the stale quiet timestamp');
  hook(s, 'subagent-start', { payload: { agent_id: 'a2' } }); // mailbox wake re-spawns inside the window
  t.mock.timers.tick(60);
  assert.equal(s.state, STATES.RUNNING, 'the reopened turn keeps the card working');
  assert.equal(seen.includes(STATES.COMPLETE), false, 'must never have completed, not even transiently');
  s.destroy();
});

test('a genuinely quiet drain after a long gated gap completes one settle window after the drain', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING, { gateReleaseSettleMs: 30 });
  hook(s, 'subagent-start', { payload: { agent_id: 'a1' } });
  hook(s, 'ready');
  t.mock.timers.tick(40);
  t.mock.timers.tick(200); // long gated gap, no evaluation
  hook(s, 'subagent-stop', { payload: { agent_id: 'a1' } }); // drain
  t.mock.timers.tick(10);
  assert.equal(s.state, STATES.RUNNING, 'partway through the fresh window');
  t.mock.timers.tick(25); // past the 30ms window measured from the drain
  assert.equal(s.state, STATES.COMPLETE, 'a truly settled drain still completes, one window after the drain');
  s.destroy();
});

test('repeated drain events do not extend the settle window (armed once)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING, { gateReleaseSettleMs: 30 });
  hook(s, 'subagent-start', { payload: { agent_id: 'a1' } });
  hook(s, 'ready');
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING, 'suppressed while a1 is live');
  hook(s, 'subagent-stop', { payload: { agent_id: 'a1' } }); // drains to 0: arms the settle window
  t.mock.timers.tick(20); // 20ms into the 30ms window
  s._emitAgentsChange(); // a second, redundant agents-change while already drained
  t.mock.timers.tick(20); // 40ms since the FIRST drain: past its 30ms window
  assert.equal(s.state, STATES.COMPLETE, 'the window was armed once at the first drain; the redundant emission did not push it out');
  s.destroy();
});

test('Stop declaring only a settled-status entry completes (defensive filter)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING);
  hook(s, 'subagent-start', { payload: { agent_id: 'tm1' } }); // its SubagentStop is never fired
  hook(s, 'ready', { payload: { background_tasks: [{ id: 'tm1', type: 'teammate', status: 'idle' }] } });
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE, 'a settled entry is not running background work');
  assert.equal(s.toSnapshot().activeAgents, 0, 'declared drain also empties the counted map');
  s.destroy();
});

// --- Teammate lifecycle (TaskCreated/TaskCompleted/TeammateIdle): precise per-id drains ---
// Ground truth (CC 2.1.199 binary): an idle-but-alive teammate stays status:running in the
// task registry until shutdown, so every Stop re-declares it in background_tasks. Only the
// TeammateIdle hook says it stopped gating.

test('TeammateIdle drains a declared running teammate and releases the held ready', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING, { gateReleaseSettleMs: 30 });
  hook(s, 'task-created', { payload: { task_id: 'tm-task', teammate_name: 'store-explore' } });
  hook(s, 'ready', { payload: { background_tasks: [{ id: 'tm-task', type: 'teammate', status: 'running' }] } });
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING, 'a running-declared teammate still gates');
  assert.equal(s.toSnapshot().activeAgents, 1);
  hook(s, 'teammate-idle', { payload: { teammate_name: 'store-explore' } });
  assert.equal(s.state, STATES.RUNNING, 'the drain starts the settle window, it does not complete instantly');
  assert.equal(s.toSnapshot().activeAgents, 0);
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE, 'TeammateIdle releases the gate-held ready once the settle window elapses');
  s.destroy();
});

test('an idled teammate stays drained across later Stops that re-declare it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING, { gateReleaseSettleMs: 30 });
  const declared = { background_tasks: [{ id: 'tm-task', type: 'teammate', status: 'running' }] };
  hook(s, 'task-created', { payload: { task_id: 'tm-task', teammate_name: 'store-explore' } });
  hook(s, 'ready', { payload: declared });
  t.mock.timers.tick(40);
  hook(s, 'teammate-idle', { payload: { teammate_name: 'store-explore' } });
  t.mock.timers.tick(40); // settle window
  assert.equal(s.state, STATES.COMPLETE);
  hook(s, 'resume'); // next user prompt; the teammate is still alive and idle
  assert.equal(s.state, STATES.RUNNING);
  hook(s, 'ready', { payload: declared }); // Stop re-declares the idle teammate as running
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE, 'the idle id survives resume and keeps filtering');
  s.destroy();
});

test('TeammateIdle without a name mapping still drains via the idle-by-name count against a single live teammate', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING, { gateReleaseSettleMs: 30 });
  // No TaskCreated seen (e.g. Glissa attached mid-run): name->id mapping unavailable.
  hook(s, 'ready', { payload: { background_tasks: [{ id: 'tm1', type: 'teammate', status: 'running' }] } });
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING);
  hook(s, 'teammate-idle', { payload: { teammate_name: 'unmapped' } });
  t.mock.timers.tick(40); // settle window
  assert.equal(s.state, STATES.COMPLETE, 'one idle name offsets the one declared teammate');
  s.destroy();
});

test('TeammateIdle with an unmapped name only offsets ONE of several live teammates (count-based, not a guess)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING);
  hook(s, 'ready', { payload: { background_tasks: [
    { id: 'tm1', type: 'teammate', status: 'running' },
    { id: 'tm2', type: 'teammate', status: 'running' },
  ] } });
  t.mock.timers.tick(40);
  hook(s, 'teammate-idle', { payload: { teammate_name: 'unmapped' } });
  assert.equal(s.state, STATES.RUNNING, 'one of two teammates is still live: no false COMPLETE');
  assert.equal(s.toSnapshot().activeAgents, 1, 'the idle name subtracts exactly one from the declared count');
  s.destroy();
});

test('three declared teammates each idle by name: the card COMPLETEs on the third TeammateIdle', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING, { gateReleaseSettleMs: 30 });
  const declared = { background_tasks: [
    { id: 'tm1', type: 'teammate', status: 'running' },
    { id: 'tm2', type: 'teammate', status: 'running' },
    { id: 'tm3', type: 'teammate', status: 'running' },
  ] };
  hook(s, 'ready', { payload: declared });
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING, 'a gate-held ready with three live teammates');
  assert.equal(s.toSnapshot().activeAgents, 3);
  hook(s, 'teammate-idle', { payload: { teammate_name: 'a' } });
  assert.equal(s.state, STATES.RUNNING);
  assert.equal(s.toSnapshot().activeAgents, 2);
  hook(s, 'teammate-idle', { payload: { teammate_name: 'b' } });
  assert.equal(s.state, STATES.RUNNING);
  assert.equal(s.toSnapshot().activeAgents, 1);
  hook(s, 'teammate-idle', { payload: { teammate_name: 'c' } });
  assert.equal(s.toSnapshot().activeAgents, 0);
  t.mock.timers.tick(40); // settle window
  assert.equal(s.state, STATES.COMPLETE, 'the third idle name drains the last teammate and releases the held ready');
  s.destroy();
});

test('a Stop declaring only a dream entry (pending self-revival) does not suppress completion', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING);
  hook(s, 'ready', { payload: { background_tasks: [{ id: 'wu1', type: 'dream', status: 'pending' }] } });
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE, 'a pending wakeup is a finished turn, per wakeup-tracker design');
  assert.equal(s.toSnapshot().activeAgents, 0);
  s.destroy();
});

test('a subagent-start whose agent_id embeds an idle teammate name re-gates it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING, { gateReleaseSettleMs: 30 });
  hook(s, 'ready', { payload: { background_tasks: [{ id: 'tm1', type: 'teammate', status: 'running' }] } });
  t.mock.timers.tick(40);
  hook(s, 'teammate-idle', { payload: { teammate_name: 'probe' } });
  t.mock.timers.tick(40); // settle window
  assert.equal(s.state, STATES.COMPLETE, 'the sole declared teammate idled by name');
  hook(s, 'resume'); // a new user turn; the idle-by-name record for "probe" survives this
  assert.equal(s.state, STATES.RUNNING);
  // The lead re-wakes "probe" via mailbox: no TaskCreated fires, only a fresh SubagentStart
  // whose agent_id embeds the name (live-captured shape "a<name>-<hex>").
  hook(s, 'subagent-start', { payload: { agent_id: 'aprobe-1a2b3c' } });
  hook(s, 'ready', { payload: { background_tasks: [{ id: 'tm1', type: 'teammate', status: 'running' }] } });
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING, 're-gated: the idle-by-name record was invalidated');
  assert.equal(s.toSnapshot().activeAgents, 1);
  s.destroy();
});

// --- Departed-teammate eviction: a stale idle-by-name record must not mask a DIFFERENT teammate ---

test('REGRESSION: a departed teammate idled by name does not mask a newly declared different teammate', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING, { gateReleaseSettleMs: 30 });
  hook(s, 'ready', { payload: { background_tasks: [{ id: 'alice-id', type: 'teammate', status: 'running' }] } });
  t.mock.timers.tick(40);
  hook(s, 'teammate-idle', { payload: { teammate_name: 'alice' } });
  t.mock.timers.tick(40); // settle window
  assert.equal(s.state, STATES.COMPLETE, 'alice idled by name completes the card');
  hook(s, 'resume'); // alice has since shut down; a new turn starts
  assert.equal(s.state, STATES.RUNNING);
  // bob is a DIFFERENT teammate under a different id. Naive count subtraction (no departure
  // eviction) would still see "1 declared teammate, 1 idle name" and wrongly offset bob.
  hook(s, 'ready', { payload: { background_tasks: [{ id: 'bob-id', type: 'teammate', status: 'running' }] } });
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING, 'bob is live and was never idled; alice departing must evict her stale record');
  assert.equal(s.toSnapshot().activeAgents, 1);
  s.destroy();
});

test('departed-teammate eviction only evicts as many idle names as teammates actually departed', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING, { gateReleaseSettleMs: 30 });
  hook(s, 'ready', { payload: { background_tasks: [
    { id: 't1', type: 'teammate', status: 'running' },
    { id: 't2', type: 'teammate', status: 'running' },
  ] } });
  t.mock.timers.tick(40);
  hook(s, 'teammate-idle', { payload: { teammate_name: 'a' } }); // offsets t1
  hook(s, 'teammate-idle', { payload: { teammate_name: 'b' } }); // offsets t2
  t.mock.timers.tick(40); // settle window
  assert.equal(s.state, STATES.COMPLETE, 'both teammates idle by name');
  hook(s, 'resume');
  // Only t1 departs; t2 is re-declared still running (still legitimately idle).
  hook(s, 'ready', { payload: { background_tasks: [{ id: 't2', type: 'teammate', status: 'running' }] } });
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE, 'exactly one name (the oldest, "a") is evicted for the one departure; "b" still legitimately offsets t2');
  assert.equal(s.toSnapshot().activeAgents, 0);
  s.destroy();
});

// --- The counted-map drain must key off the RAW declared count, never the name heuristic ---

test('a name-based zero must not wipe a live counted subagent from the counted map', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING);
  hook(s, 'subagent-start', { payload: { agent_id: 'sub1' } }); // unrelated live background subagent
  hook(s, 'ready', { payload: { background_tasks: [{ id: 't1', type: 'teammate', status: 'running' }] } });
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING, 'both sub1 and t1 still gate');
  hook(s, 'teammate-idle', { payload: { teammate_name: 'x' } }); // offsets t1 by name; sub1 untouched
  assert.equal(s.state, STATES.RUNNING, 'sub1 alone still gates');
  hook(s, 'ready', { payload: { background_tasks: [{ id: 't1', type: 'teammate', status: 'running' }] } }); // Stop re-declares t1
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING, 'sub1 must survive: the name-based zero is Glissa bookkeeping, not an authoritative drain');
  assert.equal(s.toSnapshot().activeAgents, 1, 'only sub1 remains counted; t1 is offset by the idle name');
  s.destroy();
});

// --- TaskCompleted must not leave a name behind once the same teammate drains by id ---

test('TaskCompleted carrying a teammate_name also clears any idle-by-name record for it (no double-count)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING);
  hook(s, 'ready', { payload: { background_tasks: [
    { id: 't1', type: 'teammate', status: 'running' },
    { id: 't2', type: 'teammate', status: 'running' },
  ] } });
  t.mock.timers.tick(40);
  hook(s, 'teammate-idle', { payload: { teammate_name: 'a' } }); // offsets t1 by name (unresolved)
  assert.equal(s.state, STATES.RUNNING, 't2 still gates');
  assert.equal(s.toSnapshot().activeAgents, 1);
  hook(s, 'task-completed', { payload: { task_id: 't1', teammate_name: 'a' } }); // t1 also drains by id
  assert.equal(s.state, STATES.RUNNING, 'still one live teammate (t2): draining t1 by id must not ALSO subtract the "a" name from t2');
  assert.equal(s.toSnapshot().activeAgents, 1);
  s.destroy();
});

// --- Re-gate prefix match must not fire on a different teammate name sharing a prefix ---

test('a subagent-start only re-gates when the remainder after "a<name>-" is pure hex (no false-prefix match)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING, { gateReleaseSettleMs: 30 });
  hook(s, 'ready', { payload: { background_tasks: [{ id: 'tm1', type: 'teammate', status: 'running' }] } });
  t.mock.timers.tick(40);
  hook(s, 'teammate-idle', { payload: { teammate_name: 'foo' } });
  t.mock.timers.tick(40); // settle window
  assert.equal(s.state, STATES.COMPLETE, 'the sole declared teammate idled by name');
  hook(s, 'resume');
  // "foo-bar" is a DIFFERENT teammate that happens to share the "afoo-" prefix; its agent_id
  // must not re-gate the idle record for "foo" (the remainder "bar-1a2b" is not pure hex).
  hook(s, 'subagent-start', { payload: { agent_id: 'afoo-bar-1a2b' } });
  hook(s, 'subagent-stop', { payload: { agent_id: 'afoo-bar-1a2b' } }); // drain the counted noise, isolate the name check
  hook(s, 'ready', { payload: { background_tasks: [{ id: 'tm1', type: 'teammate', status: 'running' }] } });
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE, 'foo is still correctly idle; the false-prefix match must not have re-gated it');
  s.destroy();
});

test('a nameless TeammateIdle is dropped, not recorded under a synthetic key (it could never be re-gated)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING);
  hook(s, 'ready', { payload: { background_tasks: [{ id: 'tm1', type: 'teammate', status: 'running' }] } });
  t.mock.timers.tick(40);
  hook(s, 'teammate-idle', { payload: {} }); // defensive: ground truth says this never happens
  assert.equal(s.state, STATES.RUNNING, 'dropped: the declared teammate still gates');
  assert.equal(s.toSnapshot().activeAgents, 1);
  s.destroy();
});

test('a TeammateIdle arriving before any background_tasks snapshot exists still drains once a later Stop declares the teammate', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING);
  // No snapshot yet at all (not even a prior Stop): the idle name is recorded independent of
  // any declared entries and simply waits.
  hook(s, 'teammate-idle', { payload: { teammate_name: 'probe' } });
  assert.equal(s.state, STATES.RUNNING);
  hook(s, 'ready', { payload: { background_tasks: [{ id: 'tm1', type: 'teammate', status: 'running' }] } });
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE, 'the idle name persisted and offset the newly declared teammate');
  s.destroy();
});

test('idle-by-name records survive resume: a re-declaring Stop for the same idle teammate does not re-pin the card', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING, { gateReleaseSettleMs: 30 });
  const declared = { background_tasks: [{ id: 'tm1', type: 'teammate', status: 'running' }] };
  hook(s, 'ready', { payload: declared });
  t.mock.timers.tick(40);
  hook(s, 'teammate-idle', { payload: { teammate_name: 'probe' } });
  t.mock.timers.tick(40); // settle window
  assert.equal(s.state, STATES.COMPLETE);
  hook(s, 'resume'); // next user prompt; the idle-but-alive teammate is still declared by name
  assert.equal(s.state, STATES.RUNNING);
  hook(s, 'ready', { payload: declared }); // Stop re-declares the idle teammate as running
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE, 'the idle name survives resume and keeps offsetting the re-declared teammate');
  s.destroy();
});

test('TaskCompleted drains a declared background task without waiting for the next Stop', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING, { gateReleaseSettleMs: 30 });
  hook(s, 'ready', { payload: { background_tasks: [{ id: 'bash-1', type: 'shell', status: 'running' }] } });
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING);
  hook(s, 'task-completed', { payload: { task_id: 'bash-1' } });
  t.mock.timers.tick(40); // settle window
  assert.equal(s.state, STATES.COMPLETE);
  s.destroy();
});

test('TaskCreated reactivates an idled teammate so it gates again', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING, { gateReleaseSettleMs: 30 });
  const declared = { background_tasks: [{ id: 'tm-task', type: 'teammate', status: 'running' }] };
  hook(s, 'task-created', { payload: { task_id: 'tm-task', teammate_name: 'store-explore' } });
  hook(s, 'ready', { payload: declared });
  t.mock.timers.tick(40);
  hook(s, 'teammate-idle', { payload: { teammate_name: 'store-explore' } });
  t.mock.timers.tick(40); // settle window
  assert.equal(s.state, STATES.COMPLETE);
  hook(s, 'resume');
  hook(s, 'task-created', { payload: { task_id: 'tm-task', teammate_name: 'store-explore' } }); // re-tasked
  hook(s, 'ready', { payload: declared });
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING, 'the reactivated teammate gates the new turn');
  assert.equal(s.toSnapshot().activeAgents, 1);
  s.destroy();
});

// --- Idle-by-name persistence: TeammateIdle recorded independent of any declared snapshot ---

test('a TeammateIdle recorded after resume clears the snapshot still drains the next Stop', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING);
  hook(s, 'ready', { payload: { background_tasks: [{ id: 'tm1', type: 'teammate', status: 'running' }] } });
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING, 'the declared teammate still gates');
  hook(s, 'resume'); // clears the declared snapshot; the idle-by-name record is independent of it
  assert.equal(s.state, STATES.RUNNING);
  hook(s, 'teammate-idle', { payload: { teammate_name: 'x' } }); // no name mapping: recorded by name
  assert.equal(s.state, STATES.RUNNING);
  hook(s, 'ready', { payload: { background_tasks: [{ id: 'tm1', type: 'teammate', status: 'running' }] } });
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE, 'the idle name offsets the freshly declared teammate before this Stop is mapped');
  s.destroy();
});

test('a TeammateIdle recorded by name drains a gate-held ready without any further Stop', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING, { gateReleaseSettleMs: 30 });
  hook(s, 'subagent-start', { payload: { agent_id: 'a1' } });
  hook(s, 'ready');
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING, 'suppressed and held while a1 is live');
  hook(s, 'teammate-idle', { payload: { teammate_name: 'x' } }); // no declared snapshot yet: recorded by name
  assert.equal(s.state, STATES.RUNNING);
  hook(s, 'subagent-stop', {
    payload: { agent_id: 'a1', background_tasks: [{ id: 'tm1', type: 'teammate', status: 'running' }] },
  });
  t.mock.timers.tick(40); // settle window
  assert.equal(s.state, STATES.COMPLETE, 'a1 drains, the idle name offsets tm1, and the held ready releases');
  s.destroy();
});

// --- Shell/monitor task-notification leak backstop ---

test('a declared shell task stops gating past its TTL and the held ready is released', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING, { shellTaskTtlMs: 150, gateReleaseSettleMs: 30 });
  hook(s, 'ready', { payload: { background_tasks: [{ id: 'b1', type: 'shell', status: 'running' }] } });
  t.mock.timers.tick(100);
  assert.equal(s.state, STATES.RUNNING, 'still gating before the ttl boundary');
  t.mock.timers.tick(250); // past ttl + the release timer epsilon
  t.mock.timers.tick(40); // settle window (the ttl-timer drain also waits it out)
  assert.equal(s.state, STATES.COMPLETE, 'a lost task notification is bounded by the ttl');
  s.destroy();
});

test('a forty-minute external agent remains gated until its task notification resumes the turn', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING, { gateReleaseSettleMs: 30 });
  hook(s, 'ready', { payload: { background_tasks: [{ id: 'b1', type: 'shell', status: 'running' }] } });
  t.mock.timers.tick(40 * 60 * 1000);
  assert.equal(s.state, STATES.RUNNING);
  assert.equal(s.toSnapshot().activeAgents, 1);
  hook(s, 'resume', { payload: { prompt: '<task-notification><task-id>b1</task-id></task-notification>' } });
  assert.equal(s.state, STATES.RUNNING);
  assert.equal(s.toSnapshot().activeAgents, 0);
  hook(s, 'ready', { payload: { background_tasks: [] } });
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.COMPLETE);
  s.destroy();
});

// --- Declared teammate TTL: a teammate is near-redundant with the counted SubagentStart/Stop map,
// so a declared entry is bounded short (default 90s) instead of riding the full agent TTL ---

test('a declared teammate entry stops gating past its TTL and the held ready is released', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING, { teammateTaskTtlMs: 150, gateReleaseSettleMs: 30 });
  hook(s, 'ready', { payload: { background_tasks: [{ id: 'tm1', type: 'teammate', status: 'running' }] } });
  t.mock.timers.tick(100);
  assert.equal(s.state, STATES.RUNNING, 'still gating before the ttl boundary');
  t.mock.timers.tick(250); // past ttl + the release timer epsilon
  t.mock.timers.tick(40); // settle window (the ttl-timer drain also waits it out)
  assert.equal(s.state, STATES.COMPLETE, 'an idle-alive teammate never drains via hooks alone; the ttl releases the held ready');
  s.destroy();
});

test('a declared teammate entry younger than the TTL still gates', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING, { teammateTaskTtlMs: 500 });
  hook(s, 'ready', { payload: { background_tasks: [{ id: 'tm1', type: 'teammate', status: 'running' }] } });
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING, 'a fresh declared teammate still gates');
  assert.equal(s.toSnapshot().activeAgents, 1);
  t.mock.timers.tick(200); // well under the 500ms ttl
  assert.equal(s.state, STATES.RUNNING, 'still gates before the ttl boundary');
  s.destroy();
});

// A re-evaluation that finds the gate still gating must wait only the REMAINING life of the
// declared snapshot: it ages from the Stop that declared it, so a fresh full TTL from now bounded
// the stuck-WORKING window at up to 2x the TTL (live incident: a 60s-old snapshot got a fresh 90s).
test('a still-gated re-arm waits the remaining declared TTL, not a fresh full one', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING, { teammateTaskTtlMs: 300, gateReleaseSettleMs: 10 });
  hook(s, 'ready', { payload: { background_tasks: [{ id: 'tm1', type: 'teammate', status: 'running' }] } });
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING, 'the declared teammate gates the first ready');
  t.mock.timers.tick(160); // ~200ms into the declared entry's 300ms ttl
  // A second Stop carrying no background_tasks field re-stashes the hold WITHOUT refreshing the
  // snapshot, which is the shape that produced the doubled wait.
  hook(s, 'ready');
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING, 'still gated: the snapshot has ~60ms of ttl left');
  t.mock.timers.tick(120); // past the snapshot's REMAINING ttl (a fresh 300ms arm would still be pending)
  t.mock.timers.tick(20); // plus the settle window, measured from the look that observed the ttl drain
  assert.equal(s.state, STATES.COMPLETE, 'the re-arm fired on the remaining ttl, not 300ms from the re-stash');
  s.destroy();
});

test('an aged-out declared teammate does not let a leftover idle-by-name record clamp a still-live shell entry', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING, { teammateTaskTtlMs: 100 });
  hook(s, 'ready', { payload: { background_tasks: [
    { id: 'tm1', type: 'teammate', status: 'running' },
    { id: 'b1', type: 'shell', status: 'running' },
  ] } });
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING, 'both entries gate while fresh');
  assert.equal(s.toSnapshot().activeAgents, 2);
  // Recorded by name before the teammate ages out; once it ages out there is no surviving teammate
  // entry left for this name to offset.
  hook(s, 'teammate-idle', { payload: { teammate_name: 'unmapped' } });
  t.mock.timers.tick(120); // past teammateTaskTtlMs (100ms); well under the shell ttl
  assert.equal(s.toSnapshot().activeAgents, 1, 'the teammate aged out on its own; the idle name has nothing left to clamp, so the shell entry still gates');
  assert.equal(s.state, STATES.RUNNING, 'the shell entry alone keeps the card gated');
  s.destroy();
});

// Accepted risk, documented in agent-tracker.js: a teammate DOES fire SubagentStart/SubagentStop
// (unlike shell/monitor, which never get any completion hook at all), so the declared-entry TTL
// only matters when a SubagentStart was dropped AND the teammate is still genuinely working past
// the ttl. That early completion is self-correcting (the teammate's next hook activity, or the
// lead resuming on its mailbox, flips the card back to WORKING); the stuck-WORKING failure the
// short ttl fixes instead blocked operator actions and never self-corrected.
test('accepted risk: a dropped-SubagentStart teammate declared running stops gating at the teammate TTL', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING, { teammateTaskTtlMs: 150, gateReleaseSettleMs: 30 });
  // No subagent-start ever fired for this teammate (the hook was dropped): the counted map never
  // learns about it, so only the declared background_tasks entry (and its ttl) covers it.
  hook(s, 'ready', { payload: { background_tasks: [{ id: 'tm1', type: 'teammate', status: 'running' }] } });
  t.mock.timers.tick(100);
  assert.equal(s.state, STATES.RUNNING, 'still gates within the ttl window');
  t.mock.timers.tick(250); // past ttl + the release timer epsilon
  t.mock.timers.tick(40); // settle window (the ttl-timer drain also waits it out)
  assert.equal(s.state, STATES.COMPLETE, 'accepted risk: completes even if the teammate is still genuinely working past the ttl');
  s.destroy();
});

test('counted map coverage: a SubagentStart-counted teammate id keeps the card gated well past the teammate TTL', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING, { teammateTaskTtlMs: 100 });
  hook(s, 'subagent-start', { payload: { agent_id: 'tm1' } }); // the hook actually fired: counted map has it
  hook(s, 'ready', { payload: { background_tasks: [{ id: 'tm1', type: 'teammate', status: 'running' }] } });
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING);
  assert.equal(s.toSnapshot().activeAgents, 1);
  t.mock.timers.tick(300); // well past teammateTaskTtlMs=100; the declared entry ages out on its own
  assert.equal(s.toSnapshot().activeAgents, 1, 'the counted map (max with the aged-out declared count) still sees the live SubagentStart');
  assert.equal(s.state, STATES.RUNNING, 'real teammate work does not falsely complete at the teammate ttl');
  s.destroy();
});

test('newer activity cancels a held ready (drain later must not complete a resumed turn)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING);
  hook(s, 'subagent-start', { payload: { agent_id: 'a1' } });
  hook(s, 'ready');
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING);
  hook(s, 'resume'); // user re-prompted before the sub-agent finished
  hook(s, 'subagent-stop', { payload: { agent_id: 'a1' } });
  assert.equal(s.state, STATES.RUNNING, 'the stale ready must not fire on the new turn');
  s.destroy();
});

test('a fresh subagent-start invalidates a held ready (older ids draining must not complete)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING);
  hook(s, 'subagent-start', { payload: { agent_id: 'a1' } });
  hook(s, 'ready');
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING);
  hook(s, 'subagent-start', { payload: { agent_id: 'a2' } }); // new background work after the Stop
  hook(s, 'subagent-stop', { payload: { agent_id: 'a1' } });
  hook(s, 'subagent-stop', { payload: { agent_id: 'a2' } });
  assert.equal(s.state, STATES.RUNNING, 'the pre-a2 ready is stale; only a new Stop may complete');
  s.destroy();
});

test('a held ready still completes when the dropped SubagentStop only ages out (TTL timer)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING, { agentTtlMs: 150, gateReleaseSettleMs: 30 });
  hook(s, 'subagent-start', { payload: { agent_id: 'a1' } }); // its Stop is lost forever
  hook(s, 'ready');
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING, 'suppressed while the entry is fresh');
  t.mock.timers.tick(300); // past agentTtlMs + the release timer epsilon, no further hooks
  t.mock.timers.tick(40); // settle window (the ttl-timer drain also waits it out)
  assert.equal(s.state, STATES.COMPLETE, 'the TTL drain releases the held ready without any new signal');
  s.destroy();
});

test('a state change between stash and drain invalidates the held ready', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING);
  hook(s, 'subagent-start', { payload: { agent_id: 'a1' } });
  hook(s, 'ready');
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING);
  s.transition('prompt_detected'); // out-of-band move (bypasses _onStatus)
  assert.equal(s.state, STATES.WAITING);
  hook(s, 'subagent-stop', { payload: { agent_id: 'a1' } });
  assert.equal(s.state, STATES.WAITING, 'the drain must not complete a session that moved on');
  s.destroy();
});

test('destroy() with a held ready armed fires nothing after the TTL (timer hygiene)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING, { agentTtlMs: 150 });
  hook(s, 'subagent-start', { payload: { agent_id: 'a1' } });
  hook(s, 'ready');
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING);
  s.destroy();
  const stateAtDestroy = s.state;
  t.mock.timers.tick(400); // past agentTtlMs + release epsilon
  assert.equal(s.state, stateAtDestroy, 'no post-destroy transition from the release timer');
});

test('destroy() with the settle timer armed (drained to 0) fires nothing after the window (timer hygiene)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = makeSession(STATES.RUNNING, { gateReleaseSettleMs: 30 });
  const seen = [];
  s.on('state-change', (e) => seen.push(e.to));
  hook(s, 'subagent-start', { payload: { agent_id: 'a1' } });
  hook(s, 'ready');
  t.mock.timers.tick(40);
  assert.equal(s.state, STATES.RUNNING);
  hook(s, 'subagent-stop', { payload: { agent_id: 'a1' } }); // drains to 0: arms the settle timer
  assert.equal(s.state, STATES.RUNNING, 'settle window just armed, not released yet');
  s.destroy();
  const stateAtDestroy = s.state;
  t.mock.timers.tick(200); // well past the 30ms settle window
  assert.equal(s.state, stateAtDestroy, 'no post-destroy transition from the settle timer');
  assert.equal(seen.includes(STATES.COMPLETE), false, 'destroy before the settle window elapses must never complete the card');
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
