/*
 * Glissa Backend — Express + WebSocket server factory
 *
 * Control WebSocket additions:
 *   Client → Server: { type: 'shutdown' }
 *   Server → Client: { type: 'shutting-down' }
 *
 * Exports a single function `createBackend(httpServer, options)` that wires
 * Express middleware, control/data WebSocket servers, and session management
 * onto a provided HTTP server. Used by both:
 *   - server.js (production: standalone HTTP server)
 *   - vite.config.js (dev: attached to Vite's internal HTTP server)
 *
 * node-pty crash risk: Sessions spawn native PTY processes via node-pty.
 * If the Node process crashes without calling shutdown(), PTY child processes
 * may become orphaned. SIGINT handlers in server.js and the Vite plugin
 * mitigate this for graceful exits, but unexpected crashes (segfault, OOM)
 * cannot be caught. This is a known limitation of node-pty.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Session } = require('./sessions');
const { STATES } = require('./shared/states');
const { createConfigStore, generateProjectId, ensureProjectIds } = require('./config-store');
const { registerControlHandlers } = require('./control-handlers');
const { NotificationManager } = require('./notification-manager');
const { createToastChannel } = require('./channels/toast');
const { createRecorder } = require('./session-recorder');

function makeSession(project, cfg) {
  const session = new Session({
    id: project.id,
    name: project.name,
    path: project.path,
    dangerouslySkipPermissions: !!project.dangerouslySkipPermissions,
    startingWatchdogSeconds: cfg.startingWatchdogSeconds,
    attentionTimeoutSeconds: cfg.attentionTimeoutSeconds,
    waitingEscalationSeconds: cfg.waitingEscalationSeconds,
    autoRecoverSeconds: cfg.autoRecoverSeconds,
    inputGraceSeconds: cfg.inputGraceSeconds,
    promptDetectionMs: cfg.promptDetectionMs,
    replayBufferKB: cfg.replayBufferKB,
    noFlicker: cfg.noFlicker,
    feedDebounceMs: cfg.feedDebounceMs,
  });
  const recorder = createRecorder(project.name, cfg.capture);
  if (recorder) {
    session.setRecorder(recorder);
  }
  return session;
}

/**
 * Create and wire the Glissa backend onto an existing HTTP server.
 *
 * @param {import('http').Server} httpServer - HTTP server to attach to
 * @param {object} options
 * @param {string|null} options.staticDir
 *   'auto'  — detect dist/ vs public/ (production behavior)
 *   null    — skip static serving entirely (Vite mode)
 *   string  — absolute path to serve from
 * @returns {{ shutdown: () => void, port: number, app: import('express').Express }}
 */
