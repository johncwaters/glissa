import { sendTelegramMessage } from '../../server/telegram-transport.ts';
import { decideOffDashboardDelivery } from '../../server/core/client-presence.ts';
import type { NotificationContext } from '../notification-manager.ts';

export interface TelegramDecision {
  send: boolean;
  reason: string;
}

export interface TelegramGateInput {
  enabled: unknown;

  botToken: string | undefined;

  chatId: string | undefined;

  connectionCount: number;

  phoneEscalation?: boolean;
  category?: string | null;
  activeAgents?: number;
}

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

function formatTelegramText(sessionName: string, category: string | null, message: string): string {
  const body = message || `${sessionName} needs attention`;
  if (!category) return body;
  return `${category}: ${body}`;
}

export interface TelegramChannelDeps {
  getConfig: () => { telegramNotifications?: boolean; telegram?: { botToken?: string; chatId?: string } | null } | null;

  getConnectionCount: () => number;
  getActiveAgentCount?: (sessionId: string) => number;

  outbox?: { deliver: (text: string) => Promise<void> } | null;

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

    if (outbox) {
      void outbox.deliver(text);
      return decision;
    }

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
