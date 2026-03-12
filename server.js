/*
 * Glissa WebSocket Protocol
 *
 * Control WebSocket: ws://localhost:PORT/control
 *   Server → Client:
 *     { type: 'snapshot', sessions: [{ name, state, cols, rows }] }
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
const os = require('os');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Session } = require('./sessions');

const DEFAULT_CONFIG = {
  port: 3000,
  attentionTimeoutSeconds: 60,
  waitingEscalationSeconds: 300,
  startingWatchdogSeconds: 30,
  autoRecoverSeconds: 3,
  repoRoots: [],
  projects: []
};

function resolveConfigPath() {
  // 1. Explicit --config flag (via env bridge from bin/glissa.js)
  if (process.env.GLISSA_CONFIG) {
    const p = path.resolve(process.env.GLISSA_CONFIG);
    if (fs.existsSync(p)) return p;
    console.error(`Config file not found: ${p}`);
    process.exit(1);
  }

  // 2. User home directory (~/.glissa/config.json)
  const homeConfig = path.join(os.homedir(), '.glissa', 'config.json');
  if (fs.existsSync(homeConfig)) return homeConfig;

  // 3. Local fallback (__dirname/config.json) — for dev use with `node server.js`
  const localConfig = path.join(__dirname, 'config.json');
  if (fs.existsSync(localConfig)) return localConfig;

  // 4. None found — seed default at ~/.glissa/config.json
  const dir = path.join(os.homedir(), '.glissa');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(homeConfig, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
  console.log(`Created default config at ${homeConfig}`);
  return homeConfig;
}

const configPath = resolveConfigPath();
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
config.repoRoots = config.repoRoots || [];
const port = process.env.GLISSA_PORT ? parseInt(process.env.GLISSA_PORT, 10) : (config.port || 3000);

let _lastSelfWriteTs = 0;
function writeConfigSync(filePath, cfg) {
  _lastSelfWriteTs = Date.now();
  fs.writeFileSync(filePath, JSON.stringify(cfg, null, 2), 'utf8');
}

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

const server = http.createServer(app);

// --- WebSocket servers (noServer mode) ---

const controlWss = new WebSocketServer({ noServer: true });
const dataWss = new WebSocketServer({ noServer: true });

// --- Control WebSocket ---

function buildSnapshot() {
  const list = [];
  for (const [name, sess] of sessions) {
    list.push({
      name,
      state: sess.state,
      cols: 80,
      rows: 24,
      auditLog: sess.auditLog.slice(-100) // last 100 entries
    });
  }
  return { type: 'snapshot', sessions: list };
}

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
  const sess = new Session({
    name: project.name,
    path: project.path,
    startingWatchdogSeconds: config.startingWatchdogSeconds,
    attentionTimeoutSeconds: config.attentionTimeoutSeconds,
    waitingEscalationSeconds: config.waitingEscalationSeconds,
    autoRecoverSeconds: config.autoRecoverSeconds,
  });
  sessions.set(project.name, sess);
  wireSessionEvents(sess, project.name);
  sess.start();
}

function diffProjects(currentSessions, newProjects) {
  const newMap = new Map(newProjects.map(p => [p.name, p]));
  const added = [], removed = [], modified = [], tweaked = [], unchanged = [];

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
  return { added, removed, modified, tweaked, unchanged };
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
    const sess = new Session({
      name: project.name,
      path: project.path,
      startingWatchdogSeconds: newConfig.startingWatchdogSeconds ?? config.startingWatchdogSeconds,
      attentionTimeoutSeconds: newConfig.attentionTimeoutSeconds ?? config.attentionTimeoutSeconds,
      waitingEscalationSeconds: newConfig.waitingEscalationSeconds ?? config.waitingEscalationSeconds,
      autoRecoverSeconds: newConfig.autoRecoverSeconds ?? config.autoRecoverSeconds,
    });
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
    const newSess = new Session({
      name: project.name,
      path: project.path,
      startingWatchdogSeconds: newConfig.startingWatchdogSeconds ?? config.startingWatchdogSeconds,
      attentionTimeoutSeconds: newConfig.attentionTimeoutSeconds ?? config.attentionTimeoutSeconds,
      waitingEscalationSeconds: newConfig.waitingEscalationSeconds ?? config.waitingEscalationSeconds,
      autoRecoverSeconds: newConfig.autoRecoverSeconds ?? config.autoRecoverSeconds,
    });
    sessions.set(project.name, newSess);
    wireSessionEvents(newSess, project.name);
    newSess.start();
    broadcastControl({ type: 'session-modified', session: project.name, state: newSess.state });
    console.log(`[config] Modified session: ${project.name}`);
  }

  // Update config reference
  config.projects = newConfig.projects;
  if (newConfig.attentionTimeoutSeconds != null) config.attentionTimeoutSeconds = newConfig.attentionTimeoutSeconds;
  if (newConfig.startingWatchdogSeconds != null) config.startingWatchdogSeconds = newConfig.startingWatchdogSeconds;
  if (newConfig.waitingEscalationSeconds != null) config.waitingEscalationSeconds = newConfig.waitingEscalationSeconds;
  if (newConfig.autoRecoverSeconds != null) config.autoRecoverSeconds = newConfig.autoRecoverSeconds;
}

function applySettingsReload(newConfig) {
  if (newConfig.attentionTimeoutSeconds != null) config.attentionTimeoutSeconds = newConfig.attentionTimeoutSeconds;
  if (newConfig.startingWatchdogSeconds != null) config.startingWatchdogSeconds = newConfig.startingWatchdogSeconds;
  if (newConfig.waitingEscalationSeconds != null) config.waitingEscalationSeconds = newConfig.waitingEscalationSeconds;
  if (newConfig.autoRecoverSeconds != null) config.autoRecoverSeconds = newConfig.autoRecoverSeconds;
  config.repoRoots = newConfig.repoRoots || [];
  if (newConfig.port != null && newConfig.port !== config.port) {
    console.log(`[settings] Port changed to ${newConfig.port} — restart required to take effect`);
  }
}

function scanRepoRoots(roots) {
  const results = [];
  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) {
        results.push({ root, projects: [] });
        continue;
      }
      const entries = fs.readdirSync(root, { withFileTypes: true });
      const projects = entries
        .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
        .map(d => ({ name: d.name, path: path.join(root, d.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      results.push({ root, projects });
    } catch (err) {
      console.warn(`[settings] Failed to scan root: ${root}: ${err.code || err.message}`);
      results.push({ root, projects: [] });
    }
  }
  return results;
}

function handleAddSession(msg, ws) {
  const name = (msg.name || '').trim();
  const projectPath = (msg.path || '').trim();

  if (!name || !projectPath) {
    ws.send(JSON.stringify({ type: 'error', message: 'Name and path are required' }));
    return;
  }

  if (sessions.has(name)) {
    ws.send(JSON.stringify({ type: 'error', message: `Session "${name}" already exists` }));
    return;
  }

  if (!fs.existsSync(projectPath)) {
    ws.send(JSON.stringify({ type: 'error', message: `Path does not exist: ${projectPath}` }));
    return;
  }

  // Read current config, add project, write back, and apply immediately
  const freshConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  freshConfig.projects.push({ name, path: projectPath });
  writeConfigSync(configPath, freshConfig);
  applyConfigReload(freshConfig);
  console.log(`[control] Added session via UI: ${name}`);
}

function handleRemoveSession(msg, ws) {
  const name = (msg.session || '').trim();

  if (!name) {
    ws.send(JSON.stringify({ type: 'error', message: 'Session name is required' }));
    return;
  }

  if (!sessions.has(name)) {
    ws.send(JSON.stringify({ type: 'error', message: `Session "${name}" not found` }));
    return;
  }

  // Read current config, remove project, write back, and apply immediately
  const freshConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  freshConfig.projects = freshConfig.projects.filter(p => p.name !== name);
  writeConfigSync(configPath, freshConfig);
  applyConfigReload(freshConfig);
  console.log(`[control] Removed session via UI: ${name}`);
}

function handleReorderSessions(msg, ws) {
  const order = msg.order;
  if (!Array.isArray(order) || order.length === 0) {
    ws.send(JSON.stringify({ type: 'error', message: 'order must be a non-empty array' }));
    return;
  }

  // Race condition guard: if a session was removed mid-drag, reject and send fresh snapshot
  const allExist = order.every(name => sessions.has(name));
  if (!allExist) {
    ws.send(JSON.stringify({ type: 'error', message: 'Session list changed during reorder' }));
    broadcastControl(buildSnapshot());
    return;
  }

  // Reorder the sessions Map: clear and re-insert in new order
  // (const Map can't be reassigned, but can be cleared and rebuilt)
  const entries = new Map(sessions);
  sessions.clear();
  for (const name of order) {
    sessions.set(name, entries.get(name));
  }
  // Defensive: re-insert any sessions not in order array
  for (const [name, sess] of entries) {
    if (!sessions.has(name)) {
      sessions.set(name, sess);
    }
  }

  // Persist to config.json using existing read-modify-write pattern
  const freshConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const projectMap = new Map(freshConfig.projects.map(p => [p.name, p]));
  freshConfig.projects = order
    .filter(name => projectMap.has(name))
    .map(name => projectMap.get(name));
  // Defensive: append projects not in order
  for (const p of projectMap.values()) {
    if (!freshConfig.projects.find(x => x.name === p.name)) {
      freshConfig.projects.push(p);
    }
  }
  writeConfigSync(configPath, freshConfig);

  // Broadcast to ALL control clients
  broadcastControl({ type: 'sessions-reordered', order: order });
  console.log(`[control] Sessions reordered: ${order.join(', ')}`);
}

controlWss.on('connection', (ws) => {
  // Send initial snapshot
  ws.send(JSON.stringify(buildSnapshot()));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'add-session') {
      handleAddSession(msg, ws);
      return;
    } else if (msg.type === 'remove-session') {
      handleRemoveSession(msg, ws);
      return;
    } else if (msg.type === 'reorder-sessions') {
      handleReorderSessions(msg, ws);
      return;
    } else if (msg.type === 'get-settings') {
      ws.send(JSON.stringify({
        type: 'settings',
        requestId: msg.requestId || null,
        settings: {
          port: config.port,
          attentionTimeoutSeconds: config.attentionTimeoutSeconds,
          waitingEscalationSeconds: config.waitingEscalationSeconds,
          startingWatchdogSeconds: config.startingWatchdogSeconds,
          repoRoots: config.repoRoots,
        }
      }));
      return;
    } else if (msg.type === 'update-settings') {
      const s = msg.settings || {};
      // Validate repoRoots paths
      const invalidPaths = (s.repoRoots || []).filter(p => !fs.existsSync(p));
      if (invalidPaths.length > 0) {
        ws.send(JSON.stringify({
          type: 'settings-error',
          requestId: msg.requestId || null,
          message: 'Invalid paths: ' + invalidPaths.join(', ')
        }));
        return;
      }
      // Validate timeout values
      const timeoutKeys = ['attentionTimeoutSeconds', 'waitingEscalationSeconds', 'startingWatchdogSeconds'];
      for (const key of timeoutKeys) {
        if (s[key] != null && (typeof s[key] !== 'number' || s[key] <= 0)) {
          ws.send(JSON.stringify({
            type: 'settings-error',
            requestId: msg.requestId || null,
            message: key + ' must be a positive number'
          }));
          return;
        }
      }
      // Read-modify-write config.json
      const freshConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (s.attentionTimeoutSeconds != null) freshConfig.attentionTimeoutSeconds = s.attentionTimeoutSeconds;
      if (s.waitingEscalationSeconds != null) freshConfig.waitingEscalationSeconds = s.waitingEscalationSeconds;
      if (s.startingWatchdogSeconds != null) freshConfig.startingWatchdogSeconds = s.startingWatchdogSeconds;
      if (s.repoRoots != null) freshConfig.repoRoots = s.repoRoots;
      writeConfigSync(configPath, freshConfig);
      applySettingsReload(freshConfig);
      const updatedSettings = {
        port: config.port,
        attentionTimeoutSeconds: config.attentionTimeoutSeconds,
        waitingEscalationSeconds: config.waitingEscalationSeconds,
        startingWatchdogSeconds: config.startingWatchdogSeconds,
        repoRoots: config.repoRoots,
      };
      // Unicast ack to requesting client (resolves their pending promise)
      ws.send(JSON.stringify({
        type: 'settings-updated',
        requestId: msg.requestId || null,
        settings: updatedSettings,
      }));
      // Broadcast to all other clients
      broadcastControl({
        type: 'settings-updated',
        settings: updatedSettings,
      });
      console.log('[control] Settings updated via UI');
      return;
    } else if (msg.type === 'scan-repo-roots') {
      const directories = scanRepoRoots(config.repoRoots);
      ws.send(JSON.stringify({
        type: 'repo-roots-scanned',
        requestId: msg.requestId || null,
        directories
      }));
      return;
    }

    const sess = sessions.get(msg.session);
    if (!sess) return;

    if (msg.type === 'kill') {
      sess.killSession();
    } else if (msg.type === 'restart') {
      sess.restart();
    } else if (msg.type === 'dismiss') {
      sess.dismiss();
    }
  });
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

let reloadTimer = null;

try {
  fs.watch(configPath, () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      if (Date.now() - _lastSelfWriteTs < 500) return;
      fs.readFile(configPath, 'utf8', (err, data) => {
        if (err) {
          console.warn('[config] Failed to read config.json:', err.code);
          return;
        }
        let newConfig;
        try {
          newConfig = JSON.parse(data);
        } catch (parseErr) {
          console.warn('[config] Invalid JSON in config.json:', parseErr.message);
          return;
        }
        if (!Array.isArray(newConfig.projects)) {
          console.warn('[config] config.json missing "projects" array');
          return;
        }
        applyConfigReload(newConfig);
        applySettingsReload(newConfig);
        console.log('[config] Reloaded config.json');
      });
    }, 500);
  });
  console.log('[config] Watching config.json for changes');
} catch (watchErr) {
  console.warn('[config] Failed to watch config.json:', watchErr.message);
}

// --- Graceful shutdown ---

let shuttingDown = false;

process.on('SIGINT', () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nSIGINT received — shutting down...');
  for (const [, sess] of sessions) {
    sess.kill();
  }
  controlWss.close();
  dataWss.close();
  server.close(() => {
    process.exit(0);
  });
});
