'use strict';

// Settings injector - writes a per-session Claude Code settings file containing
// HTTP-type hooks whose URLs carry the session's glissaId + bearer token, and returns
// the `--settings <path>` arg appended to the claude spawn. No shell command (HTTP
// hooks) => Windows-clean. Files live under a per-session subdir of the OS temp dir
// and are removed on session destroy; a boot-time sweep clears orphans from crashes.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { buildRtkHookEntry } = require('../session/core/rtk-command');
const { appendUserHooks } = require('../session/core/user-hooks-core');
const { safePathSegment } = require('../shared/paths.ts');

const DEFAULT_BASE_DIR = path.join(os.tmpdir(), 'glissa-hooks');
const DEFAULT_TIMEOUT_SEC = 5; // short: handler returns 200 immediately; never stall Claude

// This file carries a live session's hook bearer token, and it lives in the SHARED system temp dir on
// POSIX hosts. Written with default modes, any other user on a multi-user box could read every live
// token and forge hook callbacks (false COMPLETE, false WAITING, draining the pack-notice channel), so
// the directory and the file take the same 0700/0600 discipline the pairings store and uploads use.
// No-ops on Windows, where the ACL is what matters and node ignores the mode.
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * A directory an attacker pre-created (or replaced with a symlink) in shared /tmp turns the spawn-time
 * write into an arbitrary-file write as the server account, so a base dir Glissa did not just create
 * has to prove it is a real directory this user owns before anything is written under it. mkdir with
 * recursive:true does not apply the mode to a path that already exists, hence the explicit chmod.
 */
function ensureOwnedDir(dir, mode) {
  fs.mkdirSync(dir, { recursive: true, mode });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory()) throw new Error(`refusing to write hook settings: ${dir} is not a directory`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`refusing to write hook settings: ${dir} is owned by another user`);
  }
  try {
    fs.chmodSync(dir, mode);
  } catch {
    // Windows: modes are advisory and chmod on a directory is a no-op that can still throw.
  }
}

// Hook events Glissa subscribes to. Notification covers idle_prompt (=>ready) and
// permission_prompt (=>awaiting-input); see hook-source.mapHookToSignal. SubagentStart/
// SubagentStop are not state transitions: they track the live background sub-agent count so a
// main-agent Stop fired while a background sub-agent is still running does not falsely COMPLETE.
// TaskCreated/TaskCompleted/TeammateIdle are likewise tracking-only: they drain (or reactivate)
// the declared background_tasks gate precisely, so an idle-but-alive teammate (declared
// status:running on every Stop until shutdown) releases a gated completion immediately instead
// of pinning the card WORKING until the TTL.
const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'Notification', 'PermissionRequest', 'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted', 'TeammateIdle'];

// PostToolUse is subscribed ONLY with this tool-name matcher (scheduled-revival tracking:
// ScheduleWakeup = dynamic /loop sleep, CronCreate/CronDelete = cron tasks). The matcher is
// essential: a matcher-less PostToolUse hook would POST on EVERY tool call. hook-source
// re-filters by tool_name server-side as defense in depth.
const WAKEUP_TOOL_MATCHER = 'ScheduleWakeup|CronCreate|CronDelete';
const PACK_READ_TOOL_MATCHER = 'Read';

// The managed statusLine relay, and the marker meaning "the operator had no statusLine of their own".
const RELAY_PATH = path.resolve(__dirname, '..', 'session', 'statusline-relay.js');
const NO_CHAIN = '-';

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Claude Code runs the statusLine command through git-bash on Windows, where a backslash path dies
// silently with exit 127, so every path in the command string is forward-slashed.
function toForwardSlashes(value) {
  return String(value).replace(/\\/g, '/');
}

// Single-quote for that same shell. The relay path and the hook URL are ours, but the URL carries a
// query string and the base64 carries + and /, so nothing goes in bare.
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/*
 * The statusLine the operator already had, read at spawn time from ~/.claude/settings.json. Best
 * effort by design: absent, unreadable or malformed all mean "nothing to chain", which is a valid
 * state, not an error. Only a command-type entry can be chained; any other type is left alone.
 */
function readUserStatuslineCommand(settingsPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const entry = parsed?.statusLine;
    if (!entry || typeof entry !== 'object') return null;
    if (entry.type !== 'command') return null;
    const command = typeof entry.command === 'string' ? entry.command.trim() : '';
    return command || null;
  } catch {
    return null;
  }
}

