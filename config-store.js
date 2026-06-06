'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULT_CONFIG = {
  port: 3000,
  autoRecoverSeconds: 3,
  inputGraceSeconds: 5,
  promptDetectionMs: 1500,
  notifyDebounceMs: 3000,
  cursorBlink: false,
  debugMode: false,
  editorCommand: '',
  repoRoots: [],
  // Deterministic post-turn auto-fix checks (see post-turn-checker.js). ON by
  // default: the runner's own DEFAULTS govern behavior even when this key is
  // absent, so a pre-existing config.json without it stays enabled. A per-project
  // override may live on each projects[] entry as a partial `postTurnChecks`.
  postTurnChecks: {
    enabled: true,
    mode: 'fix',
    rules: { dashes: true, trailingWs: true, finalNewline: true, bom: true },
  },
  projects: []
};

// Single source of truth for numeric setting field names
const TIMEOUT_KEYS = [
  'autoRecoverSeconds',
  'inputGraceSeconds',
  'promptDetectionMs',
  'notifyDebounceMs',
  'replayBufferKB',
];

// Boolean settings persisted to config.json
const BOOLEAN_KEYS = [
  'cursorBlink',
  'debugMode',
];

// Free-text settings persisted to config.json
const STRING_KEYS = [
  'editorCommand',
];

function resolveConfigPath() {
  // 1. Explicit --config flag (via env bridge from bin/glissa.js)
  if (process.env.GLISSA_CONFIG) {
    const p = path.resolve(process.env.GLISSA_CONFIG);
    if (fs.existsSync(p)) return p;
    console.error(`Config file not found: ${p}`);
    process.exit(1);
  }

  // 2. Local config (__dirname/config.json) — dev use with `node server.js` or `vite`
  const localConfig = path.join(__dirname, 'config.json');
  if (fs.existsSync(localConfig)) return localConfig;

  // 3. User home directory (~/.glissa/config.json) — installed CLI use
  const homeConfig = path.join(os.homedir(), '.glissa', 'config.json');
  if (fs.existsSync(homeConfig)) return homeConfig;

  // 4. None found — seed default at ~/.glissa/config.json
  const dir = path.join(os.homedir(), '.glissa');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(homeConfig, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
  console.log(`Created default config at ${homeConfig}`);
  return homeConfig;
}

function generateProjectId() {
  return crypto.randomUUID();
}

/** Ensure every project in the array has a stable `id` field. */
function ensureProjectIds(projects) {
  let changed = false;
  for (const p of projects) {
    if (!p.id) {
      p.id = generateProjectId();
      changed = true;
    }
  }
  return changed;
}

function createConfigStore() {
  const configPath = resolveConfigPath();
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.repoRoots = config.repoRoots || [];

  // Auto-assign stable IDs to any projects missing them
  if (Array.isArray(config.projects) && ensureProjectIds(config.projects)) {
    try {
      const tmpPath = `${configPath}.tmp.${process.pid}`;
      fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf8');
      fs.renameSync(tmpPath, configPath);
      console.log('[config] Auto-assigned IDs to projects missing them');
    } catch (err) {
      console.warn('[config] Failed to persist auto-assigned project IDs:', err.message);
    }
  }

  let _lastSelfWriteTs = 0;

  /**
   * Atomic read-modify-write: reads current config.json, passes it to mutatorFn
   * for in-place mutation, then writes back. Returns the mutated config or null on error.
   */
  function save(mutatorFn) {
    let freshConfig;
    try {
      freshConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
      console.warn('[config] Failed to read config.json for save:', err.code || err.message);
      return null;
    }
    mutatorFn(freshConfig);
    _lastSelfWriteTs = Date.now();
    try {
      const tmpPath = `${configPath}.tmp.${process.pid}`;
      fs.writeFileSync(tmpPath, JSON.stringify(freshConfig, null, 2), 'utf8');
      fs.renameSync(tmpPath, configPath);
    } catch (err) {
      console.warn('[config] Failed to write config.json:', err.code || err.message);
      return null;
    }
    return freshConfig;
  }

  /** Build the settings snapshot for the control WebSocket protocol. */
  function getSettings() {
    return {
      port: config.port,
      autoRecoverSeconds: config.autoRecoverSeconds,
      inputGraceSeconds: config.inputGraceSeconds,
      promptDetectionMs: config.promptDetectionMs,
      notifyDebounceMs: config.notifyDebounceMs,
      replayBufferKB: config.replayBufferKB,
      cursorBlink: config.cursorBlink ?? DEFAULT_CONFIG.cursorBlink,
      debugMode: config.debugMode ?? DEFAULT_CONFIG.debugMode,
      editorCommand: config.editorCommand ?? DEFAULT_CONFIG.editorCommand,
      repoRoots: config.repoRoots,
    };
  }

  /** Apply settings from a new config object into the in-memory config. */
  function applySettings(newConfig) {
    for (const key of TIMEOUT_KEYS) {
      if (newConfig[key] != null) config[key] = newConfig[key];
    }
    for (const key of BOOLEAN_KEYS) {
      if (newConfig[key] != null) config[key] = !!newConfig[key];
    }
    for (const key of STRING_KEYS) {
      if (newConfig[key] != null) config[key] = String(newConfig[key]);
    }
    config.repoRoots = newConfig.repoRoots || [];
    // Object passthrough: the scalar KEY-lists above don't cover nested objects.
    // Preserve postTurnChecks across a settings reload (default-on still holds via
    // the runner's DEFAULTS when the key is absent on both sides).
    if (newConfig.postTurnChecks != null) config.postTurnChecks = newConfig.postTurnChecks;
    if (newConfig.port != null && newConfig.port !== config.port) {
      console.log(`[settings] Port changed to ${newConfig.port} — restart required to take effect`);
    }
  }

  /** Watch config.json for external changes (debounced, ignores self-writes). */
  function watchForChanges(callback) {
    let reloadTimer = null;

    function handleConfigChange(err, data) {
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
      callback(newConfig);
      console.log('[config] Reloaded config.json');
    }

    try {
      fs.watch(configPath, () => {
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          if (Date.now() - _lastSelfWriteTs < 500) return;
          fs.readFile(configPath, 'utf8', handleConfigChange);
        }, 500);
      });
      console.log('[config] Watching config.json for changes');
    } catch (watchErr) {
      console.warn('[config] Failed to watch config.json:', watchErr.message);
    }
  }

  return {
    config,
    configPath,
    save,
    getSettings,
    applySettings,
    watchForChanges,
    TIMEOUT_KEYS,
    DEFAULT_CONFIG,
  };
}

module.exports = { createConfigStore, generateProjectId, ensureProjectIds, TIMEOUT_KEYS, BOOLEAN_KEYS, STRING_KEYS, DEFAULT_CONFIG };
