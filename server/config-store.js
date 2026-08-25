'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { canonicalizePath, equalsIgnoringCaseOnWindows } = require('../shared/paths');
const { isPlainObject } = require('./core/usage-number-core');
const {
  INGEST_SPEC, MEMORY_SPEC, PACK_DISTILLER_SPEC, pickMillBlock,
} = require('./core/settings-mill-core');
const { writeJsonAtomicSync, writeTextAtomicSync } = require('./json-file');
const { isKnownAgentId, listAgentIds } = require('../session/adapters');

const DEFAULT_CONFIG = {
  port: 3000,
  autoRecoverSeconds: 3,
  inputGraceSeconds: 5,
  promptDetectionMs: 1500,
  notifyDebounceMs: 3000,
  // How long an unacknowledged notification waits before the escalation ladder's last rung reaches
  // the off-dashboard channel (see notifications/notification-manager.js). 0 switches the rung off.
  phoneEscalationMs: 300000,
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
  // Check GitHub once at startup for a newer glissa release tag and surface the
  // update command (dashboard banner + console line). Advisory, fail-open, off-switchable.
  // See server/update-check.js.
  checkForUpdates: true,
  // Smart auto-resume: at boot, a session that had a live conversation when Glissa last shut down
  // (crash, hard kill, or graceful) auto-spawns with that conversation resumed. Kill switch; the
  // per-project gating (wasActive + resumeSessionId) lives in session/core/auto-resume.js pickAutoResume.
  // See .omc/plans/graceful-shutdown-auto-resume.md.
  autoResume: true,
  // Rebuild context packs when their sources change (watchers) plus a 15 minute fallback sweep. Kill
  // switch only, read once at boot: with it false no watcher and no timer is installed and packs are
  // whatever `glissa pack build` last wrote. See server/pack-service.js and AGENTS.md "Context Packs".
  packsAutoRebuild: true,
  // Count Read tool calls that land inside a delivered pack dir, so the operator can see whether a
  // pack is actually consumed. Costs one matcher-scoped PostToolUse hook, and only for a session that
  // delivers packs; with it false that hook is never injected. See AGENTS.md "Context Packs".
  packReadTelemetry: true,
  // The distiller lane: an LLM pass that regenerates a pack's DERIVED source files when the sources
  // they distill have drifted (server/pack-distiller.js). Off by default, and deliberately not
  // settable from the control WebSocket, like `remote`: enabling it lets a scheduled headless session
  // write files inside the install. `glissa pack distill` is the manual trigger and needs no key.
  packDistiller: {
    enabled: false,
    intervalHours: 24,
    timeoutSeconds: 900,
  },
  // Lever B: append a fixed anti-slop note to each user session's system prompt at spawn
  // (session/core/anti-slop-prompt.js). OFF by default; user sessions only (the headless lane
  // sessions never receive it). Takes effect on the next session start/restart.
  antiSlopPrompt: false,
  rtk: false,
  // Push session notifications (complete / waiting / failed) to Telegram when NO dashboard tab is
  // open anywhere, using the same config.telegram credentials the PR-review lane defines. Separate
  // from prReview.enabled on purpose: PR pings and session pings are independently switchable. Off
  // by default; see notifications/channels/telegram.js for the per-delivery gate.
  telegramNotifications: false,
  // Integration branch every worktree-backed session forks from and merges back into. If it is absent
  // locally, git-workspace.js auto-creates it (from origin/<branch>, then main/master, then HEAD); a
  // session only stays DORMANT with a notice if that creation itself fails (see its createBody).
  integrationBranch: 'develop',
  // Where session worktrees live: a stable, project-associated root (NOT system-temp), kept outside the
  // repo working tree. Empty -> a `.glissa-worktrees` sibling of each repo (resolved in backend).
  worktreeRoot: '',
  // Gitignored local context brought into each session worktree so the agent sees a complete, recognizable
  // project. Dirs are junctioned (shared, never merged); files are copied; committed/absent entries skipped.
  worktreeShare: ['node_modules', '.env', '.env.local', '.claude', '.omc'],
  // Rebase a session worktree onto the integration branch as soon as that branch moves, while the tree
  // is clean and the session quiescent (see AGENTS.md "Worktree auto-rebase"). Read at session
  // construction, so a change applies to the next construction rather than to a live session.
  worktreeAutoRebase: true,
  // Enable git rerere per repo, so a conflict resolved once is replayed automatically on every later
  // rebase of every linked worktree. Read once when the worktree engine is built (server restart).
  worktreeRerere: true,
  branchGc: {
    enabled: true,
    staleDays: 14,
    intervalMs: 6 * 60 * 60 * 1000,
  },
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
  'phoneEscalationMs',
  'replayBufferKB',
];