/*
 * A statusLine in a per-session settings file REPLACES the global one rather than adding to it
 * (live-verified, Claude Code 2.1.235), so the operator's own command is base64'd into our argv and the
 * relay runs it. Base64 because a HUD command can contain quotes, spaces and shell metacharacters that
 * would otherwise have to survive two levels of quoting.
 */
function buildStatuslineCommand({ relayPath = RELAY_PATH, postUrl, userCommand = null }) {
  const encoded = userCommand ? Buffer.from(userCommand, 'utf8').toString('base64') : NO_CHAIN;
  return `node ${shellQuote(toForwardSlashes(relayPath))} ${shellQuote(postUrl)} ${shellQuote(encoded)}`;
}

// Build the Claude Code settings object with HTTP hooks for one session. An optional
// `permissions` ({ deny: [...], defaultMode }) is merged in for the headless lanes - the PR-review and
// PostHog deny-lists (efficacy under --dangerously-skip-permissions is why they are a guard, not the
// guard), plus the `acceptEdits` mode that is the actual write boundary for the two prompt-embedding
// lanes (server/core/lane-permissions-core.js). A lane passing neither leaves the file as it was, so
// ordinary user sessions stay byte-identical to before.
/**
 * @param {{ port: number, glissaId: string, token: string, timeoutSec?: number, permissions?: { deny?: string[], defaultMode?: string } | null, detectScheduledWakeups?: boolean, detectPackReads?: boolean, enableProjectMcp?: boolean, rtkPath?: string | null, planLimits?: boolean, userSettingsPath?: string | null, relayPath?: string, userHooks?: import('../session/core/user-hooks-core').UserHook[] }} options
 */
