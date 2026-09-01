import test from 'node:test';
import assert from 'node:assert/strict';

import type { GlissaConfig } from '../server/config-store.ts';
import type { ControlMessageRecord } from '../server/control-replay-core.ts';
import type { Session } from '../session/sessions.ts';
import { connectControl, controlDeps, createControlServer, testConfigStore } from './helpers/control-harness.ts';
import { plainSession } from './helpers/fake-session.ts';

interface ResumeFrame {
  type: string;
  id?: string;
  ok?: boolean;
  message?: string;
  resumeSessionId?: string | null;
}

function harness(sessions: Map<string, Session>, config: GlissaConfig) {
  const broadcasts: ControlMessageRecord[] = [];
  const saveCalls: number[] = [];
  const server = createControlServer(controlDeps(config, {
    sessions,
    configStore: testConfigStore(config, { onSave: () => saveCalls.push(1) }),
    broadcastControl: (message) => { broadcasts.push(message); },
  }));
  const connection = connectControl<ResumeFrame>(server);
  connection.sent.length = 0;
  return { send: connection.send, sent: connection.sent, broadcasts, saveCalls };
}

test('resume-conversation persists the id, sets it on the session, broadcasts + acks', () => {
  const s = plainSession('p1');
  const cfg: GlissaConfig = { projects: [{ id: 'p1', name: 'p1', path: 'C:/repo' }] };
  const h = harness(new Map([['p1', s]]), cfg);

  h.send({ type: 'resume-conversation', id: 'p1', conversationId: '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5' });

  assert.equal(cfg.projects[0].resumeSessionId, '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5', 'persisted on project record');
  assert.equal(s.resumeSessionId, '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5', 'set on live session');
  const bc = h.broadcasts.find((m) => m.type === 'session-resume');
  assert.ok(bc && bc.id === 'p1' && bc.resumeSessionId === '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5', 'broadcast session-resume');
  const ack = h.sent.find((m) => m.type === 'resume-conversation-ack');
  assert.ok(ack && ack.ok === true, 'acked ok');
});

test('resume-conversation with an empty id clears the binding', () => {
  const s = plainSession('p1');
  s.setResumeConversation('prior-0000-0000-0000-000000000000');
  const cfg: GlissaConfig = { projects: [{ id: 'p1', name: 'p1', path: 'C:/repo', resumeSessionId: 'prior-0000-0000-0000-000000000000' }] };
  const h = harness(new Map([['p1', s]]), cfg);

  h.send({ type: 'resume-conversation', id: 'p1', conversationId: '' });

  assert.equal(cfg.projects[0].resumeSessionId, undefined, 'binding removed from project record');
  assert.equal(s.resumeSessionId, null, 'cleared on live session');
});

test('resume-conversation rejects an unsafe id without saving or mutating the session', () => {
  const s = plainSession('p1');
  const cfg: GlissaConfig = { projects: [{ id: 'p1', name: 'p1', path: 'C:/repo' }] };
  const h = harness(new Map([['p1', s]]), cfg);

  h.send({ type: 'resume-conversation', id: 'p1', conversationId: '../../etc/passwd' });

  assert.equal(h.saveCalls.length, 0, 'no persist for an invalid id');
  assert.equal(s.resumeSessionId, null, 'session untouched');
  const err = h.sent.find((m) => m.type === 'error');
  assert.ok(err && /invalid/i.test(String(err.message)), 'sent an invalid-id error');
});

test('resume-conversation on an unknown session replies with an error (no throw)', () => {
  const h = harness(new Map(), { projects: [] });
  assert.doesNotThrow(() => h.send({ type: 'resume-conversation', id: 'nope', conversationId: 'x'.repeat(12) }));
  const err = h.sent.find((m) => m.type === 'error');
  assert.ok(err && /not found/i.test(String(err.message)));
});

test('restart passes only boolean true as the fresh flag', () => {
  const restartOptions: { fresh?: boolean }[] = [];
  const forceRestartOptions: { fresh?: boolean }[] = [];
  const s = plainSession('p1');
  s.restart = (options = {}) => { restartOptions.push(options); return true; };
  s.forceRestart = (options = {}) => { forceRestartOptions.push(options); return true; };
  const cfg: GlissaConfig = { projects: [{ id: 'p1', name: 'p1', path: 'C:/repo' }] };
  const h = harness(new Map([['p1', s]]), cfg);

  h.send({ type: 'restart', id: 'p1', fresh: true });
  h.send({ type: 'force-restart', id: 'p1', fresh: 'true' });

  assert.deepEqual(restartOptions, [{ fresh: true }]);
  assert.deepEqual(forceRestartOptions, [{ fresh: false }]);
});
