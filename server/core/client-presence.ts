// Who is actually watching a dashboard right now, and what that implies for notification delivery.
// Pure bookkeeping over the OPEN control-WebSocket connections (the seam pattern used by
// session/core/agent-tracker.ts): no sockets, no timers, no IO. The backend registers one key per
// control connection and asks the two questions below.
//
// Remote mode is what made the old GLOBAL focus rule wrong. With a paired phone and a desk browser
// both connected, "any client reports focused" meant a dashboard left focused on the desk suppressed
// the phone forever - the notification was deferred until a screen nobody was at happened to blur.
// Suppression now requires that EVERY open connection reports focused: someone is definitely
// watching, on every screen there is.

export interface ClientPresence {
  connect: (key: unknown) => void;
  disconnect: (key: unknown) => void;
  setFocus: (key: unknown, focused: boolean) => void;
  connectionCount: () => number;
  shouldSuppress: () => boolean;
}

/**
 * Suppress only when there is at least one open connection and every one of them reports focused.
 * Zero connections never suppresses - nobody is watching, so the notification has to be delivered.
 * That zero case is also the crash case: a dashboard that dies while focused drops out of the count
 * on close, so it can never suppress forever (the bug shape this design must not reintroduce
 * per-connection).
 */
function decideFocusSuppression(focusStates: unknown): boolean {
  if (!Array.isArray(focusStates) || focusStates.length === 0) return false;
  return focusStates.every(Boolean);
}

/**
 * Whether an off-dashboard channel (Telegram) should carry a delivery. The web channel broadcasts to
 * every open control connection and the browser raises a native notification there, so an
 * off-dashboard ping is warranted exactly when NO connection is open: with a tab open anywhere the
 * operator already gets the browser notification on that device, and pinging the phone too would
 * double-notify. Deliberately NOT keyed on focus: an unfocused tab is precisely the case the browser
 * notification is FOR.
 */
function decideOffDashboardDelivery(connectionCount: number): boolean {
  return connectionCount === 0;
}

function createClientPresence(): ClientPresence {
  const focusedByConnection = new Map<unknown, boolean>(); // connection key -> its last reported focus

  // A fresh connection counts as UNFOCUSED until it reports otherwise. The client reports its focus
  // state on connect and on every focus/blur, and defaulting the other way would let one connection
  // that never reports suppress every notification for every device.
  function connect(key: unknown): void {
    if (focusedByConnection.has(key)) return;
    focusedByConnection.set(key, false);
  }

  function disconnect(key: unknown): void {
    focusedByConnection.delete(key);
  }

  // Tolerates a report from a connection that was never registered: two separate 'connection'
  // listeners are wired on the control server and their order is not guaranteed, so a focus report
  // must never be dropped for arriving first.
  function setFocus(key: unknown, focused: boolean): void {
    focusedByConnection.set(key, !!focused);
  }

  return {
    connect,
    disconnect,
    setFocus,
    connectionCount: () => focusedByConnection.size,
    shouldSuppress: () => decideFocusSuppression([...focusedByConnection.values()]),
  };
}

export { createClientPresence, decideFocusSuppression, decideOffDashboardDelivery };
