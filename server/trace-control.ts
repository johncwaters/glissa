import type { ControlBroadcast } from './backend-websockets.ts';

export const TRACE_CHANGE_COALESCE_MS = 250;

interface TraceAppendSource {
  on(event: 'trace-appended', listener: (payload: { id: string }) => void): unknown;
}

interface TraceChangeBroadcastOptions {
  source: TraceAppendSource;
  broadcast: ControlBroadcast;
  setTimeoutFunction?: (listener: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimeoutFunction?: (handle: NodeJS.Timeout) => void;
}

export function createTraceChangeBroadcast({
  source,
  broadcast,
  setTimeoutFunction = setTimeout,
  clearTimeoutFunction = clearTimeout,
}: TraceChangeBroadcastOptions) {
  const pendingBroadcastBySessionId = new Map<string, NodeJS.Timeout>();
  let isStopped = false;

  source.on('trace-appended', ({ id }) => {
    if (isStopped || !id) return;
    const pending = pendingBroadcastBySessionId.get(id);
    if (pending) clearTimeoutFunction(pending);
    const handle = setTimeoutFunction(() => {
      pendingBroadcastBySessionId.delete(id);
      if (isStopped) return;
      broadcast({ type: 'session-trace-changed', id });
    }, TRACE_CHANGE_COALESCE_MS);
    pendingBroadcastBySessionId.set(id, handle);
    if (typeof handle.unref === 'function') handle.unref();
  });

  function stop(): void {
    isStopped = true;
    for (const handle of pendingBroadcastBySessionId.values()) clearTimeoutFunction(handle);
    pendingBroadcastBySessionId.clear();
  }

  return { stop };
}
