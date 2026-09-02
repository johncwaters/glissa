import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { relayPath } from '../server/runtime-paths.ts';
import { buildRtkHookEntry } from '../session/core/rtk-command.ts';
import { appendUserHooks } from '../session/core/user-hooks-core.ts';
import type { UserHook } from '../session/core/user-hooks-core.ts';
import { safePathSegment } from '../shared/paths.ts';

const DEFAULT_BASE_DIR = path.join(os.tmpdir(), 'glissa-hooks');
const DEFAULT_TIMEOUT_SEC = 5;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export interface SettingsHookHandler {
  type: string;
  url?: string;
  command?: string;
  timeout?: number;
}

export interface SettingsHookEntry {
  matcher?: string;
  hooks: SettingsHookHandler[];
}

export interface SessionPermissions {
  deny?: string[];
  defaultMode?: string;
}

export interface HookSettings {
  hooks: Record<string, SettingsHookEntry[]>;
  permissions?: SessionPermissions;
  enableAllProjectMcpServers?: boolean;
  statusLine?: { type: string; command: string };
}

export interface BuildHookSettingsOptions {
  port: number;
  glissaId: string;
  token: string;
  timeoutSec?: number;
  permissions?: SessionPermissions | null;
  detectScheduledWakeups?: boolean;
  detectPackReads?: boolean;
  observeToolCalls?: boolean;
  enableProjectMcp?: boolean;
  rtkPath?: string | null;
  planLimits?: boolean;
  userSettingsPath?: string | null;
  relayPath?: string;
  userHooks?: UserHook[];
}

export interface WriteSessionSettingsOptions extends Omit<BuildHookSettingsOptions, 'token'> {
  token?: string;
  baseDir?: string;
}

function ensureOwnedDir(dir: string, mode: number): void {
  fs.mkdirSync(dir, { recursive: true, mode });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory()) throw new Error(`refusing to write hook settings: ${dir} is not a directory`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`refusing to write hook settings: ${dir} is owned by another user`);
  }
  try {
    fs.chmodSync(dir, mode);
  } catch {
  }
}

const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'Notification', 'PermissionRequest', 'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted', 'TeammateIdle'];

const WAKEUP_TOOL_MATCHER = 'ScheduleWakeup|CronCreate|CronDelete';
const PACK_READ_TOOL_MATCHER = 'Read';

const RELAY_PATH = relayPath('statusline-relay');
const NO_CHAIN = '-';

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function toForwardSlashes(value: string): string {
  return String(value).replace(/\\/g, '/');
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function readUserStatuslineCommand(settingsPath: string): string | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const entry: unknown = (parsed as Record<string, unknown>).statusLine;
    if (!entry || typeof entry !== 'object') return null;
    const statusLine = entry as Record<string, unknown>;
    if (statusLine.type !== 'command') return null;
    const command = typeof statusLine.command === 'string' ? statusLine.command.trim() : '';
    return command || null;
  } catch {
    return null;
  }
}

function buildStatuslineCommand(
  { relayPath = RELAY_PATH, postUrl, userCommand = null }:
    { relayPath?: string; postUrl: string; userCommand?: string | null },
): string {
  const encoded = userCommand ? Buffer.from(userCommand, 'utf8').toString('base64') : NO_CHAIN;
  return `node ${shellQuote(toForwardSlashes(relayPath))} ${shellQuote(postUrl)} ${shellQuote(encoded)}`;
}

function buildHookSettings({ port, glissaId, token, timeoutSec = DEFAULT_TIMEOUT_SEC, permissions = null, detectScheduledWakeups = true, detectPackReads = false, observeToolCalls = false, enableProjectMcp = false, rtkPath = null, planLimits = false, userSettingsPath = null, relayPath = RELAY_PATH, userHooks = [] }: BuildHookSettingsOptions): HookSettings {
  if (!port || !glissaId || !token) {
    throw new Error('buildHookSettings requires port, glissaId, token');
  }
  const base = `http://127.0.0.1:${port}/hook/${encodeURIComponent(glissaId)}`;
  const hookUrl = (event: string) => `${base}/${event.toLowerCase()}?t=${encodeURIComponent(token)}`;
  const hooks: Record<string, SettingsHookEntry[]> = {};
  for (const event of HOOK_EVENTS) {
    hooks[event] = [{ hooks: [{ type: 'http', url: hookUrl(event), timeout: timeoutSec }] }];
  }
  const postToolUse: string[] = [];
  if (detectScheduledWakeups) postToolUse.push(WAKEUP_TOOL_MATCHER);
  if (detectPackReads) postToolUse.push(PACK_READ_TOOL_MATCHER);
  if (postToolUse.length > 0) {
    const url = hookUrl('PostToolUse');
    hooks.PostToolUse = postToolUse.map((matcher) => ({ matcher, hooks: [{ type: 'http', url, timeout: timeoutSec }] }));
  }
  const preToolUse: SettingsHookEntry[] = [];
  if (observeToolCalls) {
    preToolUse.push({ hooks: [{ type: 'http', url: hookUrl('PreToolUse'), timeout: timeoutSec }] });
  }
  if (rtkPath) preToolUse.push(buildRtkHookEntry(rtkPath));
  if (preToolUse.length > 0) {
    hooks.PreToolUse = preToolUse;
  }
  appendUserHooks(hooks, Array.isArray(userHooks) ? userHooks : []);
  const settings: HookSettings = { hooks };
  const denyRules = permissions && Array.isArray(permissions.deny) ? permissions.deny.slice() : [];
  const defaultMode = permissions && typeof permissions.defaultMode === 'string' ? permissions.defaultMode : null;
  if (denyRules.length > 0 || defaultMode) {
    settings.permissions = {};
    if (denyRules.length > 0) settings.permissions.deny = denyRules;
    if (defaultMode) settings.permissions.defaultMode = defaultMode;
  }
  if (enableProjectMcp) {
    settings.enableAllProjectMcpServers = true;
  }
  if (planLimits) {
    const statuslinePath = userSettingsPath || path.join(os.homedir(), '.claude', 'settings.json');
    settings.statusLine = {
      type: 'command',
      command: buildStatuslineCommand({
        relayPath,
        postUrl: `${base}/statusline?t=${encodeURIComponent(token)}`,
        userCommand: readUserStatuslineCommand(statuslinePath),
      }),
    };
  }
  return settings;
}

