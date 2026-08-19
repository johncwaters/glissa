'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { canonicalizePath, equalsIgnoringCaseOnWindows } = require('../shared/paths');

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
  // Advisory "sleeping until ~HH:MM" chip for a session that scheduled its own revival (a dynamic
  // /loop wakeup or a cron task). Never gates a transition. On by default; see sessions.js
  // detectScheduledWakeups / session/core/wakeup-tracker.js.
  detectScheduledWakeups: true,
  // How much terminal history (KB) each session's replay ring retains, backfilling a reconnecting
  // client. Matches the Session constructor's own default (session/sessions.js) and the settings
  // dialog's fallback (public/dialogs.js), so a config.json that omits this key is unaffected.
  replayBufferKB: 512,
  // Forensic recording of a session's STRUCTURAL signals (hook payloads verbatim, state
  // transitions) to ~/.glissa/recordings. On by default and tiny; it is what a detection
  // post-mortem needs. Raw PTY byte capture is a separate opt-in (`capture.enabled`, bulky,
  // replay-harness work only). See AGENTS.md, "Session Recording", and session-recorder.js.
  recordSignals: true,
  // Check GitHub once at startup (the main branch's package.json) for a newer glissa and surface the
  // update command (dashboard banner + console line). Advisory, fail-open, off-switchable.
  // See server/update-check.js.
  checkForUpdates: true,
  // Smart auto-resume: at boot, a session that had a live conversation when Glissa last shut down
  // (crash, hard kill, or graceful) auto-spawns with that conversation resumed. Kill switch; the
  // per-project gating (wasActive + resumeSessionId) lives in session/core/auto-resume.js pickAutoResume.
  // See .omc/plans/graceful-shutdown-auto-resume.md.
  autoResume: true,
  // Lever B: append a fixed anti-slop note to each user session's system prompt at spawn
  // (session/core/anti-slop-prompt.js). OFF by default; user sessions only (the headless lane
  // sessions never receive it). Takes effect on the next session start/restart.
  antiSlopPrompt: false,
  // Push session notifications (complete / waiting / failed) to Telegram when NO dashboard tab is
  // open anywhere, using the same config.telegram credentials the PR-review lane defines. Separate
  // from prReview.enabled on purpose: PR pings and session pings are independently switchable. Off
  // by default; see notifications/channels/telegram.js for the per-delivery gate.
  telegramNotifications: false,
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
  // Remote access (off by default, see AGENTS.md "Remote Mode"). When enabled the server opens a
  // SECOND listener on remote.port that requires a paired device cookie for everything except
  // /pair/*; the local 127.0.0.1 listener is untouched. Deliberately NOT reachable from the control
  // WebSocket: the local dashboard is unauthenticated, so letting it edit these keys would turn any
  // local process into a remote-access grant. Config file or CLI only, restart required.
  remote: {
    enabled: false,
    // Port for the remote listener (the reverse proxy's upstream). Must differ from `port`.
    port: null,
    // Public hostname used to BUILD pairing URLs. Binds nothing.
    publicHost: '',
    // Browser origins allowed to open a WebSocket. Empty + publicHost set defaults to
    // ["https://<publicHost>"]. Supports a leading "*." host wildcard.
    allowedOrigins: [],
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
  'telegramNotifications',
];

