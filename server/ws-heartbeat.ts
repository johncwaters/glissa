import { DEFAULT_DEADLINE_MS, DEFAULT_INTERVAL_MS, planHeartbeatSweep } from './core/heartbeat-core.ts';

interface HeartbeatSocket {
  glissaLastSeenAt?: number;
  on: (event: string, listener: () => void) => unknown;
  terminate: () => void;
  ping: () => void;
}

interface HeartbeatServer {
  clients: Iterable<HeartbeatSocket>;
}

interface HeartbeatOptions {
  servers?: HeartbeatServer[];
  intervalMs?: number;
  deadlineMs?: number;
  now?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn?: (handle: NodeJS.Timeout) => void;
  onTerminate?: (socket: HeartbeatSocket) => void;
  warn?: (message: string) => void;
}

interface Heartbeat {
  track(ws: HeartbeatSocket): void;
  sweep(): void;
  start(): void;
  stop(): void;
}

function createHeartbeat({
  servers = [],
  intervalMs = DEFAULT_INTERVAL_MS,
  deadlineMs = DEFAULT_DEADLINE_MS,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onTerminate = () => {},
  warn = console.warn,
}: HeartbeatOptions = {}): Heartbeat {
  let timer: NodeJS.Timeout | null = null;

  function track(ws: HeartbeatSocket): void {
    ws.glissaLastSeenAt = now();
    const seen = () => { ws.glissaLastSeenAt = now(); };
    ws.on('pong', seen);
    ws.on('message', seen);
  }

  function sweep(): void {
    for (const server of servers) {
      const clients = [...(server?.clients || [])];
      const { terminate, ping } = planHeartbeatSweep(
        clients.map((ws) => ({ key: ws, lastSeenAt: ws.glissaLastSeenAt ?? now() })),
        { now: now(), deadlineMs },
      );
      for (const ws of terminate) {
        try { ws.terminate(); } catch {  }
        onTerminate(ws);
      }
      for (const ws of ping) {
        try {
          ws.ping();
        } catch (error) {
          warn(`[heartbeat] ping failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  function start(): void {
    if (timer) return;
    timer = setIntervalFn(sweep, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function stop(): void {
    if (!timer) return;
    clearIntervalFn(timer);
    timer = null;
  }

  return { track, sweep, start, stop };
}

export { createHeartbeat };
export type { Heartbeat, HeartbeatOptions, HeartbeatServer, HeartbeatSocket };
