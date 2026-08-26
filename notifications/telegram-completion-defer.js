'use strict';

const DEFAULT_TELEGRAM_COMPLETION_RECHECK_MS = 1000;

function createTelegramCompletionDefer({
  deliver,
  recheckMs = DEFAULT_TELEGRAM_COMPLETION_RECHECK_MS,
}) {
  const pendingCompletions = new Map();

  function cancel(sessionId) {
    const pending = pendingCompletions.get(sessionId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingCompletions.delete(sessionId);
  }

  function schedule(delivery) {
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
    if (timer.unref) timer.unref();
    pendingCompletions.set(delivery.sessionId, { delivery, timer });
  }

  function send(delivery) {
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

  function channel(sessionId, category, message, context) {
    if (category !== 'complete') cancel(sessionId);
    return send({ sessionId, category, message, context });
  }

  channel.recheck = (sessionId) => {
    const pending = pendingCompletions.get(sessionId);
    if (!pending) return;
    const delivery = pending.delivery;
    cancel(sessionId);
    send(delivery);
  };
  channel.noteStateChange = cancel;
  channel.destroy = () => {
    for (const sessionId of pendingCompletions.keys()) cancel(sessionId);
  };
  return channel;
}

module.exports = { createTelegramCompletionDefer, DEFAULT_TELEGRAM_COMPLETION_RECHECK_MS };
