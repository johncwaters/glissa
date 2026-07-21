'use strict';

// Crash-safe capture of the live Claude session_id off every SessionStart hook (graceful-
// shutdown-auto-resume plan, design A / step 2). Resume assigns Claude a NEW session id each
// time, so every source (startup/resume/clear/compact/fork) must re-capture, not just the
// clear/compact sources the existing quiet-title handling already special-cases.

const test = require('node:test');
const assert = require('node:assert/strict');

const { Session } = require('../session/sessions');

function makeSession(overrides = {}) {
  return new Session({ id: 'cap-id', name: 'cap', path: process.cwd(), ...overrides });
}

function sessionStart(s, payload) {
  s.ingestHookSignal({ signal: 'session-start', source: 'hook', ts: Date.now(), payload });
}

for (const source of ['startup', 'resume', 'clear', 'compact', 'fork']) {
  test(`SessionStart(source: ${source}) with a valid session_id captures and mirrors it`, () => {
    const s = makeSession();
    const events = [];
    s.on('claude-session-id', (e) => events.push(e));
    const id = 'abcd1234-0000-0000-0000-abcdabcdabcd';
    sessionStart(s, { session_id: id, source });
    assert.equal(s.resumeSessionId, id, 'mirrored into the live resume binding');
    assert.equal(events.length, 1, 'emitted claude-session-id once');
    assert.deepEqual(events[0], { id, source });
    s.destroy();
  });
}

test('a later SessionStart re-captures a new id (resume assigns a new id each time)', () => {
  const s = makeSession();
  sessionStart(s, { session_id: 'abcd1234-0000-0000-0000-abcdabcdabcd', source: 'startup' });
  sessionStart(s, { session_id: 'ffff9999-0000-0000-0000-ffffffffffff', source: 'resume' });
  assert.equal(s.resumeSessionId, 'ffff9999-0000-0000-0000-ffffffffffff');
  s.destroy();
});

test('missing session_id is a no-op', () => {
  const s = makeSession();
  const events = [];
  s.on('claude-session-id', (e) => events.push(e));
  sessionStart(s, { source: 'startup' });
  assert.equal(s.resumeSessionId, null);
  assert.equal(events.length, 0);
  s.destroy();
});

test('a non-string session_id is a no-op', () => {
  const s = makeSession();
  const events = [];
  s.on('claude-session-id', (e) => events.push(e));
  sessionStart(s, { session_id: 12345, source: 'startup' });
  assert.equal(s.resumeSessionId, null);
  assert.equal(events.length, 0);
  s.destroy();
});

test('a malformed session_id (fails the shared shape check) is a no-op', () => {
  const s = makeSession();
  const events = [];
  s.on('claude-session-id', (e) => events.push(e));
  sessionStart(s, { session_id: 'nope', source: 'startup' }); // too short
  sessionStart(s, { session_id: 'has spaces in it 1234', source: 'startup' });
  assert.equal(s.resumeSessionId, null);
  assert.equal(events.length, 0);
  s.destroy();
});

test('an absent payload entirely is a no-op (no throw)', () => {
  const s = makeSession();
  assert.doesNotThrow(() => {
    s.ingestHookSignal({ signal: 'session-start', source: 'hook', ts: Date.now() });
  });
  assert.equal(s.resumeSessionId, null);
  s.destroy();
});

test('capture does not disturb an already-bound resumeSessionId when the new hook is malformed', () => {
  const s = makeSession({ resumeSessionId: 'preexisting-0000-0000-0000-abcdabcdabcd' });
  sessionStart(s, { session_id: 'bad', source: 'startup' });
  assert.equal(s.resumeSessionId, 'preexisting-0000-0000-0000-abcdabcdabcd');
  s.destroy();
});