function describeBuiltinHooks(
  { detectScheduledWakeups = true, detectPackReads = false, observeToolCalls = false, rtkPath = null }:
    { detectScheduledWakeups?: boolean; detectPackReads?: boolean; observeToolCalls?: boolean; rtkPath?: string | null } = {},
): { event: string; matcher: string | null; purpose: string }[] {
  const rows = HOOK_EVENTS.map((event) => ({ event, matcher: null as string | null, purpose: 'Status detection: POST to the Glissa hook router' }));
  if (detectScheduledWakeups) rows.push({ event: 'PostToolUse', matcher: WAKEUP_TOOL_MATCHER, purpose: 'Scheduled wakeup tracking' });
  if (detectPackReads) rows.push({ event: 'PostToolUse', matcher: PACK_READ_TOOL_MATCHER, purpose: 'Pack read tracking' });
  if (observeToolCalls) rows.push({ event: 'PreToolUse', matcher: null, purpose: 'Investigation trail: POST every tool call to the Glissa hook router' });
  if (rtkPath) rows.push({ event: 'PreToolUse', matcher: buildRtkHookEntry(rtkPath).matcher, purpose: 'rtk command rewriting' });
  return rows;
}

function settingsDetectPackReads(settings: HookSettings): boolean {
  const postToolUse = settings.hooks?.PostToolUse;
  if (!Array.isArray(postToolUse)) return false;
  return postToolUse.some((entry) => entry?.matcher === PACK_READ_TOOL_MATCHER);
}

function writeSessionSettings({ glissaId, token, baseDir = DEFAULT_BASE_DIR, ...rest }: WriteSessionSettingsOptions) {
  const tok = token || generateToken();
  const dir = path.join(baseDir, safePathSegment(glissaId));
  ensureOwnedDir(baseDir, DIR_MODE);
  ensureOwnedDir(dir, DIR_MODE);
  const settingsPath = path.join(dir, 'settings.json');
  const settings = buildHookSettings({ ...rest, glissaId, token: tok });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: FILE_MODE });
  try {
    fs.chmodSync(settingsPath, FILE_MODE);
  } catch {
  }
  return {
    settingsPath,
    dir,
    token: tok,
    packReadHook: settingsDetectPackReads(settings),
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
      }
    },
  };
}

function sweepOrphans(baseDir: string = DEFAULT_BASE_DIR, maxAgeMs: number = 24 * 60 * 60 * 1000): number {
  let baseStat: fs.Stats;
  try {
    baseStat = fs.lstatSync(baseDir);
  } catch {
    return 0;
  }
  const ownedByUs = typeof process.getuid !== 'function' || baseStat.uid === process.getuid();
  if (!baseStat.isDirectory() || !ownedByUs) {
    console.warn(`[hooks] refusing to sweep ${baseDir}: not a directory this user owns`);
    return 0;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const p = path.join(baseDir, ent.name);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) {
        fs.rmSync(p, { recursive: true, force: true });
        removed++;
      }
    } catch {
    }
  }
  return removed;
}

const safeDirSegment = safePathSegment;

export {
  buildHookSettings,
  describeBuiltinHooks,
  writeSessionSettings,
  sweepOrphans,
  generateToken,
  safeDirSegment,
  buildStatuslineCommand,
  readUserStatuslineCommand,
  HOOK_EVENTS,
  PACK_READ_TOOL_MATCHER,
  WAKEUP_TOOL_MATCHER,
  settingsDetectPackReads,
  DEFAULT_BASE_DIR,
  DEFAULT_TIMEOUT_SEC,
  DIR_MODE,
  FILE_MODE,
  RELAY_PATH,
  NO_CHAIN,
};
