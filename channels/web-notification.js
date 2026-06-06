'use strict';

/**
 * Create a Web Notification channel adapter for NotificationManager.
 *
 * Dumb delivery pipe — no debounce, no suppression logic (that lives in
 * NotificationManager). Instead of spawning an OS-level toast, it broadcasts a
 * `notify` control message over the existing control WebSocket. Each connected
 * dashboard client raises a native browser Notification (routed to the Windows
 * Action Center by the browser itself).
 *
 * Why this over the BurntToast/msg toast channel: that path depended on an
 * unbundled PowerShell module and a flaky `msg *` fallback, so it failed
 * silently on most machines. The dashboard is always open while Glissa is in
 * use, so the browser is the most reliable notification surface available and
 * needs no install step, no PowerShell, and no AppUserModelID registration.
 *
 * @param {(msg: object) => void} broadcast - control-WS broadcast function
 * @returns {(sessionName: string, category: string, message: string, context: object) => void}
 */
function createWebNotificationChannel(broadcast) {
  return function webNotificationChannel(sessionName, category, message, context) {
    broadcast({
      type: 'notify',
      session: sessionName,
      category,
      message,
      escalationCount: context ? context.escalationCount : 0,
    });
  };
}

module.exports = { createWebNotificationChannel };
