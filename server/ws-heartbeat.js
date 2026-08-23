'use strict';

/*
 * The IO shell around server/core/heartbeat-core.js: one interval, both WebSocket servers, protocol
 * ping frames, and terminate on silence. Every side effect is injected so a test can drive a zombie
 * socket through the whole path without a real TCP connection.
 *
 * Protocol PING, not an application message: a browser answers it in the WebSocket layer with no page
 * code involved, so it probes the socket rather than the tab. The existing app-level `ping` request in
 * public/control-ws.js is client-initiated and fires only on wake, which is why it never removed a
 * zombie from the server's presence count.
 */

const { planHeartbeatSweep, DEFAULT_INTERVAL_MS, DEFAULT_DEADLINE_MS } = require('./core/heartbeat-core');

/**
 * @param {object} deps
 * @param {Array<{ clients: Iterable }>} deps.servers the WebSocket servers to sweep (control + data)
 * @param {function} [deps.onTerminate] called with each socket dropped for silence
 */
function createHeartbeat({
  servers = [],
  intervalMs = DEFAULT_INTERVAL_MS,
  deadlineMs = DEFAULT_DEADLINE_MS,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onTerminate = () => {},
  warn = console.warn,
} = {}) {
  let timer = null;

  // Any traffic proves the socket is alive, not only a pong: a client sending control messages is
  // plainly reachable, and a busy connection should never be probed into a false positive.
  function track(ws) {
    ws.glissaLastSeenAt = now();
    const seen = () => { ws.glissaLastSeenAt = now(); };
    ws.on('pong', seen);
    ws.on('message', seen);
  }

  function sweep() {
    for (const server of servers) {
      const clients = [...(server?.clients || [])];
      const { terminate, ping } = planHeartbeatSweep(
        clients.map((ws) => ({ key: ws, lastSeenAt: ws.glissaLastSeenAt })),
        { now: now(), deadlineMs }
      );
      for (const ws of terminate) {
        // terminate(), not close(): a half-open socket never answers a close handshake, so a graceful
        // close would leave it in the client set (and in the presence count) exactly as before.
        try { ws.terminate(); } catch { /* already gone */ }
        onTerminate(ws);
      }
      for (const ws of ping) {
        try { ws.ping(); } catch (error) { warn(`[heartbeat] ping failed: ${error.message}`); }
      }
    }
  }

  function start() {
    if (timer) return;
    timer = setIntervalFn(sweep, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (!timer) return;
    clearIntervalFn(timer);
    timer = null;
  }

  return { track, sweep, start, stop };
}

module.exports = { createHeartbeat };