function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // Non-browser clients (curl, ws CLI) have no Origin
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function createBackend(httpServer, options = {}) {
  const { staticDir = 'auto' } = options;

  const configStore = createConfigStore();
  const { config } = configStore;
  const port = process.env.GLISSA_PORT
    ? Number.parseInt(process.env.GLISSA_PORT, 10)
    : (config.port || 3000);

  // --- Express setup ---

  const app = express();

  if (staticDir === 'auto') {
    const distPath = path.join(__dirname, 'dist');
    const useDistDir = fs.existsSync(distPath) && fs.statSync(distPath).isDirectory();
    const resolvedDir = useDistDir ? 'dist' : 'public';
    app.use(express.static(path.join(__dirname, resolvedDir)));

    if (!useDistDir) {
      mountDevRoutes(app);
    }
  } else if (typeof staticDir === 'string') {
    app.use(express.static(staticDir));
  }
  // staticDir === null: skip all static serving (Vite mode)

  // --- WebSocket servers (noServer mode) ---

  const controlWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const dataWss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

  function broadcastControl(msg) {
    const payload = JSON.stringify(msg);
    for (const client of controlWss.clients) {
      if (client.readyState === 1) {
        client.send(payload);
      }
    }
  }

  // --- Health snapshot ---
  // Periodic memory/leak telemetry. Sampled rather than per-event because
  // process.memoryUsage() walks the V8 heap and shouldn't run on hot paths.

  const HEALTH_SNAPSHOT_INTERVAL_MS = 10000;

  function buildHealthSnapshot() {
    const mem = process.memoryUsage();
    const sessionStats = [];
    let alivePtyCount = 0;
    let sleepingCount = 0;
    let totalDataListeners = 0;
    let totalOutputBufferBytes = 0;
    let listenerMismatch = false;
    let orphanPty = false;
    let destroyedReachable = false;
    for (const [, sess] of sessions) {
      const stats = sess.getHealthStats();
      sessionStats.push(stats);
      if (stats.hasPty) alivePtyCount++;
      if (stats.sleeping) sleepingCount++;
      totalDataListeners += stats.dataListenerCount;
      totalOutputBufferBytes += stats.outputBufferBytes;
      // Anomalies: data-WS listener count should equal registered client count
      // for that session; PTY should only exist while session is in an active
      // state; destroy() should remove the session from the map.
      const clientCount = sessionDataClients.get(stats.id)?.size || 0;
      if (stats.dataListenerCount !== clientCount) listenerMismatch = true;
      if (stats.hasPty && (stats.state === STATES.DONE || stats.state === STATES.FAILED || stats.state === STATES.DORMANT)) {
        orphanPty = true;
      }
      if (stats.destroyed) destroyedReachable = true;
    }
    let dataClientTotal = 0;
    for (const set of sessionDataClients.values()) {
      dataClientTotal += set.size;
    }
    let activeResources = 0;
    try {
      activeResources = process.getActiveResourcesInfo().length;
    } catch {
      // Older Node — leave 0
    }
    return {
      timestamp: Date.now(),
      uptimeSeconds: Math.round(process.uptime()),
      process: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers,
        activeResources,
      },
      sessions: {
        total: sessions.size,
        alivePty: alivePtyCount,
        sleeping: sleepingCount,
        totalDataListeners,
        totalOutputBufferBytes,
        list: sessionStats,
      },
      websockets: {
        control: controlWss.clients.size,
        data: dataWss.clients.size,
        dataPerSessionTotal: dataClientTotal,
      },
      anomalies: { listenerMismatch, orphanPty, destroyedReachable },
    };
  }

  const healthInterval = setInterval(() => {
    broadcastControl({ type: 'health-snapshot', stats: buildHealthSnapshot() });
  }, HEALTH_SNAPSHOT_INTERVAL_MS);
  healthInterval.unref();

  // --- Notification manager ---

  const notificationManager = new NotificationManager({
    escalationIntervalMs: (config.waitingEscalationSeconds || 300) * 1000,
    debounceMs: config.notifyDebounceMs || 3000,
  });
  notificationManager.registerChannel('toast', createToastChannel());

  // --- Client focus tracking (suppress notifications when dashboard is visible) ---

  const focusedClients = new Set();

  function updateNotifySuppression() {
    notificationManager.setFocusSuppressed(focusedClients.size > 0);
  }

  function handleClientFocus(ws, focused) {
    if (focused) {
      focusedClients.add(ws);
    } else {
      focusedClients.delete(ws);
    }
    updateNotifySuppression();
  }

  // Clean up focus tracking when a control WS client disconnects
  controlWss.on('connection', (ws) => {
    ws.on('error', (err) => {
      console.warn(`[control-ws] Error: ${err.message}`);
    });
    ws.on('close', () => {
      focusedClients.delete(ws);
      updateNotifySuppression();
    });
  });

  // --- Session management ---
  // Sessions are keyed by stable `id` (UUID), not mutable `name`.

  const sessions = new Map();
  const sessionDataClients = new Map();

  function closeSessionDataClients(sessionId) {
    const clients = sessionDataClients.get(sessionId);
    if (clients) {
      for (const ws of clients) {
        ws.close(1001, 'Session removed');
      }
      sessionDataClients.delete(sessionId);
    }
  }

  /** Find a session by its id. */
  function getSession(id) {
    return sessions.get(id) || null;
  }

  function wireSessionEvents(sess) {
    // All closures read sess.id (stable) and sess.name (current) dynamically.
    sess.on('error', (err) => {
      console.error(`[${sess.name}] error: ${err.message}`);
    });

    sess.on('exit', ({ exitCode, signal, reason }) => {
      const reasonStr = reason ? `, reason=${reason}` : '';
      console.log(`[${sess.name}] exited (code=${exitCode}, signal=${signal}${reasonStr})`);
    });

    sess.on('state-change', ({ from, to, event }) => {
      broadcastControl({
        type: 'state-change',
        id: sess.id,
        session: sess.name,
        from, to, event,
        timestamp: Date.now()
      });

      // Notification triggers: session state -> notification lifecycle
      if (to === STATES.WAITING) {
        notificationManager.trigger(sess.id, 'waiting', `${sess.name} needs your input`);
      } else if (to === STATES.COMPLETE) {
        notificationManager.trigger(sess.id, 'complete', `${sess.name} finished working`);
      } else if (to === STATES.FAILED) {
        notificationManager.trigger(sess.id, 'failed', `${sess.name} failed`);
      }

      // Acknowledge when leaving a notification-triggering state
      if (from === STATES.WAITING || from === STATES.COMPLETE || from === STATES.FAILED) {
        notificationManager.acknowledge(sess.id);
      }
    });

    sess.on('sleep', () => {
      broadcastControl({
        type: 'session-sleep',
        id: sess.id,
        session: sess.name,
        timestamp: Date.now()
      });
    });

    sess.on('wake', () => {
      broadcastControl({
        type: 'session-wake',
        id: sess.id,
        session: sess.name,
        timestamp: Date.now()
      });
    });
  }

  // Sessions are constructed dormant — no PTY spawns on boot. The user starts
  // a session on demand by expanding its chip from the minimized bar, which
  // sends a `start-session` control message.
  for (const project of config.projects) {
    const sess = makeSession(project, config);
    sessions.set(project.id, sess);
    wireSessionEvents(sess);
  }

  function diffProjects(currentSessions, newProjects) {
    ensureProjectIds(newProjects);
    const newMap = new Map(newProjects.map(p => [p.id, p]));
    const added = [], removed = [], modified = [], renamed = [], unchanged = [];

    for (const [id, sess] of currentSessions) {
      if (newMap.has(id)) {
        const newP = newMap.get(id);
        const pathChanged = newP.path !== sess.path;
        const permsChanged = !!newP.dangerouslySkipPermissions !== sess.dangerouslySkipPermissions;
        if (pathChanged || permsChanged) {
          modified.push(newP);
        } else if (newP.name !== sess.name) {
          renamed.push(newP);
        } else {
          unchanged.push(id);
        }
      } else {
        removed.push(id);
      }
    }
    for (const [id, proj] of newMap) {
      if (!currentSessions.has(id)) {
        added.push(proj);
      }
    }
    return { added, removed, modified, renamed, unchanged };
  }

  function _removeOldSessions(removed) {
    for (const id of removed) {
      const sess = sessions.get(id);
      closeSessionDataClients(id);
      // INVARIANT: acknowledge BEFORE destroy — destroy() calls removeAllListeners()
      notificationManager.acknowledge(id);
      sess.destroy();
      sessions.delete(id);
      broadcastControl({ type: 'session-removed', id, session: sess.name });
      console.log(`[config] Removed session: ${sess.name}`);
    }
  }

  function _addNewSessions(added, newConfig) {
    for (const project of added) {
      const sess = makeSession(project, { ...config, ...newConfig });
      sessions.set(project.id, sess);
      wireSessionEvents(sess);
      // Broadcast BEFORE start(): sess.start() emits state-change synchronously,
      // and handleStateChange creates a card if one doesn't exist yet — without
      // skipPerms (state-change messages don't carry it), dropping the YOLO badge.
      broadcastControl({ type: 'session-added', id: project.id, session: project.name, state: sess.state, skipPerms: !!sess.dangerouslySkipPermissions });
      sess.start();
      console.log(`[config] Added session: ${project.name}`);
    }
  }

  function _modifyChangedSessions(modified, newConfig) {
    for (const project of modified) {
      const oldSess = sessions.get(project.id);
      closeSessionDataClients(project.id);
      // INVARIANT: acknowledge BEFORE destroy — destroy() calls removeAllListeners()
      notificationManager.acknowledge(project.id);
      oldSess.destroy();
      const newSess = makeSession(project, { ...config, ...newConfig });
      sessions.set(project.id, newSess);
      wireSessionEvents(newSess);
      // Broadcast BEFORE start() — see _addNewSessions for rationale.
      broadcastControl({ type: 'session-modified', id: project.id, session: project.name, state: newSess.state, skipPerms: !!newSess.dangerouslySkipPermissions });
      newSess.start();
      console.log(`[config] Modified session: ${project.name}`);
    }
  }

  function _renameChangedSessions(renamed) {
    for (const project of renamed) {
      const sess = sessions.get(project.id);
      const oldName = sess.name;
      sess.name = project.name;
      broadcastControl({ type: 'session-renamed', id: project.id, oldName, newName: project.name });
      console.log(`[config] Renamed session: ${oldName} → ${project.name}`);
    }
  }

  function applyConfigReload(newConfig) {
    ensureProjectIds(newConfig.projects);
    const diff = diffProjects(sessions, newConfig.projects);
    _removeOldSessions(diff.removed);
    _addNewSessions(diff.added, newConfig);
    _modifyChangedSessions(diff.modified, newConfig);
    _renameChangedSessions(diff.renamed);
    config.projects = newConfig.projects;
    applySettingsReload(newConfig);
  }

  function applySettingsReload(newConfig) {
    configStore.applySettings(newConfig);
    for (const [, sess] of sessions) {
      sess.updateSettings(config);
    }
    notificationManager.updateSettings({
      escalationIntervalMs: (config.waitingEscalationSeconds || 300) * 1000,
      debounceMs: config.notifyDebounceMs || 3000,
    });
  }

  function requestShutdown() {
    shutdown();
    httpServer.close(() => {
      console.log('Server closed — exiting.');
      process.exit(0);
    });
    // Fallback: if close callback doesn't fire within 2s, force exit
    setTimeout(() => process.exit(0), 2000);
  }

  // requestRestart is provided by the caller (Vite plugin or server.js)
  // since restart behavior differs between dev and production modes.
  const _onRestart = options.onRestart || null;

  function requestRestart() {
    shutdown();
    if (_onRestart) {
      _onRestart();
    } else {
      // Fallback: restart by spawning a new process.
      // Close the HTTP server first so the port is released cleanly,
      // then spawn the replacement and exit.
      let spawned = false;
      const spawnAndExit = () => {
        if (spawned) return;
        spawned = true;
        const { spawn } = require('node:child_process');
        spawn(process.argv[0], process.argv.slice(1), {
          cwd: process.cwd(),
          stdio: 'ignore',
          detached: true,
        }).unref();
        process.exit(0);
      };
      httpServer.close(spawnAndExit);
      // Fallback: if close callback doesn't fire within 2s, force it
      setTimeout(spawnAndExit, 2000);
    }
  }

  registerControlHandlers(controlWss, {
    sessions,
    config,
    configStore,
    broadcastControl,
    getSession,
    generateProjectId,
    makeSession,
    wireSessionEvents,
    closeSessionDataClients,
    applyConfigReload,
    applySettingsReload,
    requestShutdown,
    requestRestart,
    handleClientFocus,
    buildHealthSnapshot,
  });

  // --- Data WebSocket ---

  dataWss.on('connection', (ws, req) => {
    const parts = req.url.split('/');
    let sessionId;
    try {
      sessionId = decodeURIComponent(parts[parts.length - 1]);
    } catch {
      ws.close(1008, 'Invalid session id');
      return;
    }
    const sess = sessions.get(sessionId);

    if (!sess) {
      ws.close(1008, 'Session not found');
      return;
    }

    if (!sessionDataClients.has(sessionId)) {
      sessionDataClients.set(sessionId, new Set());
    }
    sessionDataClients.get(sessionId).add(ws);

    const replay = sess.getReplayBuffer();
    if (replay) {
      ws.send(replay);
    }

    // Batch PTY data events and send as fewer, larger WS frames.
    // Without this, each tiny PTY chunk becomes its own WS frame,
    // flooding the browser with hundreds of messages per second.
    const MAX_SEND_BUFFER = 65536;
    let sendBuffer = '';
    let sendScheduled = false;

    const dataListener = (data) => {
      if (ws.readyState !== 1) return;
      // Fast-path: buffer empty and chunk alone fits — send without rope concat.
      if (sendBuffer.length === 0 && data.length < MAX_SEND_BUFFER) {
        if (!sendScheduled) {
          sendScheduled = true;
          setImmediate(() => {
            sendScheduled = false;
            if (sendBuffer.length > 0 && ws.readyState === 1) {
              const buf = sendBuffer;
              sendBuffer = '';
              ws.send(buf);
            }
          });
        }
        sendBuffer = data;
        return;
      }
      sendBuffer += data;
      if (sendBuffer.length >= MAX_SEND_BUFFER) {
        const buf = sendBuffer;
        sendBuffer = '';
        sendScheduled = false;
        ws.send(buf);
        return;
      }
      if (!sendScheduled) {
        sendScheduled = true;
        setImmediate(() => {
          sendScheduled = false;
          if (sendBuffer.length > 0 && ws.readyState === 1) {
            const buf = sendBuffer;
            sendBuffer = '';
            ws.send(buf);
          }
        });
      }
    };
    sess.on('data', dataListener);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.type === 'input' && typeof msg.data === 'string') {
        if (msg.data.length > 16384) {
          console.warn(`[data-ws] Rejected oversized input (${msg.data.length} chars) for ${sess.name}`);
          broadcastControl({
            type: 'session-error',
            id: sess.id,
            session: sess.name,
            message: 'Paste too large — try pasting smaller chunks',
            timestamp: Date.now(),
          });
          return;
        }
        sess.write(msg.data);
        sess.recordUserInput(msg.data);
        if (sess.state === STATES.WAITING) {
          sess.transition('user_input');
        }
      } else if (msg.type === 'resize') {
        const cols = Number(msg.cols);
        const rows = Number(msg.rows);
        if (Number.isInteger(cols) && Number.isInteger(rows)
            && cols > 0 && cols <= 500 && rows > 0 && rows <= 200) {
          sess.resize(cols, rows);
        }
      }
    });

    ws.on('error', (err) => {
      const isPayload = err.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH';
      const reason = isPayload
        ? 'Message too large — try pasting smaller chunks'
        : err.message;
      console.warn(`[data-ws] Error for ${sess.name}: ${err.message}`);
      broadcastControl({
        type: 'session-error',
        id: sess.id,
        session: sess.name,
        message: reason,
        timestamp: Date.now(),
      });
      // ws 'close' fires automatically after error — no need to call ws.close()
    });

    ws.on('close', () => {
      sess.removeListener('data', dataListener);
      const clients = sessionDataClients.get(sessionId);
      if (clients) {
        clients.delete(ws);
        if (clients.size === 0) sessionDataClients.delete(sessionId);
      }
    });
  });

  // --- WebSocket upgrade routing ---
  // Node's 'upgrade' event fires for ALL listeners. We only handle paths
  // we own (/control, /terminals/*). Unrecognized paths are left alone so
  // other listeners (e.g. Vite HMR) can handle them.

  httpServer.on('upgrade', (req, socket, head) => {
    const { url } = req;

    if (url === '/control') {
      if (!isAllowedOrigin(req)) { socket.destroy(); return; }
      controlWss.handleUpgrade(req, socket, head, (ws) => {
        controlWss.emit('connection', ws, req);
      });
    } else if (url.startsWith('/terminals/')) {
      if (!isAllowedOrigin(req)) { socket.destroy(); return; }
      dataWss.handleUpgrade(req, socket, head, (ws) => {
        dataWss.emit('connection', ws, req);
      });
    }
    // No else — let other upgrade listeners (Vite HMR) handle their paths
  });

  // --- Config hot-reload ---

  configStore.watchForChanges((newConfig) => {
    applyConfigReload(newConfig);
  });

  // --- Shutdown ---

  let shuttingDown = false;

  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(healthInterval);
    // INVARIANT: destroy NotificationManager BEFORE sessions — clears all timers globally
    notificationManager.destroy();
    for (const [, sess] of sessions) {
      sess.destroy();
    }
    controlWss.close();
    dataWss.close();
  }

  return { shutdown, port, app };
}

