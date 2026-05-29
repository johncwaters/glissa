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

test('COMPLETE is reached ONLY via task_complete fired from _onStatus (no time/content rule)', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../sessions.js'), 'utf8');
  const calls = [...src.matchAll(/transition\("task_complete"/g)];
  // Exactly the two _onStatus call sites (RUNNING; WAITING/IDLE authoritative).
  assert.equal(calls.length, 2, `expected 2 task_complete call sites, found ${calls.length}`);
  // Both must be within the _onStatus method body (anchor on the definition,
  // not the constructor's `this._onStatus(s)` / `this._onMeta(m)` wiring refs).
  const onStatusIdx = src.indexOf('_onStatus(s) {');
  const nextMethodIdx = src.indexOf('_onMeta(m) {');
  for (const c of calls) {
    assert.ok(c.index > onStatusIdx && c.index < nextMethodIdx, 'task_complete must be fired from _onStatus');
  }
  // No idle/silence timer or content scraping remains.
  assert.equal(/_resetIdleTimer|isLayer4Chrome|patternDetector|hasPendingContent/.test(src), false);
});

test('no require of deleted detection modules remains', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../sessions.js'), 'utf8');
  assert.equal(/require\(["']\.\/(patterns|ansi-tokenizer|line-assembler|notify|completion-detector)["']\)/.test(src), false);
});
