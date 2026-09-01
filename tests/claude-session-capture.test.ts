import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../session/sessions.ts';
import type { HookPayload } from '../shared/contracts/index.ts';
function makeSession(overrides = {}) {
  return new Session({ id: 'cap-id', name: 'cap', path: process.cwd(), ...overrides });
}

function sessionStart(s: Session, payload: HookPayload) {
  s.ingestHookSignal({ signal: 'session-start', source: 'hook', ts: Date.now(), payload });
}

function hook(s: Session, signal: string, payload: HookPayload) {
  s.ingestHookSignal({ signal, source: 'hook', ts: Date.now(), payload });
}

for (const signal of ['resume', 'ready', 'awaiting-input', 'session-end']) {
  test(`a ${signal} hook payload captures the live session id`, () => {
    const s = makeSession();
    const events: unknown[] = [];
    s.on('claude-session-id', (e) => events.push(e));
    const id = 'abcd1234-0000-0000-0000-abcdabcdabcd';
    hook(s, signal, { session_id: id });
    assert.equal(s.resumeSessionId, id, 'mirrored into the live resume binding');
    assert.equal(events.length, 1, 'emitted claude-session-id once');
    s.destroy();
  });
}

test('re-seeing the same id does not re-emit (config.json is written per emit, on a per-turn path)', () => {
  const s = makeSession();
  const events: unknown[] = [];
  s.on('claude-session-id', (e) => events.push(e));
  const id = 'abcd1234-0000-0000-0000-abcdabcdabcd';
  hook(s, 'resume', { session_id: id });
  hook(s, 'ready', { session_id: id });
  hook(s, 'ready', { session_id: id });
  assert.equal(events.length, 1, 'only an actual change is worth a disk write');
  assert.equal(s.resumeSessionId, id);
  s.destroy();
});

test('a resume after /clear re-captures the new id', () => {
  const s = makeSession();
  hook(s, 'ready', { session_id: 'abcd1234-0000-0000-0000-abcdabcdabcd' });
  hook(s, 'resume', { session_id: 'ffff9999-0000-0000-0000-ffffffffffff' });
  assert.equal(s.resumeSessionId, 'ffff9999-0000-0000-0000-ffffffffffff');
  s.destroy();
});

for (const signal of ['subagent-start', 'subagent-stop', 'task-created', 'task-completed', 'teammate-idle']) {
  test(`a ${signal} hook never rebinds the resume id`, () => {
    const s = makeSession();
    const events: unknown[] = [];
    s.on('claude-session-id', (e) => events.push(e));
    hook(s, signal, { session_id: 'eeee7777-0000-0000-0000-eeeeeeeeeeee', agent_id: 'a1', task_id: 't1', teammate_name: 'tm' });
    assert.equal(s.resumeSessionId, null);
    assert.equal(events.length, 0);
    s.destroy();
  });
}

for (const source of ['startup', 'resume', 'clear', 'compact', 'fork']) {
  test(`SessionStart(source: ${source}) with a valid session_id captures and mirrors it`, () => {
    const s = makeSession();
    const events: unknown[] = [];
    s.on('claude-session-id', (e) => events.push(e));
    const id = 'abcd1234-0000-0000-0000-abcdabcdabcd';
    sessionStart(s, { session_id: id, source });
    assert.equal(s.resumeSessionId, id, 'mirrored into the live resume binding');
    assert.equal(events.length, 1, 'emitted claude-session-id once');

    assert.deepEqual(events[0], { id, source, vendor: 'claude', sessionId: id });
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
  const events: unknown[] = [];
  s.on('claude-session-id', (e) => events.push(e));
  sessionStart(s, { source: 'startup' });
  assert.equal(s.resumeSessionId, null);
  assert.equal(events.length, 0);
  s.destroy();
});

test('a non-string session_id is a no-op', () => {
  const s = makeSession();
  const events: unknown[] = [];
  s.on('claude-session-id', (e) => events.push(e));
  sessionStart(s, { session_id: 12345, source: 'startup' });
  assert.equal(s.resumeSessionId, null);
  assert.equal(events.length, 0);
  s.destroy();
});

test('a malformed session_id (fails the shared shape check) is a no-op', () => {
  const s = makeSession();
  const events: unknown[] = [];
  s.on('claude-session-id', (e) => events.push(e));
  sessionStart(s, { session_id: 'nope', source: 'startup' });
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
