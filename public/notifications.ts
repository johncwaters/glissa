import { claimKey, claimNotification } from './notify-dedupe-core.ts';
import { isNotificationsEnabled } from './ui-prefs.ts';

function getNotificationApi() {
  if (typeof Notification === 'undefined') return null;
  return Notification;
}

export function notificationsSupported() {
  return getNotificationApi() !== null;
}

export function notificationPermission() {
  const notificationApi = getNotificationApi();
  if (!notificationApi) return 'unavailable';
  return notificationApi.permission;
}

export async function ensureNotificationPermission(): Promise<NotificationPermission> {
  const notificationApi = getNotificationApi();
  if (!notificationApi) return 'denied';
  if (notificationApi.permission !== 'default') return notificationApi.permission;
  try {
    return await notificationApi.requestPermission();
  } catch {
    return notificationApi.permission;
  }
}

export function initNotifications() {
  const notificationApi = getNotificationApi();
  if (!notificationApi || !isNotificationsEnabled()) return;
  if (notificationApi.permission === 'default') {
    ensureNotificationPermission();
  }
}

export function showDesktopNotification({
  session,
  category,
  message,
  ignoreFocus = false,
}: { session?: unknown; category?: unknown; message?: unknown; ignoreFocus?: unknown; [key: string]: unknown } = {}) {
  const notificationApi = getNotificationApi();
  if (!notificationApi || !isNotificationsEnabled()) return;
  if (notificationApi.permission !== 'granted') return;

  if (!ignoreFocus && typeof document !== 'undefined' && typeof document.hasFocus === 'function' && document.hasFocus()) return;

  if (!claimNotification(window.localStorage, claimKey(session, category), Date.now())) return;
  try {
    const options = {
      body: String(message || 'Session needs attention'),
      tag: `glissa-${session || ''}-${category || ''}`,
      renotify: true,
    } as NotificationOptions;
    const n = new notificationApi('Glissa', options);
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
  }
}
