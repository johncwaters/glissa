'use strict';

// Opt-in off-dashboard channel: session notifications (complete / waiting / failed) reach the
// operator's phone when there is no dashboard tab open anywhere to raise a browser notification.
//
// Dumb delivery pipe like the other channels - the lifecycle decision (which category fires, when,
// and the once-per-work-cycle gate) stays in NotificationManager and session/core/notify-gate.js.
// The only decision here is decideTelegramNotification below: whether THIS delivery has a reason to
// leave the machine at all.
//
// Registered unconditionally at boot and gated per delivery off live config, so flipping
// telegramNotifications takes effect immediately with no re-registration and no restart. With the
// key absent the gate short-circuits on the first line, which is why an unconfigured install
// behaves exactly as before.

const { sendTelegramMessage } = require('../../server/telegram-transport');
const { decideOffDashboardDelivery } = require('../../server/core/client-presence');

/**
 * Pure gate for one delivery.
 * @param {object} opts
 * @param {boolean} opts.enabled config.telegramNotifications
 * @param {string} opts.botToken config.telegram.botToken (shared with the PR-review lane)
 * @param {string} opts.chatId config.telegram.chatId
 * @param {number} opts.connectionCount open control-WS connections right now
 * @returns {{ send: boolean, reason: string }}
 */
function decideTelegramNotification({ enabled, botToken, chatId, connectionCount }) {
  if (enabled !== true) return { send: false, reason: 'disabled' };
  if (!botToken || !chatId) return { send: false, reason: 'not-configured' };
  if (!decideOffDashboardDelivery(connectionCount)) return { send: false, reason: 'dashboard-open' };
  return { send: true, reason: 'no-dashboard-audience' };
}

// Mirrors what the web notification shows: the manager's message already names the session, and the
// category is what the browser toast conveys through its own grouping. Plain text, no parse_mode.
function formatTelegramText(sessionName, category, message) {
  const body = message || `${sessionName} needs attention`;
  if (!category) return body;
  return `${category}: ${body}`;
}

/**
 * @param {object} deps
 * @param {() => object} deps.getConfig live config object (read per delivery, never captured)
 * @param {() => number} deps.getConnectionCount open control-WS connection count
 * @param {Function} [deps.send] injected transport for tests
 * @returns {(sessionName: string, category: string, message: string, context: object) => void}
 */
function createTelegramChannel({ getConfig, getConnectionCount, send = sendTelegramMessage }) {
  return function telegramChannel(sessionName, category, message, _context) {
    const config = getConfig() || {};
    const telegram = config.telegram || {};
    const decision = decideTelegramNotification({
      enabled: config.telegramNotifications === true,
      botToken: telegram.botToken,
      chatId: telegram.chatId,
      connectionCount: getConnectionCount(),
    });
    if (!decision.send) return;
    // Not awaited: sendTelegramMessage swallows its own failures, and a channel must never make the
    // manager's delivery loop wait on the network.
    send({
      botToken: telegram.botToken,
      chatId: telegram.chatId,
      text: formatTelegramText(sessionName, category, message),
      tag: 'channel:telegram',
    });
  };
}

module.exports = { createTelegramChannel, decideTelegramNotification, formatTelegramText };
