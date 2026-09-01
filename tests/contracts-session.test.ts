import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionSnapshot, PendingWakeup } from '../shared/contracts/session.ts';
import { Session } from '../session/sessions.ts';
test('SessionSnapshot preserves nested extension fields', () => {
  const parsed = SessionSnapshot.parse({
    id: 'session-1',
    name: 'glissa',
    path: '/repo/glissa',
    agent: 'claude-code',
    state: 'DORMANT',
    stateSince: 1,
    sleeping: false,
    dangerouslySkipPermissions: false,
    ephemeral: false,
    isWorktree: false,
    resumeSessionId: null,
    activeAgents: 0,
    packs: [],
    pendingWakeup: { at: 2, kind: 'cron', reason: null, extension: true },
    pendingPromptKind: null,
    mergeStatus: 'none',
    mergeReason: null,
    worktreeNotice: null,
    effectiveBase: null,
    auditLog: [],
    extension: true,
  });

  assert.equal(parsed.extension, true);
  assert.equal(parsed.pendingWakeup?.extension, true);
  assert.equal(PendingWakeup.parse({ at: null, kind: 'cron', reason: null, extension: true }).extension, true);
});

test('SessionSnapshot shape matches a real Session.toSnapshot output', () => {
  const session = new Session({ id: 'snapshot-drift', name: 'snapshot', path: process.cwd() });
  try {
    assert.deepEqual(Object.keys(session.toSnapshot()).sort(), Object.keys(SessionSnapshot.shape).sort());
  } finally {
    session.destroy();
  }
});