/**
 * Mount dev-mode fallback routes for serving xterm.js and shared modules
 * directly from node_modules. Only used in production when dist/ doesn't exist.
 */
function mountDevRoutes(app) {
  app.get('/xterm/xterm.css', (_req, res) => {
    res.sendFile(path.join(__dirname, 'node_modules/@xterm/xterm/css/xterm.css'));
  });
  app.get('/xterm/xterm.mjs', (_req, res) => {
    res.type('application/javascript');
    res.sendFile(path.join(__dirname, 'node_modules/@xterm/xterm/lib/xterm.mjs'));
  });
  app.get('/xterm/addon-fit.mjs', (_req, res) => {
    res.type('application/javascript');
    res.sendFile(path.join(__dirname, 'node_modules/@xterm/addon-fit/lib/addon-fit.mjs'));
  });
  app.get('/xterm/addon-webgl.mjs', (_req, res) => {
    res.type('application/javascript');
    res.sendFile(path.join(__dirname, 'node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs'));
  });

  app.get('/shared/states.mjs', (_req, res) => {
    const states = require('./shared/states');
    const lines = [];
    for (const [key, val] of Object.entries(states)) {
      lines.push(`export const ${key} = ${JSON.stringify(val)};`);
    }
    res.type('application/javascript');
    res.send(lines.join('\n'));
  });
}

module.exports = { createBackend };
