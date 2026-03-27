'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TIMEOUT_KEYS } = require('./config-store');

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

/**
 * Register control WebSocket handlers using a handler-map dispatch pattern.
 * Dependencies are injected via the deps object (factory pattern).
 *
 * Sessions are keyed by stable `id` (UUID). The mutable `name` is display-only.
 */
function registerControlHandlers(controlWss, deps) {
  const {
    sessions,
    config,
    configStore,
    broadcastControl,
    getSession,
    generateProjectId,
    closeSessionDataClients,
    applyConfigReload,
    applySettingsReload,
    requestShutdown,
    requestRestart,
    handleClientFocus,
  } = deps;

  /** Find a session by id (primary) with name fallback for legacy clients. */
  function findSession(msg) {
    // Prefer msg.id (stable identifier)
    if (msg.id && sessions.has(msg.id)) return sessions.get(msg.id);
    // Fallback: match by name for backward compatibility
    if (msg.session) {
      for (const [, sess] of sessions) {
        if (sess.name === msg.session) return sess;
      }
    }
    return null;
  }

  function buildSnapshot() {
    const list = [];
    for (const [, sess] of sessions) {
      list.push(sess.toSnapshot());
    }
    return { type: 'snapshot', sessions: list };
  }

  const SESSION_NAME_RE = /^[a-zA-Z0-9_\-. ]{1,64}$/;

  function handleAddSession(msg, ws) {
    const name = (msg.name || '').trim();
    const projectPath = (msg.path || '').trim();

    if (!name || !projectPath) {
      ws.send(JSON.stringify({ type: 'error', message: 'Name and path are required' }));
      return;
    }

    if (!SESSION_NAME_RE.test(name)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session name may only contain letters, numbers, spaces, dashes, dots, and underscores (max 64 chars)' }));
      return;
    }

    // Check for duplicate name
    for (const [, sess] of sessions) {
      if (sess.name === name) {
        ws.send(JSON.stringify({ type: 'error', message: `Session "${name}" already exists` }));
        return;
      }
    }

    const resolvedPath = path.resolve(projectPath);
    if (!fs.existsSync(resolvedPath)) {
      ws.send(JSON.stringify({ type: 'error', message: `Path does not exist: ${projectPath}` }));
      return;
    }

    const skipPerms = !!msg.dangerouslySkipPermissions;
    const project = { id: generateProjectId(), name, path: resolvedPath };
    if (skipPerms) project.dangerouslySkipPermissions = true;

    const freshConfig = configStore.save(cfg => {
      cfg.projects.push(project);
    });
    if (freshConfig) applyConfigReload(freshConfig);
    console.log(`[control] Added session via UI: ${name}${skipPerms ? ' (skip permissions)' : ''}`);
  }

  function handleRemoveSession(msg, ws) {
    const sess = findSession(msg);
    if (!sess) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
      return;
    }

    const freshConfig = configStore.save(cfg => {
      cfg.projects = cfg.projects.filter(p => p.id !== sess.id);
    });
    if (freshConfig) applyConfigReload(freshConfig);
    console.log(`[control] Removed session via UI: ${sess.name}`);
  }

  function handleRenameSession(msg, ws) {
    const sess = findSession(msg);
    const newName = (msg.newName || '').trim();

    if (!sess || !newName) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session and new name are required' }));
      return;
    }

    if (!SESSION_NAME_RE.test(newName)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session name may only contain letters, numbers, spaces, dashes, dots, and underscores (max 64 chars)' }));
      return;
    }

    // Check for duplicate name (excluding self)
    for (const [, other] of sessions) {
      if (other !== sess && other.name === newName) {
        ws.send(JSON.stringify({ type: 'error', message: `Session "${newName}" already exists` }));
        return;
      }
    }

    if (sess.name === newName) return;

    const freshConfig = configStore.save(cfg => {
      const project = cfg.projects.find(p => p.id === sess.id);
      if (project) project.name = newName;
    });
    if (freshConfig) applyConfigReload(freshConfig);
  }

  function handleReorderSessions(msg, ws) {
    const order = msg.order;
    if (!Array.isArray(order) || order.length === 0) {
      ws.send(JSON.stringify({ type: 'error', message: 'order must be a non-empty array' }));
      return;
    }

    // order is an array of session ids
    const allExist = order.every(id => sessions.has(id));
    if (!allExist) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session list changed during reorder' }));
      broadcastControl(buildSnapshot());
      return;
    }

    const entries = new Map(sessions);
    sessions.clear();
    for (const id of order) {
      sessions.set(id, entries.get(id));
    }
    for (const [id, sess] of entries) {
      if (!sessions.has(id)) {
        sessions.set(id, sess);
      }
    }

    configStore.save(cfg => {
      const projectMap = new Map(cfg.projects.map(p => [p.id, p]));
      cfg.projects = order
        .filter(id => projectMap.has(id))
        .map(id => projectMap.get(id));
      for (const p of projectMap.values()) {
        if (!cfg.projects.some(x => x.id === p.id)) {
          cfg.projects.push(p);
        }
      }
    });

    broadcastControl({ type: 'sessions-reordered', order });
    console.log(`[control] Sessions reordered`);
  }

  function handleGetSettings(msg, ws) {
    ws.send(JSON.stringify({
      type: 'settings',
      requestId: msg.requestId || null,
      settings: configStore.getSettings()
    }));
  }

  function handleUpdateSettings(msg, ws) {
    const s = msg.settings || {};

    const invalidPaths = (s.repoRoots || []).filter(p => !fs.existsSync(p));
    if (invalidPaths.length > 0) {
      ws.send(JSON.stringify({
        type: 'settings-error',
        requestId: msg.requestId || null,
        message: `Invalid paths: ${invalidPaths.join(', ')}`
      }));
      return;
    }

    for (const key of TIMEOUT_KEYS) {
      if (s[key] != null && (typeof s[key] !== 'number' || s[key] <= 0)) {
        ws.send(JSON.stringify({
          type: 'settings-error',
          requestId: msg.requestId || null,
          message: `${key} must be a positive number`
        }));
        return;
      }
    }

    const freshConfig = configStore.save(cfg => {
      for (const key of TIMEOUT_KEYS) {
        if (s[key] != null) cfg[key] = s[key];
      }
      if (s.repoRoots != null) cfg.repoRoots = s.repoRoots;
    });
    if (!freshConfig) return;
    applySettingsReload(freshConfig);
    const updatedSettings = configStore.getSettings();

    ws.send(JSON.stringify({
      type: 'settings-updated',
      requestId: msg.requestId || null,
      settings: updatedSettings,
    }));
    broadcastControl({
      type: 'settings-updated',
      settings: updatedSettings,
    });
    console.log('[control] Settings updated via UI');
  }

  function handleScanRepoRoots(msg, ws) {
    const directories = scanRepoRoots(config.repoRoots);
    ws.send(JSON.stringify({
      type: 'repo-roots-scanned',
      requestId: msg.requestId || null,
      directories
    }));
  }

  function handleShutdown() {
    console.log('[control] Shutdown requested via UI');
    broadcastControl({ type: 'shutting-down' });
    setTimeout(() => {
      if (requestShutdown) requestShutdown();
    }, 200);
  }

  function handleRestart() {
    console.log('[control] Restart requested via UI');
    broadcastControl({ type: 'restarting' });
    setTimeout(() => {
      if (requestRestart) requestRestart();
    }, 200);
  }

  // Handler map — single dispatch table for all control message types
  // Session action handlers use findSession() for id-based lookup with name fallback.
  const handlers = {
    'add-session':      handleAddSession,
    'remove-session':   handleRemoveSession,
    'rename-session':   handleRenameSession,
    'reorder-sessions': handleReorderSessions,
    'get-settings':     handleGetSettings,
    'update-settings':  handleUpdateSettings,
    'scan-repo-roots':  handleScanRepoRoots,
    'kill':             (msg) => { const s = findSession(msg); if (s) s.killSession(); },
    'restart':          (msg) => { const s = findSession(msg); if (s) s.restart(); },
    'force-restart':    (msg) => { const s = findSession(msg); if (s) s.forceRestart(); },
    'dismiss':          (msg) => { const s = findSession(msg); if (s) s.dismiss(); },
    'shutdown':         handleShutdown,
    'restart-server':   handleRestart,
    'focus-change':     (msg, ws) => { if (handleClientFocus) handleClientFocus(ws, !!msg.focused); },
  };

  controlWss.on('connection', (ws) => {
    ws.send(JSON.stringify(buildSnapshot()));

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      const handler = handlers[msg.type];
      if (handler) {
        handler(msg, ws);
      }
    });
  });

  return { buildSnapshot };
}

module.exports = { registerControlHandlers };
