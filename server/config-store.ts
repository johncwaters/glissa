import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { canonicalizePath, equalsIgnoringCaseOnWindows } from '../shared/paths.ts';
import { DEFAULT_BRANCH_GC_PREFIXES } from './core/branch-gc-core.ts';
import { decideConfigPath, glissaHomeDir as resolveGlissaHomeDir } from './core/config-path-core.ts';
import { BranchGcFileSettings, Config, configIssueMessage, RUNTIME_CONFIG_SCALAR_KEYS } from '../shared/contracts/index.ts';
import { isPlainObject } from './core/usage-number-core.ts';
import {
  INGEST_SPEC, MEMORY_SPEC, MILL_METRICS_SPEC, PACK_DISTILLER_SPEC, pickMillBlock,
} from './core/settings-mill-core.ts';
import { writeJsonAtomicSync, writeTextAtomicSync } from './json-file.ts';
import { packageRoot } from './runtime-paths.ts';

type ProjectEntry = Config['projects'][number] & { id: string; name: string };
interface GlissaConfig extends Config {
  projects: ProjectEntry[];
}
type ConfigValidation = { ok: true } | { ok: false; errors: string[] };

const DEFAULT_CONFIG = {
  port: 3000,
  autoRecoverSeconds: 3,
  inputGraceSeconds: 5,
  promptDetectionMs: 1500,
  notifyDebounceMs: 3000,

  phoneEscalationMs: 300000,
  cursorBlink: false,
  debugMode: false,

  detectBackgroundAgents: true,

  detectScheduledWakeups: true,

  replayBufferKB: 512,

  recordSignals: true,

  checkForUpdates: true,
  updateChannel: 'release' as const,

  autoResume: true,

  millEnabled: true,

  packDistiller: {
    enabled: false,
    intervalHours: 24,
    timeoutSeconds: 900,
  },

  antiSlopPrompt: false,
  rtk: false,

  telegramNotifications: false,

  integrationBranch: null as string | null,

  worktreeRoot: '',

  worktreeShare: ['node_modules', '.env', '.env.local', '.claude', '.omc'],

  worktreeAutoRebase: true,
  worktreeSyncOnStart: true,

  worktreeRerere: true,
  branchGc: {
    enabled: true,
    worktrees: true,
    prefixes: [...DEFAULT_BRANCH_GC_PREFIXES],
    dryRun: false,
    staleDays: 14,
    intervalMs: 6 * 60 * 60 * 1000,
  },
  repoRoots: [] as string[],

  postTurnChecks: {
    enabled: true,
    mode: 'fix',

    rules: { trailingWs: true, finalNewline: true, bom: true, slop: false },
  },

  remote: {
    enabled: false,

    port: null as number | null,

    publicHost: '',

    allowedOrigins: [] as string[],
  },
  projects: [] as ProjectEntry[],
};

type DefaultConfig = typeof DEFAULT_CONFIG;

const DEFAULT_CONFIG_BY_KEY: GlissaConfig = DEFAULT_CONFIG;

const CONFIG_DIR_MODE = 0o700;
const CONFIG_FILE_MODE = 0o600;

