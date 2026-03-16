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
const { createConfigStore } = require('./config-store');
const { registerControlHandlers } = require('./control-handlers');

function makeSession(project, cfg) {
  return new Session({
    name: project.name,
    path: project.path,
    startingWatchdogSeconds: cfg.startingWatchdogSeconds,
    attentionTimeoutSeconds: cfg.attentionTimeoutSeconds,
    waitingEscalationSeconds: cfg.waitingEscalationSeconds,
    autoRecoverSeconds: cfg.autoRecoverSeconds,
  });
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
  const dataWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  function broadcastControl(msg) {
    const payload = JSON.stringify(msg);
    for (const client of controlWss.clients) {
      if (client.readyState === 1) {
        client.send(payload);
      }
    }
  }

  // --- Session management ---

  const sessions = new Map();
  const sessionDataClients = new Map();

  function closeSessionDataClients(sessionName) {
    const clients = sessionDataClients.get(sessionName);
    if (clients) {
      for (const ws of clients) {
        ws.close(1001, 'Session removed');
      }
      sessionDataClients.delete(sessionName);
    }
  }

  function wireSessionEvents(sess, name) {
    sess.on('error', (err) => {
      console.error(`[${name}] error: ${err.message}`);
    });

    sess.on('exit', ({ exitCode, signal }) => {
      console.log(`[${name}] exited (code=${exitCode}, signal=${signal})`);
    });

    sess.on('state-change', ({ from, to, event }) => {
      broadcastControl({
        type: 'state-change',
        session: name,
        from, to, event,
        timestamp: Date.now()
      });
    });
  }

  for (const project of config.projects) {
    const sess = makeSession(project, config);
    sessions.set(project.name, sess);
    wireSessionEvents(sess, project.name);
    sess.start();
  }

  function diffProjects(currentSessions, newProjects) {
    const newMap = new Map(newProjects.map(p => [p.name, p]));
    const added = [], removed = [], modified = [], unchanged = [];

    for (const [name, sess] of currentSessions) {
      if (newMap.has(name)) {
        const newP = newMap.get(name);
        if (newP.path === sess.path) {
          unchanged.push(name);
        } else {
          modified.push(newP);
        }
      } else {
        removed.push(name);
      }
    }
    for (const [name, proj] of newMap) {
      if (!currentSessions.has(name)) {
        added.push(proj);
      }
    }
    return { added, removed, modified, unchanged };
  }

  function _removeOldSessions(removed) {
    for (const name of removed) {
      const sess = sessions.get(name);
      closeSessionDataClients(name);
      sess.destroy();
      sessions.delete(name);
      broadcastControl({ type: 'session-removed', session: name });
      console.log(`[config] Removed session: ${name}`);
    }
  }

  function _addNewSessions(added, newConfig) {
    for (const project of added) {
      const sess = makeSession(project, { ...config, ...newConfig });
      sessions.set(project.name, sess);
      wireSessionEvents(sess, project.name);
      sess.start();
      broadcastControl({ type: 'session-added', session: project.name, state: sess.state });
      console.log(`[config] Added session: ${project.name}`);
    }
  }

  function _modifyChangedSessions(modified, newConfig) {
    for (const project of modified) {
      const oldSess = sessions.get(project.name);
      closeSessionDataClients(project.name);
      oldSess.destroy();
      const newSess = makeSession(project, { ...config, ...newConfig });
      sessions.set(project.name, newSess);
      wireSessionEvents(newSess, project.name);
      newSess.start();
      broadcastControl({ type: 'session-modified', session: project.name, state: newSess.state });
      console.log(`[config] Modified session: ${project.name}`);
    }
  }

  function applyConfigReload(newConfig) {
    const diff = diffProjects(sessions, newConfig.projects);
    _removeOldSessions(diff.removed);
    _addNewSessions(diff.added, newConfig);
    _modifyChangedSessions(diff.modified, newConfig);
    config.projects = newConfig.projects;
    applySettingsReload(newConfig);
  }

  function applySettingsReload(newConfig) {
    configStore.applySettings(newConfig);
    for (const [, sess] of sessions) {
      sess.updateSettings(config);
    }
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
      // Fallback: restart by spawning a new process
      const { spawn } = require('node:child_process');
      spawn(process.argv[0], process.argv.slice(1), {
        cwd: process.cwd(),
        stdio: 'inherit',
        detached: true,
      }).unref();
      process.exit(0);
    }
  }

  registerControlHandlers(controlWss, {
    sessions,
    config,
    configStore,
    broadcastControl,
    makeSession,
    wireSessionEvents,
    closeSessionDataClients,
    applyConfigReload,
    applySettingsReload,
    requestShutdown,
    requestRestart,
  });

  // --- Data WebSocket ---

  dataWss.on('connection', (ws, req) => {
    const parts = req.url.split('/');
    let sessionName;
    try {
      sessionName = decodeURIComponent(parts[parts.length - 1]);
    } catch {
      ws.close(1008, 'Invalid session name');
      return;
    }
    const sess = sessions.get(sessionName);

    if (!sess) {
      ws.close(1008, 'Session not found');
      return;
    }

    if (!sessionDataClients.has(sessionName)) {
      sessionDataClients.set(sessionName, new Set());
    }
    sessionDataClients.get(sessionName).add(ws);

    const replay = sess.getReplayBuffer();
    if (replay) {
      ws.send(replay);
    }

    const dataListener = (data) => {
      if (ws.readyState === 1) {
        ws.send(data);
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
          console.warn(`[data-ws] Rejected oversized input (${msg.data.length} chars) for ${sessionName}`);
          return;
        }
        sess.write(msg.data);
      } else if (msg.type === 'resize') {
        const cols = Number(msg.cols);
        const rows = Number(msg.rows);
        if (Number.isInteger(cols) && Number.isInteger(rows)
            && cols > 0 && cols <= 500 && rows > 0 && rows <= 200) {
          sess.resize(cols, rows);
        }
      }
    });

    ws.on('close', () => {
      sess.removeListener('data', dataListener);
      const clients = sessionDataClients.get(sessionName);
      if (clients) {
        clients.delete(ws);
        if (clients.size === 0) sessionDataClients.delete(sessionName);
      }
    });
  });

  // --- WebSocket upgrade routing ---
  // Node's 'upgrade' event fires for ALL listeners. We only handle paths
  // we own (/control, /terminals/*). Unrecognized paths are left alone so
  // other listeners (e.g. Vite HMR) can handle them.

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
