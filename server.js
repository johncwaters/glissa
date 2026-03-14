/*
 * Glissa WebSocket Protocol
 *
 * Control WebSocket: ws://localhost:PORT/control
 *   Server → Client:
 *     { type: 'snapshot', sessions: [{ name, state, auditLog }] }
 *     { type: 'state-change', session, from, to, event, timestamp }
 *     { type: 'settings', requestId, settings }                      (unicast)
 *     { type: 'settings-error', requestId, message }                 (unicast)
 *     { type: 'settings-updated', settings }                         (broadcast)
 *     { type: 'repo-roots-scanned', requestId, directories }        (unicast)
 *     { type: 'sessions-reordered', order: [sessionName, ...] }            (broadcast)
 *   Client → Server:
 *     { type: 'kill', session }
 *     { type: 'restart', session }
 *     { type: 'dismiss', session }
 *     { type: 'get-settings', requestId }
 *     { type: 'update-settings', requestId, settings }
 *     { type: 'scan-repo-roots', requestId }
 *     { type: 'reorder-sessions', order: [sessionName, ...] }
 *
 * Data WebSocket: ws://localhost:PORT/terminals/:sessionName
 *   Server → Client: raw PTY output (string)
 *   Client → Server:
 *     { type: 'input', data }  (keystrokes)
 *     { type: 'resize', cols, rows }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Session } = require('./sessions');
const { createConfigStore } = require('./config-store');
const { registerControlHandlers } = require('./control-handlers');

const configStore = createConfigStore();
const { config } = configStore;
const port = process.env.GLISSA_PORT ? parseInt(process.env.GLISSA_PORT, 10) : (config.port || 3000);

// --- Express setup ---

const app = express();

app.use(express.static(path.join(__dirname, 'public')));

// Serve xterm.js assets from node_modules
app.get('/xterm/xterm.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/@xterm/xterm/css/xterm.css'));
});
app.get('/xterm/xterm.mjs', (req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'node_modules/@xterm/xterm/lib/xterm.mjs'));
});
app.get('/xterm/addon-fit.mjs', (req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'node_modules/@xterm/addon-fit/lib/addon-fit.mjs'));
});
app.get('/xterm/addon-webgl.mjs', (req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs'));
});

// Serve shared/states.js as an ES module for the browser (single source of truth)
app.get('/shared/states.mjs', (req, res) => {
  const states = require('./shared/states');
  const lines = [];
  for (const [key, val] of Object.entries(states)) {
    lines.push(`export const ${key} = ${JSON.stringify(val)};`);
  }
  res.type('application/javascript');
  res.send(lines.join('\n'));
});

const server = http.createServer(app);

// --- WebSocket servers (noServer mode) ---

const controlWss = new WebSocketServer({ noServer: true });
const dataWss = new WebSocketServer({ noServer: true });

// --- Control WebSocket ---

function broadcastControl(msg) {
  const payload = JSON.stringify(msg);
  for (const client of controlWss.clients) {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(payload);
    }
  }
}

// --- Session management ---

const sessions = new Map();
const sessionDataClients = new Map(); // Map<string, Set<WebSocket>>

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


function diffProjects(currentSessions, newProjects) {
  const newMap = new Map(newProjects.map(p => [p.name, p]));
  const added = [], removed = [], modified = [], unchanged = [];

  for (const [name, sess] of currentSessions) {
    if (!newMap.has(name)) {
      removed.push(name);
    } else {
      const newP = newMap.get(name);
      if (newP.path !== sess.path) {
        modified.push(newP);
      } else {
        unchanged.push(name);
      }
    }
  }
  for (const [name, proj] of newMap) {
    if (!currentSessions.has(name)) {
      added.push(proj);
    }
  }
  return { added, removed, modified, unchanged };
}

function applyConfigReload(newConfig) {
  const diff = diffProjects(sessions, newConfig.projects);

  // REMOVED
  for (const name of diff.removed) {
    const sess = sessions.get(name);
    closeSessionDataClients(name);
    sess.destroy();
    sessions.delete(name);
    broadcastControl({ type: 'session-removed', session: name });
    console.log(`[config] Removed session: ${name}`);
  }

  // ADDED
  for (const project of diff.added) {
    const sess = makeSession(project, { ...config, ...newConfig });
    sessions.set(project.name, sess);
    wireSessionEvents(sess, project.name);
    sess.start();
    broadcastControl({ type: 'session-added', session: project.name, state: sess.state });
    console.log(`[config] Added session: ${project.name}`);
  }

  // MODIFIED (path changed)
  for (const project of diff.modified) {
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

  // Update config reference
  config.projects = newConfig.projects;
  applySettingsReload(newConfig);
}

function applySettingsReload(newConfig) {
  configStore.applySettings(newConfig);
  // Propagate updated timeout values to all running sessions
  for (const [, sess] of sessions) {
    sess.updateSettings(config);
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
});

// --- Data WebSocket ---

dataWss.on('connection', (ws, req) => {
  // Parse session name from URL: /terminals/:sessionName
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

  // Track data WS clients per session for hot-reload cleanup
  if (!sessionDataClients.has(sessionName)) {
    sessionDataClients.set(sessionName, new Set());
  }
  sessionDataClients.get(sessionName).add(ws);

  // Replay buffered output so late-joining clients see existing terminal content
  const replay = sess.getReplayBuffer();
  if (replay) {
    ws.send(replay);
  }

  // Pipe PTY data to this WebSocket client
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
      sess.write(msg.data);
    } else if (msg.type === 'resize' && msg.cols && msg.rows) {
      sess.resize(msg.cols, msg.rows);
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

server.on('upgrade', (req, socket, head) => {
  const { url } = req;

  if (url === '/control') {
    controlWss.handleUpgrade(req, socket, head, (ws) => {
      controlWss.emit('connection', ws, req);
    });
  } else if (url.startsWith('/terminals/')) {
    dataWss.handleUpgrade(req, socket, head, (ws) => {
      dataWss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// --- Start server ---

server.listen(port, () => {
  console.log(`Glissa server listening on http://localhost:${port}`);
});

// --- Config hot-reload ---

configStore.watchForChanges((newConfig) => {
  applyConfigReload(newConfig);
});

// --- Graceful shutdown ---

let shuttingDown = false;

process.on('SIGINT', () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nSIGINT received — shutting down...');
  for (const [, sess] of sessions) {
    sess.destroy();
  }
  controlWss.close();
  dataWss.close();
  server.close(() => {
    process.exit(0);
  });
});