// Free-text settings persisted to config.json.
// `remote` appears in NEITHER key list, is not echoed by getSettings, and is not read by
// applySettings: the control WebSocket is unauthenticated on localhost, so a settable remote block
// would let any local process open the machine to the network. See AGENTS.md "Remote Mode".
const STRING_KEYS = [
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

function isPlainObject(value) {
  if (value == null || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function validateConfig(candidate) {
  const errors = [];
  if (!isPlainObject(candidate)) {
    return { ok: false, errors: ['config must be a plain object'] };
  }
  if (!Array.isArray(candidate.projects)) {
    errors.push('projects must be an array');
  }
  if (Array.isArray(candidate.projects)) {
    candidate.projects.forEach((project, index) => {
      if (!isPlainObject(project)) {
        errors.push(`projects[${index}] must be a plain object`);
        return;
      }
      if (typeof project.path !== 'string') errors.push(`projects[${index}].path must be a string`);
      if (project.id != null && typeof project.id !== 'string') errors.push(`projects[${index}].id must be a string`);
    });
  }
  if (candidate.port != null && (!Number.isInteger(candidate.port) || candidate.port < 1 || candidate.port > 65535)) {
    errors.push('port must be an integer from 1 to 65535');
  }
  for (const key of TIMEOUT_KEYS) {
    if (candidate[key] == null) continue;
    if (typeof candidate[key] !== 'number' || !Number.isFinite(candidate[key]) || candidate[key] < 0) {
      errors.push(`${key} must be a finite number greater than or equal to 0`);
    }
  }
  for (const key of BOOLEAN_KEYS) {
    if (candidate[key] == null) continue;
    if (typeof candidate[key] !== 'boolean') errors.push(`${key} must be a boolean`);
  }
  for (const key of STRING_KEYS) {
    if (candidate[key] == null) continue;
    if (typeof candidate[key] !== 'string') errors.push(`${key} must be a string`);
  }
  for (const key of ['repoRoots', 'worktreeShare']) {
    if (candidate[key] == null) continue;
    if (!Array.isArray(candidate[key])) {
      errors.push(`${key} must be an array of strings`);
      continue;
    }
    if (candidate[key].some((entry) => typeof entry !== 'string')) {
      errors.push(`${key} must be an array of strings`);
    }
  }
  if (candidate.remote != null && !isPlainObject(candidate.remote)) {
    errors.push('remote must be a plain object');
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}

function writeBackupContent(backupPath, content) {
  try {
    fs.writeFileSync(backupPath, content, 'utf8');
  } catch (err) {
    console.warn(`[config] Failed to write backup ${backupPath}:`, err.code || err.message);
  }
}

function loadConfigFile(configPath, { exitOnError = true } = {}) {
  const loadedContent = fs.readFileSync(configPath, 'utf8');
  try {
    const parsed = JSON.parse(loadedContent);
    return { config: parsed, loadedContent };
  } catch (err) {
    const invalidBackupPath = `${configPath}.invalid.bak`;
    try {
      fs.writeFileSync(invalidBackupPath, loadedContent, 'utf8');
    } catch (backupErr) {
      console.warn(`[config] Failed to save invalid config copy ${invalidBackupPath}:`, backupErr.code || backupErr.message);
    }
    const message = `[config] Could not parse ${configPath}: ${err.message}. The broken file was copied to ${invalidBackupPath} when possible. Restore from ${configPath}.boot.bak or ${configPath}.bak, then restart Glissa.`;
    if (!exitOnError) return { error: err, message, invalidBackupPath };
    console.error(message);
    process.exit(1);
  }
}

function topLevelKeyCount(candidate) {
  if (!isPlainObject(candidate)) return 0;
  return Object.keys(candidate).length;
}

function isSuspectedExternalWipe(candidate, currentConfig) {
  const currentKeyCount = topLevelKeyCount(currentConfig);
  if (currentKeyCount === 0) return false;
  return topLevelKeyCount(candidate) * 2 < currentKeyCount;
}

function warnInvalidConfig(action, validation) {
  console.warn(`[config] Refusing to ${action}; validation failed: ${validation.errors.join('; ')}. Recovery sources: config.json.bak and config.json.boot.bak.`);
}

function warnSuspectedWipe(action) {
  console.warn(`[config] Refusing to ${action}; config.json has fewer than half the top-level keys of the in-memory config. This looks like an external wipe. Recovery sources: config.json.bak and config.json.boot.bak.`);
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

/**
 * @param {object} [opts]
 * @param {object} [opts.settingsDefaults] Per-launch overrides of DEFAULT_CONFIG used ONLY as the
 *   fallback for keys the config file omits (getSettings). Nothing is persisted, and an explicit
 *   key in config.json still wins. The dev server (vite.config.js) uses it to default debugMode on.
 *   Constraint: only overlay a key with NO direct server-side `config[key]` consumer. The overlay
 *   exists solely in the getSettings echo, so a reader touching config[key] would still see the
 *   raw (absent) value; and applySettings deliberately declines to materialize an incoming value
 *   equal to the launch default, so a hand-edit to exactly that value never lands in config either.
 */
function createConfigStore({ settingsDefaults } = {}) {
  const configPath = resolveConfigPath();
  const effectiveDefaults = { ...DEFAULT_CONFIG, ...(settingsDefaults || {}) };
  // The keys whose default this launch overrides. A launch default is a fallback, never a value:
  // it must not be materialized into config.json by a save that merely echoed it back, or the dev
  // overlay would leak into production the first time the operator changes an unrelated setting.
  const launchDefaultKeys = new Set(Object.keys(settingsDefaults || {}));
  // True only when the resolved config is the in-repo config.json (dev via `node server.js`/`vite`).
  // A real global install never resolves this (config.json is not in package.json `files`, so it self-
  // seeds at ~/.glissa/config.json). Used as a best-effort dev-skip for the startup update check.
  const isLocalConfig = configPath === path.join(__dirname, '..', 'config.json');
  const loadedConfig = loadConfigFile(configPath);
  const config = loadedConfig.config;
  writeBackupContent(`${configPath}.boot.bak`, loadedConfig.loadedContent);
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
    let loaded;
    try {
      loaded = loadConfigFile(configPath, { exitOnError: false });
    } catch (err) {
      console.warn('[config] Failed to read config.json for save:', err.code || err.message);
      return null;
    }
    if (loaded.error) {
      console.warn(loaded.message);
      return null;
    }
    const freshConfig = loaded.config;
    const freshContent = loaded.loadedContent;
    const freshValidation = validateConfig(freshConfig);
    if (!freshValidation.ok) {
      warnInvalidConfig('save config.json', freshValidation);
      return null;
    }
    if (isSuspectedExternalWipe(freshConfig, config)) {
      warnSuspectedWipe('save config.json');
      return null;
    }
    mutatorFn(freshConfig);
    const mutatedValidation = validateConfig(freshConfig);
    if (!mutatedValidation.ok) {
      warnInvalidConfig('save config.json', mutatedValidation);
      return null;
    }
    _lastSelfWriteTs = Date.now();
    try {
      const tmpPath = `${configPath}.tmp.${process.pid}`;
      const nextContent = JSON.stringify(freshConfig, null, 2);
      if (freshContent !== nextContent) writeBackupContent(`${configPath}.bak`, freshContent);
      fs.writeFileSync(tmpPath, nextContent, 'utf8');
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
      cursorBlink: config.cursorBlink ?? effectiveDefaults.cursorBlink,
      debugMode: config.debugMode ?? effectiveDefaults.debugMode,
      detectBackgroundAgents: config.detectBackgroundAgents ?? effectiveDefaults.detectBackgroundAgents,
      recordSignals: config.recordSignals ?? effectiveDefaults.recordSignals,
      antiSlopPrompt: config.antiSlopPrompt ?? effectiveDefaults.antiSlopPrompt,
      checkForUpdates: config.checkForUpdates ?? effectiveDefaults.checkForUpdates,
      autoResume: config.autoResume ?? effectiveDefaults.autoResume,
      telegramNotifications: config.telegramNotifications ?? effectiveDefaults.telegramNotifications,
      integrationBranch: config.integrationBranch ?? effectiveDefaults.integrationBranch,
      worktreeRoot: config.worktreeRoot ?? effectiveDefaults.worktreeRoot,
      worktreeShare: config.worktreeShare ?? effectiveDefaults.worktreeShare,
      repoRoots: config.repoRoots,
      // Opt-in GitHub PR auto-review (see AGENTS.md). null when never configured, so a user who
      // never opens the PR Review tab gets a byte-identical config (not added to DEFAULT_CONFIG).
      prReview: config.prReview ? { ...config.prReview } : null,
      // Opt-in PostHog monitoring lane (see AGENTS.md). Same null-when-unconfigured rule as
      // prReview, so a user who never enables it gets a byte-identical config.
      posthog: config.posthog ? { ...config.posthog } : null,
      telegram: config.telegram ? { ...config.telegram } : null,
      // Read-only helper for the PR Review tab's project picker; derived, never persisted back.
      projectChoices: (config.projects || []).map(p => ({ id: p.id, name: p.name })),
    };
  }

  /**
   * True when writing `key` into `target` would materialize a launch default the operator never
   * chose: the key is absent there AND the incoming value is exactly what this launch was already
   * defaulting it to. The write is then a no-op in meaning and a permanent change on disk, so both
   * the persistence path (control-handlers) and applySettings skip it. Once the key exists, or the
   * value differs (the operator actually flipped it), it is written normally and wins everywhere.
   */
  function isUnchosenLaunchDefault(target, key, value) {
    if (!launchDefaultKeys.has(key)) return false;
    if (key in target) return false;
    return value === effectiveDefaults[key];
  }

  /** Apply settings from a new config object into the in-memory config. */
  function applySettings(newConfig) {
    for (const key of TIMEOUT_KEYS) {
      if (newConfig[key] != null) config[key] = newConfig[key];
    }
    for (const key of BOOLEAN_KEYS) {
      if (newConfig[key] == null) continue;
      // Keeping the key absent in memory too, so the getSettings fallback (and therefore a later
      // hand-edit of config.json) keeps describing the file rather than a phantom value.
      if (isUnchosenLaunchDefault(config, key, !!newConfig[key])) continue;
      config[key] = !!newConfig[key];
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
    if (newConfig.posthog != null) config.posthog = newConfig.posthog;
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
      const validation = validateConfig(newConfig);
      if (!validation.ok) {
        warnInvalidConfig('reload config.json', validation);
        return;
      }
      if (isSuspectedExternalWipe(newConfig, config)) {
        warnSuspectedWipe('reload config.json');
        return;
      }
      callback(newConfig);
      console.log('[config] Reloaded config.json');
    }

    try {
      // Canonical path required: fs.watch on an 8.3 short path aborts the process from native code,
      // past this catch (see canonicalizePath in shared/paths.js).
      const canonicalConfigPath = canonicalizePath(configPath);
      const watchDir = path.dirname(canonicalConfigPath);
      const targetName = path.basename(canonicalConfigPath);
      // Watching the DIRECTORY, not the file: save() commits via tmp+rename, which replaces the
      // inode, and an inotify watch follows the dead inode - so on Linux a file watcher stopped
      // seeing hand-edits after the first save. Windows watches the directory either way.
      watcher = fs.watch(watchDir, (_event, filename) => {
        if (filename != null && !equalsIgnoringCaseOnWindows(path.basename(String(filename)), targetName)) return;
        // Stamped when the EVENT arrives, not when the debounce fires: the two windows are both
        // 500ms, so measuring at fire time always reads as "500ms since the self-write" and every
        // save() (one per persisted session field) would reload its own write back through the
        // whole settings-reload path.
        const eventTs = Date.now();
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          if (eventTs - _lastSelfWriteTs < 500) return;
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
    isUnchosenLaunchDefault,
    watchForChanges,
    TIMEOUT_KEYS,
    DEFAULT_CONFIG,
  };
}

module.exports = {
  createConfigStore, resolveConfigPath, generateProjectId, ensureProjectIds, validateConfig, loadConfigFile,
  TIMEOUT_KEYS, BOOLEAN_KEYS, STRING_KEYS, DEFAULT_CONFIG,
};