function errorCode(error: unknown): string {
  const source = (error ?? {}) as { code?: unknown; message?: unknown };
  if (typeof source.code === 'string') return source.code;
  return typeof source.message === 'string' ? source.message : String(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function glissaHomeDir(): string {
  return resolveGlissaHomeDir(os.homedir());
}

function restrictMode(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch {

  }
}

function resolveConfigPath(): string {
  const decided = decideConfigPath({
    env: process.env,
    homeDir: glissaHomeDir(),
    packageRoot,
  }, (candidate: string) => fs.existsSync(candidate));
  if (decided.path) return decided.path;
  if (decided.source === 'env') {
    console.error(`Config file not found: ${decided.envPath}`);
    process.exit(1);
  }

  const homeConfig = decided.homePath;
  const homeDir = glissaHomeDir();
  fs.mkdirSync(homeDir, { recursive: true, mode: CONFIG_DIR_MODE });
  restrictMode(homeDir, CONFIG_DIR_MODE);
  fs.writeFileSync(homeConfig, JSON.stringify(DEFAULT_CONFIG, null, 2), { encoding: 'utf8', mode: CONFIG_FILE_MODE });
  restrictMode(homeConfig, CONFIG_FILE_MODE);
  console.log(`Created default config at ${homeConfig}`);
  return homeConfig;
}

function generateProjectId(): string {
  return crypto.randomUUID();
}

function validateConfig(candidate: unknown): ConfigValidation {
  if (!isPlainObject(candidate)) return { ok: false, errors: ['config must be a plain object'] };
  const parsedConfig = Config.safeParse(candidate);
  if (!parsedConfig.success) {
    const errors = parsedConfig.error.issues.map((issue) => {
      const [root, index, field] = issue.path;
      if (root === 'port') return 'port must be an integer from 0 to 65535';
      if (root === 'repoRoots' || root === 'worktreeShare') return `${root} must be an array of strings`;
      if (root === 'remote') return 'remote must be a plain object';
      if (root !== 'projects' && typeof DEFAULT_CONFIG_BY_KEY[String(root)] === 'number') {
        return `${String(root)} must be a finite number greater than or equal to 0`;
      }
      if (root !== 'projects') return issue.message;
      if (typeof index !== 'number') return 'projects must be an array';
      if (!field) return `projects[${index}] must be a plain object`;
      if (field === 'agent') return `projects[${index}].agent must be one of: claude-code, codex, grok`;
      if (field === 'codexBypassHookTrust') return `projects[${index}].codexBypassHookTrust must be a boolean`;
      return `projects[${index}].${String(field)} must be a string`;
    });
    return { ok: false, errors };
  }
  return { ok: true };
}

function normalizeConfigFile(candidate: unknown): GlissaConfig {
  if (!isPlainObject(candidate)) throw new Error('config must be a plain object');
  const draft: Record<string, unknown> = candidate;
  if (draft.millEnabled === undefined && draft.packsAutoRebuild === false) draft.millEnabled = false;
  for (const [key, fallback] of Object.entries(DEFAULT_CONFIG_BY_KEY)) {
    if (fallback === null || typeof fallback === 'object') continue;
    if (!Object.hasOwn(draft, key)) continue;
    const fieldSchema = Config.shape[key as keyof typeof Config.shape];
    if (!fieldSchema || fieldSchema.safeParse(draft[key]).success) continue;
    console.warn(`[config] ${key} value ${JSON.stringify(draft[key])} is invalid; using ${JSON.stringify(fallback)}`);
    draft[key] = fallback;
  }
  const validation = validateConfig(draft);
  if ('errors' in validation) throw new Error(`validation failed: ${validation.errors.join('; ')}`);
  return draft as GlissaConfig;
}

function writeBackupContent(backupPath: string, content: string): void {
  try {
    fs.writeFileSync(backupPath, content, { encoding: 'utf8', mode: CONFIG_FILE_MODE });
    restrictMode(backupPath, CONFIG_FILE_MODE);
  } catch (err) {
    console.warn(`[config] Failed to write backup ${backupPath}:`, errorCode(err));
  }
}

interface LoadedConfig {
  config: GlissaConfig;
  loadedContent: string;
}

interface FailedConfigLoad {
  config?: undefined;
  loadedContent?: undefined;
  error: unknown;
  message: string;
  invalidBackupPath: string;
}

function loadConfigFile(configPath: string, options?: { exitOnError?: true }): LoadedConfig;
function loadConfigFile(configPath: string, options: { exitOnError: false }): LoadedConfig | FailedConfigLoad;
function loadConfigFile(configPath: string, { exitOnError = true }: { exitOnError?: boolean } = {}): LoadedConfig | FailedConfigLoad {
  const loadedContent = fs.readFileSync(configPath, 'utf8');
  try {
    const parsed = normalizeConfigFile(JSON.parse(loadedContent));
    return { config: parsed, loadedContent };
  } catch (err) {
    const invalidBackupPath = `${configPath}.invalid.bak`;
    try {
      fs.writeFileSync(invalidBackupPath, loadedContent, { encoding: 'utf8', mode: CONFIG_FILE_MODE });
      restrictMode(invalidBackupPath, CONFIG_FILE_MODE);
    } catch (backupErr) {
      console.warn(`[config] Failed to save invalid config copy ${invalidBackupPath}:`, errorCode(backupErr));
    }
    const message = `[config] Could not load ${configPath}: ${errorMessage(err)}. The broken file was copied to ${invalidBackupPath} when possible. Restore from ${configPath}.boot.bak or ${configPath}.bak, then restart Glissa.`;
    if (!exitOnError) return { error: err, message, invalidBackupPath };
    console.error(message);
    process.exit(1);
  }
}

function topLevelKeyCount(candidate: unknown): number {
  if (!isPlainObject(candidate)) return 0;
  return Object.keys(candidate).length;
}

function isSuspectedExternalWipe(candidate: GlissaConfig, currentConfig: GlissaConfig): boolean {
  const currentKeyCount = topLevelKeyCount(currentConfig);
  if (currentKeyCount === 0) return false;
  const resolvedCandidate = { ...candidate, branchGc: resolveBranchGc(candidate.branchGc) };
  return topLevelKeyCount(resolvedCandidate) * 2 < currentKeyCount;
}

function warnInvalidConfig(action: string, validation: { errors: string[] }): void {
  console.warn(`[config] Refusing to ${action}; validation failed: ${validation.errors.join('; ')}. Recovery sources: config.json.bak and config.json.boot.bak.`);
}

function warnSuspectedWipe(action: string): void {
  console.warn(`[config] Refusing to ${action}; config.json has fewer than half the top-level keys of the in-memory config. This looks like an external wipe. Recovery sources: config.json.bak and config.json.boot.bak.`);
}

function ensureProjectIds(projects: { id?: string }[]): boolean {
  let changed = false;
  for (const p of projects) {
    if (!p.id) {
      p.id = generateProjectId();
      changed = true;
    }
  }
  return changed;
}

type BranchGcBlock = DefaultConfig['branchGc'];

function collectBranchGcIssues(branchGc: unknown): { block: BranchGcBlock; issues: string[] } {
  if (!isPlainObject(branchGc)) return { block: { ...DEFAULT_CONFIG.branchGc }, issues: [] };
  const accepted: Record<string, unknown> = {};
  const issues: string[] = [];
  for (const [field, value] of Object.entries(branchGc)) {
    if (!Object.hasOwn(BranchGcFileSettings.shape, field)) {
      issues.push(`[config] Ignoring unknown branchGc.${field}; it is not a branchGc setting, so the default block applies.`);
      continue;
    }
    const parsed = BranchGcFileSettings.safeParse({ [field]: value });
    if (!parsed.success) {
      issues.push(`[config] Ignoring invalid branchGc.${field}; using the default instead: ${configIssueMessage(parsed.error)}`);
      continue;
    }
    accepted[field] = value;
  }
  return { block: { ...DEFAULT_CONFIG.branchGc, ...accepted }, issues };
}

function resolveBranchGc(branchGc: unknown): BranchGcBlock {
  return collectBranchGcIssues(branchGc).block;
}

function resolveBranchGcAndWarn(branchGc: unknown): BranchGcBlock {
  const resolved = collectBranchGcIssues(branchGc);
  for (const issue of resolved.issues) console.warn(issue);
  return resolved.block;
}

const POSTHOG_SETTINGS_KEYS = Object.freeze([
  'enabled', 'recurrenceDedupe', 'trafficSpikeEnabled', 'autoFix',
  'host', 'repoPath', 'projects', 'projectMap',
  'intervalMinutes', 'maxConcurrentInvestigations', 'investigationTimeoutSeconds', 'fixTimeoutSeconds',
  'minUsersToInvestigate', 'userEscalationThreshold', 'recurrenceWindowDays', 'transientRecurrenceLimit',
  'trafficSpikeMultiplier', 'trafficSpikeMinUsers', 'trafficSpikeCooldownMinutes', 'trafficSpikeBaselineDays',
]);
const POSTHOG_SECRET_KEYS = Object.freeze(['apiKey']);
const TELEGRAM_SETTINGS_KEYS = Object.freeze(['chatId']);
const TELEGRAM_SECRET_KEYS = Object.freeze(['botToken']);
const SECRET_PRESENCE_SUFFIX = 'Configured';

function pickRedactedBlock(
  stored: unknown,
  allowedKeys: readonly string[],
  secretKeys: readonly string[],
): Record<string, unknown> | null {
  if (!isPlainObject(stored)) return null;
  const source: Record<string, unknown> = stored;
  const redacted: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (source[key] !== undefined) redacted[key] = source[key];
  }
  for (const secretKey of secretKeys) {
    const secret = source[secretKey];
    redacted[`${secretKey}${SECRET_PRESENCE_SUFFIX}`] = typeof secret === 'string' && secret.length > 0;
  }
  return redacted;
}

function createConfigStore({ settingsDefaults }: { settingsDefaults?: Partial<DefaultConfig> } = {}) {
  const configPath = resolveConfigPath();
  const effectiveDefaults: Record<string, unknown> = { ...DEFAULT_CONFIG, ...(settingsDefaults || {}) };

  const launchDefaultKeys = new Set(Object.keys(settingsDefaults || {}));

  const isLocalConfig = configPath === path.join(packageRoot, 'config.json');
  const loadedConfig = loadConfigFile(configPath);
  const config = loadedConfig.config;
  writeBackupContent(`${configPath}.boot.bak`, loadedConfig.loadedContent);
  config.repoRoots = config.repoRoots || [];
  config.branchGc = resolveBranchGcAndWarn(config.branchGc);

  if (Array.isArray(config.projects) && ensureProjectIds(config.projects)) {
    try {
      writeJsonAtomicSync(configPath, config, { mode: CONFIG_FILE_MODE });
      console.log('[config] Auto-assigned IDs to projects missing them');
    } catch (err) {
      console.warn('[config] Failed to persist auto-assigned project IDs:', errorMessage(err));
    }
  }

  let _lastWrittenContent: string | null = null;
  let _lastAppliedContent: string | null = null;

  function save(mutatorFn: (config: GlissaConfig) => void): GlissaConfig | null {
    let loaded: LoadedConfig | FailedConfigLoad;
    try {
      loaded = loadConfigFile(configPath, { exitOnError: false });
    } catch (err) {
      console.warn('[config] Failed to read config.json for save:', errorCode(err));
      return null;
    }
    if ('error' in loaded) {
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

      _lastWrittenContent = nextContent;

      _lastAppliedContent = null;

      writeTextAtomicSync(configPath, nextContent, { mode: CONFIG_FILE_MODE });
    } catch (err) {
      console.warn('[config] Failed to write config.json:', errorCode(err));
      return null;
    }
    return freshConfig;
  }

  function getSettings() {
    return {
      isLocalConfig,
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
      updateChannel: config.updateChannel ?? effectiveDefaults.updateChannel,
      autoResume: config.autoResume ?? effectiveDefaults.autoResume,
      telegramNotifications: config.telegramNotifications ?? effectiveDefaults.telegramNotifications,
      millEnabled: config.millEnabled ?? effectiveDefaults.millEnabled,
      integrationBranch: config.integrationBranch === undefined ? effectiveDefaults.integrationBranch : config.integrationBranch,
      worktreeRoot: config.worktreeRoot ?? effectiveDefaults.worktreeRoot,
      worktreeShare: config.worktreeShare ?? effectiveDefaults.worktreeShare,
      repoRoots: config.repoRoots,

      prReview: config.prReview ? { ...config.prReview } : null,
      branchGc: { ...config.branchGc },
      visions: config.visions ? { ...config.visions } : null,

      posthog: pickRedactedBlock(config.posthog, POSTHOG_SETTINGS_KEYS, POSTHOG_SECRET_KEYS),

      usage: config.usage ? { ...config.usage } : null,
      telegram: pickRedactedBlock(config.telegram, TELEGRAM_SETTINGS_KEYS, TELEGRAM_SECRET_KEYS),

      packDistiller: pickMillBlock(config.packDistiller, PACK_DISTILLER_SPEC),
      millMetrics: pickMillBlock(config.millMetrics, MILL_METRICS_SPEC),
      memory: pickMillBlock(config.memory, MEMORY_SPEC),
      ingest: pickMillBlock(config.ingest, INGEST_SPEC),

      projectChoices: (config.projects || []).map((p) => ({ id: p.id, name: p.name })),
    };
  }

  function isUnchosenLaunchDefault(target: Record<string, unknown>, key: string, value: unknown): boolean {
    if (!launchDefaultKeys.has(key)) return false;
    if (key in target) return false;
    return value === effectiveDefaults[key];
  }

  function applySettings(newConfig: Partial<GlissaConfig>): void {
    for (const key of RUNTIME_CONFIG_SCALAR_KEYS) {
      if (key === 'integrationBranch') {
        if (newConfig[key] === undefined) continue;
        config[key] = newConfig[key] === null || String(newConfig[key]) === '' ? null : String(newConfig[key]);
        continue;
      }
      if (newConfig[key] == null) continue;
      let nextValue = newConfig[key];
      if (typeof DEFAULT_CONFIG_BY_KEY[key] === 'boolean') nextValue = !!nextValue;
      if (typeof DEFAULT_CONFIG_BY_KEY[key] === 'string') nextValue = String(nextValue);
      if (typeof nextValue === 'boolean' && isUnchosenLaunchDefault(config, key, nextValue)) continue;
      config[key] = nextValue;
    }
    config.repoRoots = newConfig.repoRoots || [];

    if (newConfig.postTurnChecks != null) config.postTurnChecks = newConfig.postTurnChecks;
    if (newConfig.worktreeShare != null) config.worktreeShare = newConfig.worktreeShare;
    if (newConfig.prReview != null) config.prReview = newConfig.prReview;
    if (newConfig.branchGc != null) config.branchGc = resolveBranchGc(newConfig.branchGc);
    if (newConfig.visions != null) config.visions = newConfig.visions;
    if (newConfig.posthog != null) config.posthog = newConfig.posthog;
    if (newConfig.usage != null) config.usage = newConfig.usage;
    if (newConfig.telegram != null) config.telegram = newConfig.telegram;
    if (newConfig.packDistiller != null) config.packDistiller = newConfig.packDistiller;
    if (newConfig.millMetrics != null) config.millMetrics = newConfig.millMetrics;
    if (newConfig.memory != null) config.memory = newConfig.memory;
    if (newConfig.ingest != null) config.ingest = newConfig.ingest;

    config.hooks = Array.isArray(newConfig.hooks) ? newConfig.hooks : [];
    if (newConfig.port != null && newConfig.port !== config.port) {
      console.log(`[settings] Port changed to ${newConfig.port} - restart required to take effect`);
    }
  }

  function watchForChanges(callback: (config: GlissaConfig) => void): () => void {
    let reloadTimer: NodeJS.Timeout | null = null;
    let watcher: fs.FSWatcher | null = null;

    function handleConfigChange(err: NodeJS.ErrnoException | null, data: string): void {
      if (err) {
        console.warn('[config] Failed to read config.json:', err.code);
        return;
      }

      if (_lastWrittenContent !== null && data === _lastWrittenContent) return;
      if (_lastAppliedContent !== null && data === _lastAppliedContent) return;
      let newConfig: GlissaConfig;
      try {
        newConfig = normalizeConfigFile(JSON.parse(data));
      } catch (parseErr) {
        console.warn('[config] Invalid config.json:', errorMessage(parseErr));
        return;
      }
      newConfig.branchGc = resolveBranchGcAndWarn(newConfig.branchGc);
      if (isSuspectedExternalWipe(newConfig, config)) {
        warnSuspectedWipe('reload config.json');
        return;
      }
      _lastAppliedContent = data;

      _lastWrittenContent = null;
      callback(newConfig);
      console.log('[config] Reloaded config.json');
    }

    try {

      const canonicalConfigPath = canonicalizePath(configPath);
      const watchDir = path.dirname(canonicalConfigPath);
      const targetName = path.basename(canonicalConfigPath);

      watcher = fs.watch(watchDir, (_event, filename) => {
        if (filename != null && !equalsIgnoringCaseOnWindows(path.basename(String(filename)), targetName)) return;

        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          fs.readFile(configPath, 'utf8', handleConfigChange);
        }, 500);
      });
      console.log('[config] Watching config.json for changes');
    } catch (watchErr) {
      console.warn('[config] Failed to watch config.json:', errorMessage(watchErr));
    }
    return function stop(): void {
      if (reloadTimer) clearTimeout(reloadTimer);
      if (watcher) { try { watcher.close(); } catch {} }
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
    DEFAULT_CONFIG,
  };
}

type ConfigStore = ReturnType<typeof createConfigStore>;

export {
  createConfigStore, resolveConfigPath, glissaHomeDir, generateProjectId, ensureProjectIds, validateConfig, loadConfigFile,
  DEFAULT_CONFIG, CONFIG_DIR_MODE, CONFIG_FILE_MODE, SECRET_PRESENCE_SUFFIX,
};
export type { BranchGcBlock, ConfigStore, DefaultConfig, GlissaConfig, LoadedConfig, ProjectEntry };
