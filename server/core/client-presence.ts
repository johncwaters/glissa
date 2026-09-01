export interface ClientPresence {
  connect: (key: unknown) => void;
  disconnect: (key: unknown) => void;
  setFocus: (key: unknown, focused: boolean) => void;
  connectionCount: () => number;
  shouldSuppress: () => boolean;
}

function decideFocusSuppression(focusStates: unknown): boolean {
  if (!Array.isArray(focusStates) || focusStates.length === 0) return false;
  return focusStates.every(Boolean);
}

function decideOffDashboardDelivery(connectionCount: number): boolean {
  return connectionCount === 0;
}

function createClientPresence(): ClientPresence {
  const focusedByConnection = new Map<unknown, boolean>();

  function connect(key: unknown): void {
    if (focusedByConnection.has(key)) return;
    focusedByConnection.set(key, false);
  }

  function disconnect(key: unknown): void {
    focusedByConnection.delete(key);
  }

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
