'use strict';

const fs = require('fs');
const path = require('path');
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
 */
function registerControlHandlers(controlWss, deps) {
  const {
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
  } = deps;

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

    if (sessions.has(name)) {
      ws.send(JSON.stringify({ type: 'error', message: `Session "${name}" already exists` }));
      return;
    }

    const resolvedPath = path.resolve(projectPath);
    if (!fs.existsSync(resolvedPath)) {
      ws.send(JSON.stringify({ type: 'error', message: `Path does not exist: ${projectPath}` }));
      return;
    }

    // Validate path is within a configured repo root (if any are configured)
    if (config.repoRoots.length > 0) {
      const withinRoot = config.repoRoots.some(root => {
        const resolvedRoot = path.resolve(root);
        return resolvedPath === resolvedRoot || resolvedPath.startsWith(resolvedRoot + path.sep);
      });
      if (!withinRoot) {
        ws.send(JSON.stringify({ type: 'error', message: 'Path must be within a configured repository root' }));
        return;
      }
    }

    const freshConfig = configStore.save(cfg => {
      cfg.projects.push({ name, path: resolvedPath });
    });
    if (freshConfig) applyConfigReload(freshConfig);
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

    const freshConfig = configStore.save(cfg => {
      cfg.projects = cfg.projects.filter(p => p.name !== name);
    });
    if (freshConfig) applyConfigReload(freshConfig);
    console.log(`[control] Removed session via UI: ${name}`);
  }

  function handleReorderSessions(msg, ws) {
    const order = msg.order;
    if (!Array.isArray(order) || order.length === 0) {
      ws.send(JSON.stringify({ type: 'error', message: 'order must be a non-empty array' }));
      return;
    }

    const allExist = order.every(name => sessions.has(name));
    if (!allExist) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session list changed during reorder' }));
      broadcastControl(buildSnapshot());
      return;
    }

    const entries = new Map(sessions);
    sessions.clear();
    for (const name of order) {
      sessions.set(name, entries.get(name));
    }
    for (const [name, sess] of entries) {
      if (!sessions.has(name)) {
        sessions.set(name, sess);
      }
    }

    configStore.save(cfg => {
      const projectMap = new Map(cfg.projects.map(p => [p.name, p]));
      cfg.projects = order
        .filter(name => projectMap.has(name))
        .map(name => projectMap.get(name));
      for (const p of projectMap.values()) {
        if (!cfg.projects.find(x => x.name === p.name)) {
          cfg.projects.push(p);
        }
      }
    });

    broadcastControl({ type: 'sessions-reordered', order: order });
    console.log(`[control] Sessions reordered: ${order.join(', ')}`);
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
        message: 'Invalid paths: ' + invalidPaths.join(', ')
      }));
      return;
    }

    for (const key of TIMEOUT_KEYS) {
      if (s[key] != null && (typeof s[key] !== 'number' || s[key] <= 0)) {
        ws.send(JSON.stringify({
          type: 'settings-error',
          requestId: msg.requestId || null,
          message: key + ' must be a positive number'
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

  function handleSessionAction(msg) {
    const sess = sessions.get(msg.session);
    if (!sess) return;

    if (msg.type === 'kill') sess.killSession();
    else if (msg.type === 'restart') sess.restart();
    else if (msg.type === 'force-restart') sess.forceRestart();
    else if (msg.type === 'dismiss') sess.dismiss();
  }

  // Handler map — single dispatch table for all control message types
  const handlers = {
    'add-session':      handleAddSession,
    'remove-session':   handleRemoveSession,
    'reorder-sessions': handleReorderSessions,
    'get-settings':     handleGetSettings,
    'update-settings':  handleUpdateSettings,
    'scan-repo-roots':  handleScanRepoRoots,
    'kill':             handleSessionAction,
    'restart':          handleSessionAction,
    'force-restart':    handleSessionAction,
    'dismiss':          handleSessionAction,
    'shutdown':         handleShutdown,
    'restart-server':   handleRestart,
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
