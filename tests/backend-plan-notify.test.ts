import test from 'node:test';
import assert from 'node:assert/strict';

import { createWebNotificationChannel } from '../notifications/channels/web-notification.ts';
import type { NotifyBroadcast } from '../notifications/channels/web-notification.ts';
import { NotificationManager } from '../notifications/notification-manager.ts';
import { createSessionEventWiring } from '../server/session-event-wiring.ts';
import { STATES } from '../shared/states.ts';
import { plainSession } from './helpers/fake-session.ts';

interface TriggeredNotification {
  id: string;
  category: string;
  message: string;
  kind: 'plan' | null;
}

function wiredSession(name: string, storedPlanTitle: string | null = null) {
  const session = plainSession('plan-notify-session', name);
  const triggered: TriggeredNotification[] = [];
  const titleLookups: string[] = [];
  const wireSessionEvents = createSessionEventWiring({
    configStore: { save: () => null },
    config: { projects: [] },
    recordLane: () => {},
    usage: { refreshSessions: () => {}, nudgeSession: () => {} },
    broadcastControl: () => {},
    telegramChannel: { noteStateChange: () => {}, recheck: () => {} },
    notificationManager: {
      acknowledge: () => {},
      trigger: (id, category, message, kind) => { triggered.push({ id, category, message, kind: kind ?? null }); },
    },
    getIngestLane: () => null,
    planReview: {
      attachSession: () => {},
      latestPlanTitle: (sessionId: string) => { titleLookups.push(sessionId); return storedPlanTitle; },
    },
    tapIngestForSession: () => {},
    closeSessionDataClients: () => {},
    logger: { error: () => {}, log: () => {}, warn: () => {} },
  });
  wireSessionEvents(session);
  return { session, triggered, titleLookups };
}

function enterWaiting(session: ReturnType<typeof wiredSession>['session']): void {
  session.emit('state-change', {
    from: STATES.RUNNING,
    to: STATES.WAITING,
    event: 'hook_awaiting_input',
    detail: { signal: 'awaiting-input' },
  });
}

test('a waiting notification names the plan the lane stored, read from the lane at notify time', () => {
  const { session, triggered, titleLookups } = wiredSession('worktree lane', 'Ship the rollout');
  session.emit('prompt-kind-change', { pendingPromptKind: 'plan' });
  enterWaiting(session);
  assert.deepEqual(triggered, [{
    id: 'plan-notify-session',
    category: 'waiting',
    message: 'worktree lane: Plan ready for review: Ship the rollout',
    kind: 'plan',
  }]);
  assert.deepEqual(titleLookups, ['plan-notify-session'], 'the copy comes from the lane that stored the plan');
});

test('an ordinary permission prompt keeps the copy it has today', () => {
  const { session, triggered } = wiredSession('worktree lane', 'Ship the rollout');
  session.emit('prompt-kind-change', { pendingPromptKind: 'permission' });
  enterWaiting(session);
  assert.equal(triggered[0]?.message, 'worktree lane needs your input');
});

test('a plan title read from an earlier turn never leaks into a later permission prompt', () => {
  const { session, triggered } = wiredSession('worktree lane', 'Ship the rollout');
  session.emit('prompt-kind-change', { pendingPromptKind: 'plan' });
  session.emit('prompt-kind-change', { pendingPromptKind: 'permission' });
  enterWaiting(session);
  assert.equal(triggered[0]?.message, 'worktree lane needs your input');
});

test('a plan the lane never stored falls back to the generic copy', () => {
  const { session, triggered } = wiredSession('worktree lane');
  session.emit('prompt-kind-change', { pendingPromptKind: 'plan' });
  enterWaiting(session);
  assert.equal(triggered[0]?.message, 'worktree lane needs your input');
});

test('only a plan prompt tags the notification with the kind the deep link branches on', () => {
  const { session, triggered } = wiredSession('worktree lane', 'Ship the rollout');
  session.emit('prompt-kind-change', { pendingPromptKind: 'plan' });
  enterWaiting(session);
  assert.equal(triggered[0]?.kind, 'plan');

  const plainWaiting = wiredSession('worktree lane');
  plainWaiting.session.emit('prompt-kind-change', { pendingPromptKind: 'permission' });
  enterWaiting(plainWaiting.session);
  assert.equal(plainWaiting.triggered[0]?.kind, null);
});

test('the plan kind survives the manager and reaches the notify message the browser reads', () => {
  const manager = new NotificationManager({ debounceMs: 0 });
  const broadcasts: NotifyBroadcast[] = [];
  manager.registerChannel('web', createWebNotificationChannel((msg) => { broadcasts.push(msg); }));

  manager.trigger('plan lane', 'waiting', 'plan lane: Plan ready for review: Ship the rollout', 'plan');
  manager.trigger('permission lane', 'waiting', 'permission lane needs your input');
  manager.destroy();

  assert.equal(broadcasts[0]?.kind, 'plan');
  assert.equal(Object.hasOwn(broadcasts[1] ?? {}, 'kind'), false);
});
