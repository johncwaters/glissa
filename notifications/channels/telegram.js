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
 * @param {string|undefined} opts.botToken config.telegram.botToken (shared with the PR-review lane)
 * @param {string|undefined} opts.chatId config.telegram.chatId
 * @param {number} opts.connectionCount open control-WS connections right now
 * @param {string | null} [opts.category]
 * @param {number} [opts.activeAgents]
 * @param {boolean} [opts.phoneEscalation] this is the notification ladder's last rung: the operator
 *   was shown a browser notification and did not acknowledge it, so a dashboard being open somewhere
 *   is exactly what this delivery disbelieves. Everything else about the gate still applies - it is
 *   the AUDIENCE test that is bypassed, never the opt-in or the credentials.
 * @returns {{ send: boolean, reason: string }}
 */
function decideTelegramNotification({
  enabled,
  botToken,
  chatId,
  connectionCount,
  phoneEscalation = false,
  category = null,
  activeAgents = 0,
}) {
  if (enabled !== true) return { send: false, reason: 'disabled' };
  if (!botToken || !chatId) return { send: false, reason: 'not-configured' };
  if (category === 'complete' && activeAgents > 0) return { send: false, reason: 'active-agents' };
  if (phoneEscalation === true) return { send: true, reason: 'unacknowledged-escalation' };
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
 * @param {() => { telegramNotifications?: boolean, telegram?: { botToken?: string, chatId?: string } }} deps.getConfig live config object (read per delivery, never captured)
 * @param {() => number} deps.getConnectionCount open control-WS connection count
 * @param {(sessionId: string) => number} [deps.getActiveAgentCount]
 * @param {{ deliver: (text: string) => Promise<void> }|null} [deps.outbox] durable at-least-once queue; absent means fire-and-forget as before
 * @param {(message: { botToken: string, chatId: string, text: string, tag?: string }) => unknown} [deps.send] injected transport for tests
 * @returns {(sessionName: string, category: string, message: string, context?: { phoneEscalation?: boolean }) => { send: boolean, reason: string }}
 */
function createTelegramChannel({
  getConfig,
  getConnectionCount,
  getActiveAgentCount = () => 0,
  outbox = /** @type {{ deliver: (text: string) => Promise<void> }|null} */ (null),
  send = sendTelegramMessage,
}) {
  return function telegramChannel(sessionId, category, message, context) {
    const config = getConfig() || {};
    const telegram = config.telegram || {};
    const botToken = telegram.botToken;
    const chatId = telegram.chatId;
    const activeAgents = category === 'complete' ? getActiveAgentCount(sessionId) : 0;
    const decision = decideTelegramNotification({
      enabled: config.telegramNotifications === true,
      botToken,
      chatId,
      connectionCount: getConnectionCount(),
      phoneEscalation: context?.phoneEscalation === true,
      category,
      activeAgents,
    });
    if (!decision.send) return decision;
    if (!botToken || !chatId) return decision;
    const text = formatTelegramText(sessionId, category, message);
    /*
     * Through the outbox when there is one: the ping is recorded BEFORE it is attempted, so a crash
     * mid-send replays it at the next boot instead of losing it. The credentials are read at SEND
     * time, not queue time, so a replayed entry uses whatever config the new process holds.
     */
    if (outbox) {
      void outbox.deliver(text);
      return decision;
    }
    // Not awaited: sendTelegramMessage swallows its own failures, and a channel must never make the
    // manager's delivery loop wait on the network.
    send({
      botToken,
      chatId,
      text,
      tag: 'channel:telegram',
    });
    return decision;
  };
}

module.exports = {
  createTelegramChannel,
  decideTelegramNotification,
  formatTelegramText,
};
