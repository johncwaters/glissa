'use strict';

// Integration tests: StatusSource signals -> session state transitions (§4a matrix).
// Drives the REAL path (ingestHookSignal / statusSource.ingest -> _onStatus -> transition)
// with a short conflict window so `ready` resolves quickly and deterministically.

const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: sleep } = require('node:timers/promises');

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

test('working from IDLE -> RUNNING', () => {
  const s = makeSession(STATES.IDLE);
  title(s, 'working');
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

test('ready (hook) from RUNNING -> COMPLETE', async () => {
  const s = makeSession(STATES.RUNNING);
  hook(s, 'ready');
  await sleep(40);
  assert.equal(s.state, STATES.COMPLETE);
  s.destroy();
});

test('ready (hook) from WAITING -> COMPLETE (new edge, authoritative)', async () => {
  const s = makeSession(STATES.WAITING);
  hook(s, 'ready');
  await sleep(40);
  assert.equal(s.state, STATES.COMPLETE);
  s.destroy();
});

test('ready (hook) from IDLE -> COMPLETE (new edge, authoritative)', async () => {
  const s = makeSession(STATES.IDLE);
  hook(s, 'ready');
  await sleep(40);
  assert.equal(s.state, STATES.COMPLETE);
  s.destroy();
});

test('ready (title, low confidence) from WAITING does NOT complete', async () => {
  const s = makeSession(STATES.WAITING);
  title(s, 'ready');
  await sleep(40);
  assert.equal(s.state, STATES.WAITING);
  s.destroy();
});

test('ready (title) from RUNNING -> COMPLETE', async () => {
  const s = makeSession(STATES.RUNNING);
  title(s, 'ready');
  await sleep(40);
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

test('CONFLICT: Notification(idle->ready) + Stop(ready) racing awaiting-input -> WAITING, no spurious COMPLETE', async () => {
  const s = makeSession(STATES.RUNNING);
  const seen = [];
  s.on('state-change', (e) => seen.push(e.to));
  hook(s, 'ready'); // Stop
  await sleep(5);
  hook(s, 'awaiting-input'); // permission/idle prompt within conflict window
  await sleep(60);
  assert.equal(s.state, STATES.WAITING);
  assert.equal(seen.includes(STATES.COMPLETE), false, 'must not flip through COMPLETE');
  s.destroy();
});

test('DEDUP: double ready (Stop double-fire) -> single COMPLETE', async () => {
  const s = makeSession(STATES.RUNNING);
  const completes = [];
  s.on('state-change', (e) => { if (e.to === STATES.COMPLETE) completes.push(e); });
  hook(s, 'ready');
  hook(s, 'ready');
  await sleep(50);
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

test('state-change chain: COMPLETE and WAITING emit state-change (backend notification hook)', async () => {
  const s = makeSession(STATES.RUNNING);
  const events = [];
  s.on('state-change', (e) => events.push({ from: e.from, to: e.to }));
  hook(s, 'awaiting-input'); // -> WAITING
  assert.equal(events.at(-1).to, STATES.WAITING);
  title(s, 'working'); // WAITING -> RUNNING
  hook(s, 'ready'); // -> COMPLETE
  await sleep(40);
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

test('background sub-agent: a main Stop while a sub-agent is live does NOT complete', async () => {
  const s = makeSession(STATES.RUNNING);
  const seen = [];
  s.on('state-change', (e) => seen.push(e.to));
  hook(s, 'subagent-start', { payload: { agent_id: 'a1' } });
  hook(s, 'ready'); // main-agent Stop, but a1 is still running
  await sleep(40);
  assert.equal(s.state, STATES.RUNNING, 'must stay RUNNING while a background sub-agent runs');
  assert.equal(seen.includes(STATES.COMPLETE), false, 'must not flip through COMPLETE');
  s.destroy();
});

test('background sub-agent: after the sub-agent stops, a later Stop completes', async () => {
  const s = makeSession(STATES.RUNNING);
  hook(s, 'subagent-start', { payload: { agent_id: 'a1' } });
  hook(s, 'ready'); // suppressed (a1 live)
  await sleep(40);
  assert.equal(s.state, STATES.RUNNING);
  hook(s, 'subagent-stop', { payload: { agent_id: 'a1' } }); // drains
  hook(s, 'ready'); // the resumed turn's Stop, count 0 -> completes
  await sleep(40);
  assert.equal(s.state, STATES.COMPLETE);
  s.destroy();
});

test('synchronous sub-agent: Start then Stop then a main Stop completes (no regression)', async () => {
  const s = makeSession(STATES.RUNNING);
  hook(s, 'subagent-start', { payload: { agent_id: 'a1' } });
  hook(s, 'subagent-stop', { payload: { agent_id: 'a1' } }); // finishes before the main Stop
  hook(s, 'ready');
  await sleep(40);
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

test('a SubagentStart with no agent_id is ignored (defensive)', async () => {
  const s = makeSession(STATES.RUNNING);
  hook(s, 'subagent-start', { payload: {} }); // no agent_id -> untracked
  assert.equal(s.toSnapshot().activeAgents, 0);
  hook(s, 'ready'); // nothing tracked -> completes normally
  await sleep(40);
  assert.equal(s.state, STATES.COMPLETE);
  s.destroy();
});

test('detectBackgroundAgents=false restores prior behavior (Stop completes despite a sub-agent signal)', async () => {
  const s = makeSession(STATES.RUNNING, { detectBackgroundAgents: false });
  hook(s, 'subagent-start', { payload: { agent_id: 'a1' } });
  hook(s, 'ready');
  await sleep(40);
  assert.equal(s.state, STATES.COMPLETE);
  assert.equal(s.toSnapshot().activeAgents, 0);
  s.destroy();
});
