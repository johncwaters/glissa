import type { NotificationContext } from './notification-manager.ts';

const DEFAULT_TELEGRAM_COMPLETION_RECHECK_MS = 1000;

interface DeferredDelivery {
  sessionId: string;
  category: string;
  message: string;
  context?: Partial<NotificationContext>;
}

interface DeliveryDecision {
  reason?: string;
}

function createTelegramCompletionDefer({
  deliver,
  recheckMs = DEFAULT_TELEGRAM_COMPLETION_RECHECK_MS,
}: {
  deliver: (
    sessionId: string,
    category: string,
    message: string,
    context?: Partial<NotificationContext>,
  ) => DeliveryDecision | undefined;
  recheckMs?: number;
}) {
  const pendingCompletions = new Map<string, { delivery: DeferredDelivery; timer: NodeJS.Timeout }>();

  function cancel(sessionId: string): void {
    const pending = pendingCompletions.get(sessionId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingCompletions.delete(sessionId);
  }

  function schedule(delivery: DeferredDelivery): void {
    const pending = pendingCompletions.get(delivery.sessionId);
    if (pending) {
      pending.delivery = delivery;
      return;
    }
    const timer = setTimeout(() => {
      const latest = pendingCompletions.get(delivery.sessionId)?.delivery || delivery;
      pendingCompletions.delete(delivery.sessionId);
      send(latest);
    }, recheckMs);
    if (typeof timer.unref === 'function') timer.unref();
    pendingCompletions.set(delivery.sessionId, { delivery, timer });
  }

  function send(delivery: DeferredDelivery): DeliveryDecision | undefined {
    const decision = deliver(
      delivery.sessionId, delivery.category, delivery.message, delivery.context,
    );
    if (decision?.reason === 'active-agents') {
      schedule(delivery);
      return decision;
    }
    cancel(delivery.sessionId);
    return decision;
  }

  function channel(
    sessionId: string,
    category: string,
    message: string,
    context?: Partial<NotificationContext>,
  ): DeliveryDecision | undefined {
    if (category !== 'complete') cancel(sessionId);
    return send({ sessionId, category, message, context });
  }

  channel.recheck = (sessionId: string): void => {
    const pending = pendingCompletions.get(sessionId);
    if (!pending) return;
    const delivery = pending.delivery;
    cancel(sessionId);
    send(delivery);
  };
  channel.noteStateChange = cancel;
  channel.destroy = (): void => {
    for (const sessionId of pendingCompletions.keys()) cancel(sessionId);
  };
  return channel;
}

export { createTelegramCompletionDefer, DEFAULT_TELEGRAM_COMPLETION_RECHECK_MS };