// Boolean settings persisted to config.json
const BOOLEAN_KEYS = [
  'cursorBlink',
  'debugMode',
  'detectBackgroundAgents',
  'recordSignals',
  'antiSlopPrompt',
  'rtk',
  'checkForUpdates',
  'autoResume',
  'telegramNotifications',
  // Both surfaced on the Mill tab. The service reads packsAutoRebuild once at boot and a session
  // reads packReadTelemetry once at spawn, so each applies from the next restart / next session.
  'packsAutoRebuild',
  'packReadTelemetry',
  // Both worktree conflict-avoidance switches, absent from getSettings for the same reason
  // (precedent: usage.rtkSavings). Validated and reloadable; each takes effect on the next session
  // construction / server restart respectively.
  'worktreeAutoRebase',
  'worktreeRerere',
];

// Free-text settings persisted to config.json.
// `remote` appears in NEITHER key list, is not echoed by getSettings, and is not read by
// applySettings: the control WebSocket is unauthenticated on localhost, so a settable remote block
// would let any local process open the machine to the network. See AGENTS.md "Remote Mode".
const STRING_KEYS = [
  'integrationBranch',
  'worktreeRoot',
];

// config.json carries the telegram bot token and the PostHog API key, and its .bak siblings carry the
// same bytes, so on a multi-user POSIX host they take the 0700/0600 discipline the pairings store and
// the hook settings file already use rather than whatever the umask happens to be. Advisory on Windows,
// where the ACL is what matters and node ignores the mode.
const CONFIG_DIR_MODE = 0o700;
const CONFIG_FILE_MODE = 0o600;

// A mode passed to writeFileSync only applies to a file it CREATES, so an existing config or backup
// keeps whatever mode it had; the chmod is what makes the 0600 claim true either way.
function restrictMode(target, mode) {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // Windows: modes are advisory there and chmod on a directory is a no-op that can still throw.
  }
}

/** The one spelling of the directory Glissa keeps runtime state in (config, pairings, recordings, built packs). */
function glissaHomeDir() {
  return path.join(os.homedir(), '.glissa');
}

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
  const homeConfig = path.join(glissaHomeDir(), 'config.json');
  if (fs.existsSync(homeConfig)) return homeConfig;

  // 4. None found - seed default at ~/.glissa/config.json
  const homeDir = glissaHomeDir();
  fs.mkdirSync(homeDir, { recursive: true, mode: CONFIG_DIR_MODE });
  restrictMode(homeDir, CONFIG_DIR_MODE);
  fs.writeFileSync(homeConfig, JSON.stringify(DEFAULT_CONFIG, null, 2), { encoding: 'utf8', mode: CONFIG_FILE_MODE });
  restrictMode(homeConfig, CONFIG_FILE_MODE);
  console.log(`Created default config at ${homeConfig}`);
  return homeConfig;
}

