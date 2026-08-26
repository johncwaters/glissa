'use strict';

const { NotificationManager } = require('../notifications/notification-manager');
const { createTelegramChannel, decideTelegramNotification } = require('../notifications/channels/telegram');
const { createToastChannel } = require('../notifications/channels/toast');
const { createWebNotificationChannel } = require('../notifications/channels/web-notification');
const { createTelegramCompletionDefer } = require('../notifications/telegram-completion-defer');
const { createTelegramOutbox } = require('../notifications/telegram-outbox');
const { createClientPresence } = require('./core/client-presence');
const { configSiblingPath } = require('./pairings-store');
const { sendTelegramMessage } = require('./telegram-transport');
const { createHeartbeat } = require('./ws-heartbeat');

const ESCALATION_INTERVAL_MS = 300000;
const DEFAULT_PHONE_ESCALATION_MS = 300000;

/**
 * @typedef {object} BackendNotificationDependencies
 * @property {{ phoneEscalationMs?: number, notifyDebounceMs?: number, osToast?: boolean,
 *   telegramNotifications?: boolean, telegram?: { botToken?: string, chatId?: string } }} config
 * @property {{ configPath: string }} configStore
 * @property {Map<string, { toSnapshot: () => { activeAgents?: number }, recordNotifyDecision: (entry: Record<string, unknown>) => void }>} sessions
 * @property {{ clients: Iterable<import('ws').WebSocket>, on: (event: string, listener: (socket: import('ws').WebSocket) => void) => unknown }} controlWss
 * @property {{ clients: Iterable<import('ws').WebSocket>, on: (event: string, listener: (socket: import('ws').WebSocket) => void) => unknown }} dataWss
 * @property {(message: Record<string, unknown>) => void} broadcastControl
 * @property {Pick<Console, 'warn'>} logger
 */

/** @param {BackendNotificationDependencies} dependencies */
function createBackendNotifications(dependencies) {
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
      if (!telegram.botToken || !telegram.chatId) return Promise.resolve({ ok: false });
      return sendTelegramMessage({
        botToken: telegram.botToken,
        chatId: telegram.chatId,
        text: entry.text,
        tag: 'channel:telegram',
      });
    },
  });
  const sendTelegramNotification = createTelegramChannel({
    getConfig: () => config,
    getConnectionCount: () => clientPresence.connectionCount(),
    getActiveAgentCount: (sessionId) => sessions.get(sessionId)?.toSnapshot().activeAgents || 0,
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

  function updateNotifySuppression() {
    notificationManager.setFocusSuppressed(clientPresence.shouldSuppress());
  }

  function handleClientFocus(socket, focused) {
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
  const reviewSessions = new Map();
  const investigationSessions = new Map();
  notificationManager.on('notification-state-change', ({ session, from, to, event, category }) => {
    const liveSession = sessions.get(session);
    if (!liveSession) return;
    liveSession.recordNotifyDecision({ ts: Date.now(), kind: 'notify-state', from, to, event, category });
  });

  function applySettings() {
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

module.exports = { createBackendNotifications };
