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

import { sendTelegramMessage } from '../../server/telegram-transport.js';
import { decideOffDashboardDelivery } from '../../server/core/client-presence.ts';
import type { NotificationContext } from '../notification-manager.ts';

export interface TelegramDecision {
  send: boolean;
  reason: string;
}

export interface TelegramGateInput {
  /** config.telegramNotifications, read strictly: only a literal true opens the gate */
  enabled: unknown;
  /** config.telegram.botToken (shared with the PR-review lane) */
  botToken: string | undefined;
  /** config.telegram.chatId */
  chatId: string | undefined;
  /** open control-WS connections right now */
  connectionCount: number;
  /**
   * The notification ladder's last rung: the operator was shown a browser notification and did not
   * acknowledge it, so a dashboard being open somewhere is exactly what this delivery disbelieves.
   * Everything else about the gate still applies - it is the AUDIENCE test that is bypassed, never
   * the opt-in or the credentials.
   */
  phoneEscalation?: boolean;
  category?: string | null;
  activeAgents?: number;
}

/** Pure gate for one delivery. */
function decideTelegramNotification({
  enabled,
  botToken,
  chatId,
  connectionCount,
  phoneEscalation = false,
  category = null,
  activeAgents = 0,
}: TelegramGateInput): TelegramDecision {
  if (enabled !== true) return { send: false, reason: 'disabled' };
  if (!botToken || !chatId) return { send: false, reason: 'not-configured' };
  if (category === 'complete' && activeAgents > 0) return { send: false, reason: 'active-agents' };
  if (phoneEscalation === true) return { send: true, reason: 'unacknowledged-escalation' };
  if (!decideOffDashboardDelivery(connectionCount)) return { send: false, reason: 'dashboard-open' };
  return { send: true, reason: 'no-dashboard-audience' };
}

// Mirrors what the web notification shows: the manager's message already names the session, and the
// category is what the browser toast conveys through its own grouping. Plain text, no parse_mode.
function formatTelegramText(sessionName: string, category: string | null, message: string): string {
  const body = message || `${sessionName} needs attention`;
  if (!category) return body;
  return `${category}: ${body}`;
}

export interface TelegramChannelDeps {
  /** live config object (read per delivery, never captured) */
  getConfig: () => { telegramNotifications?: boolean; telegram?: { botToken?: string; chatId?: string } | null } | null;
  /** open control-WS connection count */
  getConnectionCount: () => number;
  getActiveAgentCount?: (sessionId: string) => number;
  /** durable at-least-once queue; absent means fire-and-forget as before */
  outbox?: { deliver: (text: string) => Promise<void> } | null;
  /** injected transport for tests */
  send?: (message: { botToken: string; chatId: string; text: string; tag?: string }) => unknown;
}

function createTelegramChannel({
  getConfig,
  getConnectionCount,
  getActiveAgentCount = () => 0,
  outbox = null,
  send = sendTelegramMessage,
}: TelegramChannelDeps): (sessionName: string, category: string, message: string, context?: Partial<NotificationContext>) => TelegramDecision {
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

export {
  createTelegramChannel,
  decideTelegramNotification,
  formatTelegramText,
};