function generateProjectId() {
  return crypto.randomUUID();
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
      // Which agent CLI supervises this project's card. Absent = the default adapter; an unknown id
      // is refused here (the reload path) rather than silently supervising with the wrong vocabulary.
      if (project.agent != null && !isKnownAgentId(project.agent)) {
        errors.push(`projects[${index}].agent must be one of: ${listAgentIds().join(', ')}`);
      }
      // Opt-in to the supervised agent's hook-trust bypass (codex). File-only and default false: the
      // bypass runs every hook the invocation loads, repository-supplied ones included, so it is a
      // decision the operator makes per project rather than one a dashboard control can flip.
      if (project.codexBypassHookTrust != null && typeof project.codexBypassHookTrust !== 'boolean') {
        errors.push(`projects[${index}].codexBypassHookTrust must be a boolean`);
      }
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
    fs.writeFileSync(backupPath, content, { encoding: 'utf8', mode: CONFIG_FILE_MODE });
    restrictMode(backupPath, CONFIG_FILE_MODE);
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
      fs.writeFileSync(invalidBackupPath, loadedContent, { encoding: 'utf8', mode: CONFIG_FILE_MODE });
      restrictMode(invalidBackupPath, CONFIG_FILE_MODE);
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
  const resolvedCandidate = { ...candidate, branchGc: resolveBranchGc(candidate.branchGc) };
  return topLevelKeyCount(resolvedCandidate) * 2 < currentKeyCount;
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

function resolveBranchGc(branchGc) {
  if (!isPlainObject(branchGc)) return { ...DEFAULT_CONFIG.branchGc };
  return { ...DEFAULT_CONFIG.branchGc, ...branchGc };
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
  config.branchGc = resolveBranchGc(config.branchGc);

  // Auto-assign stable IDs to any projects missing them
  if (Array.isArray(config.projects) && ensureProjectIds(config.projects)) {
    try {
      writeJsonAtomicSync(configPath, config, { mode: CONFIG_FILE_MODE });
      console.log('[config] Auto-assigned IDs to projects missing them');
    } catch (err) {
      console.warn('[config] Failed to persist auto-assigned project IDs:', err.message);
    }
  }

  /*
   * Telling Glissa's own write apart from an operator's edit. This was a 500ms window, and the window
   * WAS the bug: an edit landing within 500ms of a hook-driven persist (resumeSessionId is written on
   * every hook payload carrying a new session id) was silently dropped until the operator saved again.
   *
   * Two exact-byte signatures replace it, and a reload is skipped only when it would genuinely change
   * nothing:
   *   _lastWrittenContent - what save() just wrote. Its echo is not news.
   *   _lastAppliedContent - what was last read and applied. One write is several fs events, so an
   *     identical re-read is a re-apply of state already live.
   *
   * NEITHER signature may outlive the state it describes, and each is invalidated by the other event:
   * an applied reload clears _lastWrittenContent, and a save clears _lastAppliedContent. Both hold
   * against the same failure, in mirror image - an operator who reverts the file (an editor undo) back
   * to bytes that a stale signature still names has the revert silently dropped while memory holds
   * something else, with no way to notice the two now disagree. Clearing fails toward one redundant
   * no-op reload; keeping a stale signature fails toward a dropped edit, which is not recoverable.
   *
   * Deliberately NOT compared against JSON.stringify(config): save() mutates a freshly-read copy and
   * never writes the mutation back into the in-memory object (that is what makes a per-project field
   * like resumeSessionId a disk-only persist), so live memory does not serialize to the bytes on disk
   * even immediately after a save. Suppression keyed on that would never match, and every save would
   * reload its own write back through the whole settings-reload path.
   */
  let _lastWrittenContent = null;
  let _lastAppliedContent = null;

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
    try {
      const nextContent = JSON.stringify(freshConfig, null, 2);
      if (freshContent !== nextContent) writeBackupContent(`${configPath}.bak`, freshContent);
      // Stamped BEFORE the write: fs.watch can deliver the event while writeTextAtomicSync is still
      // returning, and a signature recorded afterwards would miss its own echo.
      _lastWrittenContent = nextContent;
      // Live state has moved relative to whatever was last applied, so that signature no longer
      // describes anything true. Leaving it would drop an operator's revert back to those bytes.
      _lastAppliedContent = null;
      // The tmp file is always freshly created, so the mode lands on it and survives the rename: a save
      // also REPAIRS a config.json an older Glissa left world-readable.
      writeTextAtomicSync(configPath, nextContent, { mode: CONFIG_FILE_MODE });
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
      phoneEscalationMs: config.phoneEscalationMs ?? DEFAULT_CONFIG.phoneEscalationMs,
      replayBufferKB: config.replayBufferKB,
      cursorBlink: config.cursorBlink ?? effectiveDefaults.cursorBlink,
      debugMode: config.debugMode ?? effectiveDefaults.debugMode,
      detectBackgroundAgents: config.detectBackgroundAgents ?? effectiveDefaults.detectBackgroundAgents,
      recordSignals: config.recordSignals ?? effectiveDefaults.recordSignals,
      antiSlopPrompt: config.antiSlopPrompt ?? effectiveDefaults.antiSlopPrompt,
      rtk: config.rtk ?? effectiveDefaults.rtk,
      checkForUpdates: config.checkForUpdates ?? effectiveDefaults.checkForUpdates,
      autoResume: config.autoResume ?? effectiveDefaults.autoResume,
      telegramNotifications: config.telegramNotifications ?? effectiveDefaults.telegramNotifications,
      packsAutoRebuild: config.packsAutoRebuild ?? effectiveDefaults.packsAutoRebuild,
      packReadTelemetry: config.packReadTelemetry ?? effectiveDefaults.packReadTelemetry,
      integrationBranch: config.integrationBranch ?? effectiveDefaults.integrationBranch,
      worktreeRoot: config.worktreeRoot ?? effectiveDefaults.worktreeRoot,
      worktreeShare: config.worktreeShare ?? effectiveDefaults.worktreeShare,
      repoRoots: config.repoRoots,
      // Opt-in GitHub PR auto-review (see AGENTS.md). null when never configured, so a user who
      // never opens the PR Review tab gets a byte-identical config (not added to DEFAULT_CONFIG).
      prReview: config.prReview ? { ...config.prReview } : null,
      branchGc: { ...config.branchGc },
      visions: config.visions ? { ...config.visions } : null,
      // Opt-in PostHog monitoring lane (see AGENTS.md). Same null-when-unconfigured rule as
      // prReview, so a user who never enables it gets a byte-identical config.
      posthog: config.posthog ? { ...config.posthog } : null,
      // Usage tracking (see AGENTS.md). Same null-when-unconfigured rule, but unlike the two opt-in
      // lanes an absent block means ENABLED with defaults, not off.
      usage: config.usage ? { ...config.usage } : null,
      telegram: config.telegram ? { ...config.telegram } : null,
      // Projected through their allow-lists in BOTH directions: a file-only key (a watched root, a
      // shell list) is no more echoable than it is settable.
      packDistiller: pickMillBlock(config.packDistiller, PACK_DISTILLER_SPEC),
      memory: pickMillBlock(config.memory, MEMORY_SPEC),
      ingest: pickMillBlock(config.ingest, INGEST_SPEC),
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
    if (newConfig.branchGc != null) config.branchGc = resolveBranchGc(newConfig.branchGc);
    if (newConfig.visions != null) config.visions = newConfig.visions;
    if (newConfig.posthog != null) config.posthog = newConfig.posthog;
    if (newConfig.usage != null) config.usage = newConfig.usage;
    if (newConfig.telegram != null) config.telegram = newConfig.telegram;
    if (newConfig.packDistiller != null) config.packDistiller = newConfig.packDistiller;
    if (newConfig.memory != null) config.memory = newConfig.memory;
    if (newConfig.ingest != null) config.ingest = newConfig.ingest;
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
      // Our own write coming back, or a duplicate event for something already applied. Either way the
      // reload would change nothing.
      if (_lastWrittenContent !== null && data === _lastWrittenContent) return;
      if (_lastAppliedContent !== null && data === _lastAppliedContent) return;
      let newConfig;
      try {
        newConfig = JSON.parse(data);
      } catch (parseErr) {
        console.warn('[config] Invalid JSON in config.json:', parseErr.message);
        return;
      }
      newConfig.branchGc = resolveBranchGc(newConfig.branchGc);
      const validation = validateConfig(newConfig);
      if (!validation.ok) {
        warnInvalidConfig('reload config.json', validation);
        return;
      }
      if (isSuspectedExternalWipe(newConfig, config)) {
        warnSuspectedWipe('reload config.json');
        return;
      }
      _lastAppliedContent = data;
      // Mirror of the clear in save(): the write signature no longer describes live state either.
      _lastWrittenContent = null;
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
        // The debounce stays: one write is several fs events, and an editor's save is a burst. What
        // it no longer does is DECIDE anything - the self-write test moved to a content signature in
        // handleConfigChange, so an edit landing inside this window is read and applied like any other.
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
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
  createConfigStore, resolveConfigPath, glissaHomeDir, generateProjectId, ensureProjectIds, validateConfig, loadConfigFile,
  TIMEOUT_KEYS, BOOLEAN_KEYS, STRING_KEYS, DEFAULT_CONFIG, CONFIG_DIR_MODE, CONFIG_FILE_MODE,
};
