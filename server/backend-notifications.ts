import type { WebSocket } from 'ws';
import { NotificationManager } from '../notifications/notification-manager.ts';
import { createTelegramChannel, decideTelegramNotification } from '../notifications/channels/telegram.ts';
import { createToastChannel } from '../notifications/channels/toast.ts';
import { createWebNotificationChannel } from '../notifications/channels/web-notification.ts';
import { createTelegramCompletionDefer } from '../notifications/telegram-completion-defer.ts';
import { createTelegramOutbox } from '../notifications/telegram-outbox.ts';
import type { Session } from '../session/sessions.ts';
import type { ControlBroadcast } from './backend-websockets.ts';
import { createClientPresence } from './core/client-presence.ts';
import { configSiblingPath } from './pairings-store.ts';
import { sendTelegramMessage } from './telegram-transport.ts';
import { createHeartbeat } from './ws-heartbeat.ts';

const ESCALATION_INTERVAL_MS = 300000;
const DEFAULT_PHONE_ESCALATION_MS = 300000;

interface NotificationConfig {
  phoneEscalationMs?: number;
  notifyDebounceMs?: number;
  osToast?: boolean;
  telegramNotifications?: boolean;
  telegram?: { botToken?: string; chatId?: string } | null;
}

interface NotificationWsServer {
  clients: Iterable<WebSocket>;
  on(event: 'connection', listener: (socket: WebSocket) => void): unknown;
}

interface BackendNotificationDependencies {
  config: NotificationConfig;
  configStore: { configPath: string };
  sessions: Map<string, Session>;
  controlWss: NotificationWsServer;
  dataWss: NotificationWsServer;
  broadcastControl: ControlBroadcast;
  logger: Pick<Console, 'warn'>;
}

function createBackendNotifications(dependencies: BackendNotificationDependencies) {
  const { config, configStore, sessions, controlWss, dataWss, broadcastControl, logger } = dependencies;
  const clientPresence = createClientPresence();
  const phoneEscalationMs = () => (
    config.phoneEscalationMs == null ? DEFAULT_PHONE_ESCALATION_MS : config.phoneEscalationMs
  );
  const notificationManager = new NotificationManager({
    escalationIntervalMs: ESCALATION_INTERVAL_MS,
    debounceMs: config.notifyDebounceMs || 3000,
    phoneEscalationMs: phoneEscalationMs(),
  });
  notificationManager.registerChannel('web', createWebNotificationChannel(broadcastControl));
  if (config.osToast) notificationManager.registerChannel('toast', createToastChannel());

  const telegramOutbox = createTelegramOutbox({
    filePath: configSiblingPath(configStore.configPath, 'telegram-outbox.json'),
    send: (entry) => {
      const telegram = config.telegram || {};
      const botToken = telegram.botToken;
      const chatId = telegram.chatId;
      if (!botToken || !chatId) return Promise.resolve({ ok: false });
      return sendTelegramMessage({
        botToken,
        chatId,
        text: entry.text,
        tag: 'channel:telegram',
      });
    },
  });
  const sendTelegramNotification = createTelegramChannel({
    getConfig: () => config,
    getConnectionCount: () => clientPresence.connectionCount(),
    getActiveAgentCount: (sessionId: string) => sessions.get(sessionId)?.toSnapshot().activeAgents || 0,
    outbox: telegramOutbox,
  });
  const telegramChannel = createTelegramCompletionDefer({ deliver: sendTelegramNotification });
  notificationManager.registerChannel('telegram', telegramChannel, {
    offDashboard: true,
    canEscalate: () => decideTelegramNotification({
      enabled: config.telegramNotifications === true,
      botToken: config.telegram?.botToken,
      chatId: config.telegram?.chatId,
      connectionCount: 0,
      phoneEscalation: true,
    }).send,
  });
  void telegramOutbox.replay();

  function updateNotifySuppression(): void {
    notificationManager.setFocusSuppressed(clientPresence.shouldSuppress());
  }

  function handleClientFocus(socket: WebSocket, focused: boolean): void {
    clientPresence.setFocus(socket, focused);
    updateNotifySuppression();
  }

  controlWss.on('connection', (socket) => {
    clientPresence.connect(socket);
    updateNotifySuppression();
    socket.on('error', (error) => {
      logger.warn(`[control-ws] Error: ${error.message}`);
    });
    socket.on('close', () => {
      clientPresence.disconnect(socket);
      updateNotifySuppression();
    });
  });

  const heartbeat = createHeartbeat({ servers: [controlWss, dataWss] });
  controlWss.on('connection', (socket) => heartbeat.track(socket));
  dataWss.on('connection', (socket) => heartbeat.track(socket));
  heartbeat.start();
  const reviewSessions = new Map<string, Session>();
  const investigationSessions = new Map<string, Session>();
  notificationManager.on('notification-state-change', ({ session, from, to, event, category }) => {
    const liveSession = sessions.get(session);
    if (!liveSession) return;
    liveSession.recordNotifyDecision({ ts: Date.now(), kind: 'notify-state', from, to, event, category });
  });

  function applySettings(): void {
    notificationManager.updateSettings({
      escalationIntervalMs: ESCALATION_INTERVAL_MS,
      debounceMs: config.notifyDebounceMs || 3000,
      phoneEscalationMs: phoneEscalationMs(),
    });
  }

  return {
    applySettings,
    handleClientFocus,
    heartbeat,
    investigationSessions,
    notificationManager,
    reviewSessions,
    telegramChannel,
    telegramOutbox,
  };
}

type BackendNotifications = ReturnType<typeof createBackendNotifications>;

export { createBackendNotifications };
export type { BackendNotificationDependencies, BackendNotifications, NotificationConfig };