function buildHookSettings({ port, glissaId, token, timeoutSec = DEFAULT_TIMEOUT_SEC, permissions = null, detectScheduledWakeups = true, detectPackReads = false, enableProjectMcp = false, rtkPath = null, planLimits = false, userSettingsPath = null, relayPath = RELAY_PATH, userHooks = [] }) {
  if (!port || !glissaId || !token) {
    throw new Error('buildHookSettings requires port, glissaId, token');
  }
  const base = `http://127.0.0.1:${port}/hook/${encodeURIComponent(glissaId)}`;
  const hooks = {};
  for (const event of HOOK_EVENTS) {
    const url = `${base}/${event.toLowerCase()}?t=${encodeURIComponent(token)}`;
    hooks[event] = [{ hooks: [{ type: 'http', url, timeout: timeoutSec }] }];
  }
  const postToolUse = [];
  if (detectScheduledWakeups) postToolUse.push(WAKEUP_TOOL_MATCHER);
  if (detectPackReads) postToolUse.push(PACK_READ_TOOL_MATCHER);
  if (postToolUse.length > 0) {
    const url = `${base}/posttooluse?t=${encodeURIComponent(token)}`;
    hooks.PostToolUse = postToolUse.map((matcher) => ({ matcher, hooks: [{ type: 'http', url, timeout: timeoutSec }] }));
  }
  if (rtkPath) {
    hooks.PreToolUse = [buildRtkHookEntry(rtkPath)];
  }
  // Operator hooks (the Hooks tab) go LAST under their event, so nothing above can be displaced and a
  // session with none configured writes a file byte-identical to before.
  appendUserHooks(hooks, Array.isArray(userHooks) ? userHooks : []);
  /** @type {{ hooks: Record<string, unknown>, permissions?: { deny?: string[], defaultMode?: string }, enableAllProjectMcpServers?: boolean, statusLine?: { type: string, command: string } }} */
  const settings = { hooks };
  const denyRules = permissions && Array.isArray(permissions.deny) ? permissions.deny.slice() : [];
  const defaultMode = permissions && typeof permissions.defaultMode === 'string' ? permissions.defaultMode : null;
  if (denyRules.length > 0 || defaultMode) {
    settings.permissions = {};
    if (denyRules.length > 0) settings.permissions.deny = denyRules;
    if (defaultMode) settings.permissions.defaultMode = defaultMode;
  }
  // Headless (`-p`) sessions cannot answer the interactive "trust this .mcp.json server?" prompt, so a
  // project MCP server would otherwise never load. This flag pre-trusts every project-scoped server for
  // the session. Added ONLY when a lane opts in, so ordinary sessions stay byte-identical.
  if (enableProjectMcp) {
    settings.enableAllProjectMcpServers = true;
  }
  /*
   * Official plan-limit ingestion. The statusLine payload is the only place Claude Code publishes the
   * `/usage` rate limits to anything outside itself, and it arrives on a change signal rather than a
   * heartbeat (zero invocations while idle). Injected only when the lane is on, so an opted-out session
   * writes a settings file byte-identical to the pre-statusline one.
   */
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

/*
 * What buildHookSettings above writes, as rows the Hooks tab lists under "Glissa's own hooks". Derived
 * from the same two switches (and the same rtk entry builder) rather than restated, because a
 * hand-written copy of this list drifts the moment either switch changes what the file gets.
 */
/**
 * @param {{ detectScheduledWakeups?: boolean, detectPackReads?: boolean, rtkPath?: string | null }} [options]
 * @returns {Array<{ event: string, matcher: string | null, purpose: string }>}
 */
function describeBuiltinHooks({ detectScheduledWakeups = true, detectPackReads = false, rtkPath = null } = {}) {
  const rows = HOOK_EVENTS.map((event) => ({ event, matcher: /** @type {string | null} */ (null), purpose: 'Status detection: POST to the Glissa hook router' }));
  if (detectScheduledWakeups) rows.push({ event: 'PostToolUse', matcher: WAKEUP_TOOL_MATCHER, purpose: 'Scheduled wakeup tracking' });
  if (detectPackReads) rows.push({ event: 'PostToolUse', matcher: PACK_READ_TOOL_MATCHER, purpose: 'Pack read tracking' });
  if (rtkPath) rows.push({ event: 'PreToolUse', matcher: buildRtkHookEntry(rtkPath).matcher, purpose: 'rtk command rewriting' });
  return rows;
}

// Write the per-session settings file. Returns { settingsPath, dir, token, cleanup }.
/** @param {{ hooks?: Record<string, unknown> }} settings */
function settingsDetectPackReads(settings) {
  const postToolUse = settings?.hooks?.PostToolUse;
  if (!Array.isArray(postToolUse)) return false;
  return postToolUse.some((entry) => entry?.matcher === PACK_READ_TOOL_MATCHER);
}

// Everything this does not use itself is forwarded to buildHookSettings, which owns those defaults.
/**
 * @param {{ port: number, glissaId: string, token?: string, baseDir?: string,
 *   timeoutSec?: number, permissions?: { deny?: string[], defaultMode?: string } | null,
 *   detectScheduledWakeups?: boolean, detectPackReads?: boolean, enableProjectMcp?: boolean, rtkPath?: string | null,
 *   planLimits?: boolean, userSettingsPath?: string | null, relayPath?: string,
 *   userHooks?: import('../session/core/user-hooks-core').UserHook[] }} options
 */
function writeSessionSettings({ glissaId, token, baseDir = DEFAULT_BASE_DIR, ...rest }) {
  const tok = token || generateToken();
  const dir = path.join(baseDir, safePathSegment(glissaId));
  ensureOwnedDir(baseDir, DIR_MODE);
  ensureOwnedDir(dir, DIR_MODE);
  const settingsPath = path.join(dir, 'settings.json');
  const settings = buildHookSettings({ ...rest, glissaId, token: tok });
  // mode on writeFileSync only applies to a file it CREATES, so a settings file left behind by an
  // earlier run keeps whatever mode it had; the chmod is what makes the 0600 claim true either way.
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: FILE_MODE });
  try {
    fs.chmodSync(settingsPath, FILE_MODE);
  } catch {
    // Windows again: advisory, and a failure here must not cost the spawn.
  }
  return {
    settingsPath,
    dir,
    token: tok,
    // What the file actually got, not what was asked for: the measurement lane reports a pack delivery
    // as unmeasurable unless the Read matcher really reached this settings file.
    packReadHook: settingsDetectPackReads(settings),
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

// Boot-time recursive delete of aged orphan dirs, so the base dir gets ensureOwnedDir's discipline non-destructively: a planted symlink or alien-owned base sweeps NOTHING (entries inside need no check, a dirent is isDirectory() only for a real directory).
function sweepOrphans(baseDir = DEFAULT_BASE_DIR, maxAgeMs = 24 * 60 * 60 * 1000) {
  let baseStat;
  try {
    baseStat = fs.lstatSync(baseDir);
  } catch {
    return 0; // base dir doesn't exist yet
  }
  const ownedByUs = typeof process.getuid !== 'function' || baseStat.uid === process.getuid();
  if (!baseStat.isDirectory() || !ownedByUs) {
    console.warn(`[hooks] refusing to sweep ${baseDir}: not a directory this user owns`);
    return 0;
  }
  let entries;
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
      /* skip */
    }
  }
  return removed;
}

module.exports = {
  buildHookSettings,
  describeBuiltinHooks,
  writeSessionSettings,
  sweepOrphans,
  generateToken,
  safeDirSegment: safePathSegment,
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
