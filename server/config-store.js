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
  // Hold a session out of COMPLETE while it still has background sub-agents running (Task
  // run_in_background / Ctrl+B). On by default; set false to fall back to "main-agent Stop completes
  // the card" behavior (see sessions.js detectBackgroundAgents / session/core/agent-tracker.js).
  detectBackgroundAgents: true,
  // Forensic recording of a session's STRUCTURAL signals (hook payloads verbatim, state
  // transitions) to ~/.glissa/recordings. On by default and tiny; it is what a detection
  // post-mortem needs. Raw PTY byte capture is a separate opt-in (`capture.enabled`, bulky,
  // replay-harness work only). See AGENTS.md, "Session Recording", and session-recorder.js.
  recordSignals: true,
  // Check the npm registry once at startup for a newer published glissa and surface the update command
  // (dashboard banner + console line). Advisory, fail-open, off-switchable. See server/update-check.js.
  checkForUpdates: true,
  // Smart auto-resume: at boot, a session that had a live conversation when Glissa last shut down
  // (crash, hard kill, or graceful) auto-spawns with that conversation resumed. Kill switch; the
  // per-project gating (wasActive + resumeSessionId) lives in session/core/auto-resume.js pickAutoResume.
  // See .omc/plans/graceful-shutdown-auto-resume.md.
  autoResume: true,
  // Lever B: append a fixed anti-slop note to each user session's system prompt at spawn
  // (session/core/anti-slop-prompt.js). OFF by default; user sessions only (team/pack-setup
  // stage sessions never receive it). Takes effect on the next session start/restart.
  antiSlopPrompt: false,
  editorCommand: '',
  // Integration branch every worktree-backed session forks from and merges back into. If it is absent
  // locally, team-git.js auto-creates it (from origin/<branch>, then main/master, then HEAD); a session
  // only stays DORMANT with a notice if that creation itself fails (see team-git.js createBody).
  integrationBranch: 'develop',
  // Where session worktrees live: a stable, project-associated root (NOT system-temp), kept outside the
  // repo working tree. Empty -> a `.glissa-worktrees` sibling of each repo (resolved in backend).
  worktreeRoot: '',
  // Gitignored local context brought into each session worktree so the agent sees a complete, recognizable
  // project. Dirs are junctioned (shared, never merged); files are copied; committed/absent entries skipped.
  worktreeShare: ['node_modules', '.env', '.env.local', '.claude', '.omc'],
  repoRoots: [],
  // Deterministic post-turn auto-fix checks (see post-turn-checker.js). ON by
  // default: the runner's own DEFAULTS govern behavior even when this key is
  // absent, so a pre-existing config.json without it stays enabled. A per-project
  // override may live on each projects[] entry as a partial `postTurnChecks`.
  postTurnChecks: {
    enabled: true,
    mode: 'fix',
    // `slop` is the report-only code-slop detector; OFF by default (opt in per project).
    rules: { trailingWs: true, finalNewline: true, bom: true, slop: false },
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
  'detectBackgroundAgents',
  'recordSignals',
  'antiSlopPrompt',
  'checkForUpdates',
  'autoResume',
];

// Free-text settings persisted to config.json
const STRING_KEYS = [
  'editorCommand',
  'integrationBranch',
  'worktreeRoot',
];

function resolveConfigPath() {
  // 1. Explicit --config flag (via env bridge from bin/glissa.js)
  if (process.env.GLISSA_CONFIG) {
    const p = path.resolve(process.env.GLISSA_CONFIG);
    if (fs.existsSync(p)) return p;
    console.error(`Config file not found: ${p}`);
    process.exit(1);
  }

  // 2. Local config (__dirname/config.json) - dev use with `node server.js` or `vite`
  const localConfig = path.join(__dirname, '..', 'config.json');
  if (fs.existsSync(localConfig)) return localConfig;

  // 3. User home directory (~/.glissa/config.json) - installed CLI use
  const homeConfig = path.join(os.homedir(), '.glissa', 'config.json');
  if (fs.existsSync(homeConfig)) return homeConfig;

  // 4. None found - seed default at ~/.glissa/config.json
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
  // True only when the resolved config is the in-repo config.json (dev via `node server.js`/`vite`).
  // A real global install never resolves this (config.json is not in package.json `files`, so it self-
  // seeds at ~/.glissa/config.json). Used as a best-effort dev-skip for the startup update check.
  const isLocalConfig = configPath === path.join(__dirname, '..', 'config.json');
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
      detectBackgroundAgents: config.detectBackgroundAgents ?? DEFAULT_CONFIG.detectBackgroundAgents,
      recordSignals: config.recordSignals ?? DEFAULT_CONFIG.recordSignals,
      antiSlopPrompt: config.antiSlopPrompt ?? DEFAULT_CONFIG.antiSlopPrompt,
      checkForUpdates: config.checkForUpdates ?? DEFAULT_CONFIG.checkForUpdates,
      autoResume: config.autoResume ?? DEFAULT_CONFIG.autoResume,
      editorCommand: config.editorCommand ?? DEFAULT_CONFIG.editorCommand,
      integrationBranch: config.integrationBranch ?? DEFAULT_CONFIG.integrationBranch,
      worktreeRoot: config.worktreeRoot ?? DEFAULT_CONFIG.worktreeRoot,
      worktreeShare: config.worktreeShare ?? DEFAULT_CONFIG.worktreeShare,
      repoRoots: config.repoRoots,
      // Opt-in GitHub PR auto-review (see AGENTS.md). null when never configured, so a user who
      // never opens the PR Review tab gets a byte-identical config (not added to DEFAULT_CONFIG).
      prReview: config.prReview ? { ...config.prReview } : null,
      telegram: config.telegram ? { ...config.telegram } : null,
      // Read-only helper for the PR Review tab's project picker; derived, never persisted back.
      projectChoices: (config.projects || []).map(p => ({ id: p.id, name: p.name })),
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
    if (newConfig.worktreeShare != null) config.worktreeShare = newConfig.worktreeShare;
    if (newConfig.prReview != null) config.prReview = newConfig.prReview;
    if (newConfig.telegram != null) config.telegram = newConfig.telegram;
    if (newConfig.port != null && newConfig.port !== config.port) {
      console.log(`[settings] Port changed to ${newConfig.port} - restart required to take effect`);
    }
  }

  /** Watch config.json for external changes (debounced, ignores self-writes).
   * Returns a closer so shutdown can release the fs.watch handle (a leaked watcher
   * keeps the event loop alive, which hangs any embedder that expects exit). */
  function watchForChanges(callback) {
    let reloadTimer = null;
    let watcher = null;

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
      watcher = fs.watch(configPath, () => {
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
    return function stop() {
      clearTimeout(reloadTimer);
      if (watcher) { try { watcher.close(); } catch { /* already closed */ } }
      watcher = null;
    };
  }

  return {
    config,
    configPath,
    isLocalConfig,
    save,
    getSettings,
    applySettings,
    watchForChanges,
    TIMEOUT_KEYS,
    DEFAULT_CONFIG,
  };
}

module.exports = { createConfigStore, generateProjectId, ensureProjectIds, TIMEOUT_KEYS, BOOLEAN_KEYS, STRING_KEYS, DEFAULT_CONFIG };
