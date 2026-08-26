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

import { claimKey, claimNotification } from './notify-dedupe-core.mjs';
import { isNotificationsEnabled } from './ui-prefs.js';

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

/**
 * Request notification permission once. Browsers may ignore requestPermission()
 * outside a user gesture, so the settings toggle (a real click) is the reliable
 * path; the boot call is best-effort. Resolves to the resulting permission.
 * @returns {Promise<NotificationPermission>}
 */
export async function ensureNotificationPermission() {
  const notificationApi = getNotificationApi();
  if (!notificationApi) return 'denied';
  if (notificationApi.permission !== 'default') return notificationApi.permission;
  try {
    return await notificationApi.requestPermission();
  } catch {
    return notificationApi.permission;
  }
}

// Best-effort prompt on boot when notifications are enabled and not yet decided.
export function initNotifications() {
  const notificationApi = getNotificationApi();
  if (!notificationApi || !isNotificationsEnabled()) return;
  if (notificationApi.permission === 'default') {
    ensureNotificationPermission();
  }
}

/**
 * Raise a native notification for a delivered server `notify` message.
 * Same tag per session+category dedupes across multiple open tabs and lets an
 * escalation re-fire replace the previous toast instead of stacking.
 * @param {{ session?: string, category?: string, message?: string, ignoreFocus?: boolean }} [msg]
 */
export function showDesktopNotification({ session, category, message, ignoreFocus = false } = {}) {
  const notificationApi = getNotificationApi();
  if (!notificationApi || !isNotificationsEnabled()) return;
  if (notificationApi.permission !== 'granted') return;
  // The server suppresses only while EVERY connected device reports focused (see
  // server/core/client-presence.js), so with a phone paired a focused desktop tab now DOES receive
  // notifications meant for the other screen. Decline here: the operator is already looking at this
  // window. This must run BEFORE the cross-tab claim below, or this tab would win the claim and then
  // stay silent, muting every other tab with it.
  // `ignoreFocus` is for an alert the server does NOT focus-suppress (a usage budget threshold): the
  // dashboard being focused says nothing about whether the operator is looking at the Usage tab, so
  // declining here would drop the alert entirely rather than avoid a duplicate.
  if (!ignoreFocus && typeof document !== 'undefined' && typeof document.hasFocus === 'function' && document.hasFocus()) return;
  // Cross-tab claim: every open tab receives the broadcast, and with renotify each
  // construction re-alerts, so only the tab that wins the short-TTL localStorage
  // claim raises the toast (see notify-dedupe-core.mjs). Fail-open on storage errors.
  if (!claimNotification(window.localStorage, claimKey(session, category), Date.now())) return;
  try {
    // renotify is what makes a re-fire on the same tag re-alert rather than silently replace; it is
    // shipped in every browser Glissa targets but is absent from TypeScript's NotificationOptions.
    const options = /** @type {NotificationOptions} */ ({
      body: message || 'Session needs attention',
      tag: `glissa-${session || ''}-${category || ''}`,
      renotify: true,
    });
    const n = new notificationApi('Glissa', options);
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // Notification construction can throw on some platforms/contexts; ignore -
    // the in-app card state still reflects status.
  }
}
