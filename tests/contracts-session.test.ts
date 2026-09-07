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

  assert.equal(parsed.hasPlan, false);
  assert.equal(parsed.extension, true);
  assert.equal(parsed.pendingWakeup?.extension, true);
  assert.equal(PendingWakeup.parse({ at: null, kind: 'cron', reason: null, extension: true }).extension, true);
});

test('hasPlan rides the snapshot and defaults off for a session with no stored plan', () => {
  const session = new Session({ id: 'plan-flag', name: 'plan', path: process.cwd() });
  try {
    assert.equal(session.toSnapshot().hasPlan, false);
  } finally {
    session.destroy();
  }
});

test('hasPlan comes from the injected plan-review reader, never from a session field', () => {
  const asked: string[] = [];
  const session = new Session({
    id: 'plan-flag-on',
    name: 'plan',
    path: process.cwd(),
    planReviewPort: { hasPlan: (id) => { asked.push(id); return true; } },
  });
  try {
    assert.equal(session.toSnapshot().hasPlan, true);
    assert.deepEqual(asked, ['plan-flag-on']);
  } finally {
    session.destroy();
  }
});

test('SessionSnapshot shape matches a real Session.toSnapshot output', () => {
  const session = new Session({ id: 'snapshot-drift', name: 'snapshot', path: process.cwd() });
  try {
    assert.deepEqual(Object.keys(session.toSnapshot()).sort(), Object.keys(SessionSnapshot.shape).sort());
  } finally {
    session.destroy();
  }
});
