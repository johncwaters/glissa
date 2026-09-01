/*
 * The IO shell around server/core/heartbeat-core.ts: one interval, both WebSocket servers, protocol
 * ping frames, and terminate on silence. Every side effect is injected so a test can drive a zombie
 * socket through the whole path without a real TCP connection.
 *
 * Protocol PING, not an application message: a browser answers it in the WebSocket layer with no page
 * code involved, so it probes the socket rather than the tab. The existing app-level `ping` request in
 * public/control-ws.js is client-initiated and fires only on wake, which is why it never removed a
 * zombie from the server's presence count.
 */

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

  // Any traffic proves the socket is alive, not only a pong: a client sending control messages is
  // plainly reachable, and a busy connection should never be probed into a false positive.
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
        // terminate(), not close(): a half-open socket never answers a close handshake, so a graceful
        // close would leave it in the client set (and in the presence count) exactly as before.
        try { ws.terminate(); } catch { /* already gone */ }
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
