'use strict';

// DEPRECATED: Notification delivery has moved to NotificationManager + channels/toast.js.
// These functions are no-ops kept for backward compatibility during migration.
// Remove this file once all consumers are confirmed migrated.

let _warnedNotify = false;
let _warnedSuppressed = false;

function notify() {
  if (!_warnedNotify) {
    console.warn('[notify] DEPRECATED: notify() is a no-op. Use NotificationManager instead.');
    _warnedNotify = true;
  }
}

function setNotifySuppressed() {
  if (!_warnedSuppressed) {
    console.warn('[notify] DEPRECATED: setNotifySuppressed() is a no-op. Use NotificationManager.setFocusSuppressed() instead.');
    _warnedSuppressed = true;
  }
}

function clearNotifyHistory() {
  // Never called in codebase — deprecated, no-op.
}

module.exports = { notify, setNotifySuppressed, clearNotifyHistory };
