// ── Desktop notifications ─────────────────────────────────────
// Native Web Notifications API. The browser routes these to the Windows Action
// Center using its own (already-registered) AppUserModelID, so there is no
// PowerShell, no external module, and no install step. This replaces the
// server-side BurntToast/msg toast path, which depended on an unbundled
// PowerShell module and failed silently on most machines.
//
// localhost is a secure context, so the Notifications API is available without
// HTTPS. Server-side focus suppression (NotificationManager) already gates
// delivery while the dashboard is focused, so this module trusts the server and
// shows whenever a `notify` message arrives and permission is granted.

import { isNotificationsEnabled } from './ui-prefs.js';

const supported = typeof window !== 'undefined' && 'Notification' in window;

export function notificationsSupported() {
  return supported;
}

/**
 * Request notification permission once. Browsers may ignore requestPermission()
 * outside a user gesture, so the settings toggle (a real click) is the reliable
 * path; the boot call is best-effort. Resolves to the resulting permission.
 * @returns {Promise<NotificationPermission>}
 */
export async function ensureNotificationPermission() {
  if (!supported) return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

// Best-effort prompt on boot when notifications are enabled and not yet decided.
export function initNotifications() {
  if (!supported || !isNotificationsEnabled()) return;
  if (Notification.permission === 'default') {
    ensureNotificationPermission();
  }
}

/**
 * Raise a native notification for a delivered server `notify` message.
 * Same tag per session+category dedupes across multiple open tabs and lets an
 * escalation re-fire replace the previous toast instead of stacking.
 * @param {{ session?: string, category?: string, message?: string }} msg
 */
export function showDesktopNotification({ session, category, message } = {}) {
  if (!supported || !isNotificationsEnabled()) return;
  if (Notification.permission !== 'granted') return;
  try {
    const n = new Notification('Glissa', {
      body: message || 'Session needs attention',
      tag: `glissa-${session || ''}-${category || ''}`,
      renotify: true,
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // Notification construction can throw on some platforms/contexts; ignore —
    // the in-app card state still reflects status.
  }
}
