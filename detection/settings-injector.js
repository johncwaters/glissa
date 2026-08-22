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

const DEFAULT_BASE_DIR = path.join(os.tmpdir(), 'glissa-hooks');
const DEFAULT_TIMEOUT_SEC = 5; // short: handler returns 200 immediately; never stall Claude

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

// Second PostToolUse matcher: pack read telemetry (did the spawned agent ever open the context pack
// it was given). Injected ONLY for a session that delivers packs, so a pack-less session's settings
// file stays byte-identical to the pre-telemetry one.
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

// Windows forbids < > : " / \ | ? * and control chars in a path segment, plus trailing dots/spaces.
// Session ids can be namespaced with colons (e.g. setup:marketing:<uuid>) - legal as map keys and
// URL-encoded in the hook URL, but illegal as an on-disk dir name. Sanitize ONLY the dir segment;
// the real glissaId still flows verbatim into the hook URL and HookRouter registration, so routing
// is unaffected. The uuid suffix keeps the sanitized name unique.
function safeDirSegment(id) {
  // eslint-disable-next-line no-control-regex
  return String(id).replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/, '') || '_';
}

// Build the Claude Code settings object with HTTP hooks for one session. An optional
// `permissions` ({ deny: [...] }) is merged in for the headless lanes - the PR-review and PostHog
// deny-lists (efficacy under --dangerously-skip-permissions is why they are a guard, not the guard).
// Omitted for ordinary user sessions, so their settings are byte-identical to before.
function buildHookSettings({ port, glissaId, token, timeoutSec = DEFAULT_TIMEOUT_SEC, permissions = null, detectScheduledWakeups = true, packReadTelemetry = false, enableProjectMcp = false, rtkPath = null, planLimits = false, userSettingsPath = null, relayPath = RELAY_PATH }) {
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
  if (packReadTelemetry) postToolUse.push(PACK_READ_TOOL_MATCHER);
  if (postToolUse.length > 0) {
    const url = `${base}/posttooluse?t=${encodeURIComponent(token)}`;
    hooks.PostToolUse = postToolUse.map((matcher) => ({ matcher, hooks: [{ type: 'http', url, timeout: timeoutSec }] }));
  }
  if (rtkPath) {
    hooks.PreToolUse = [buildRtkHookEntry(rtkPath)];
  }
  const settings = { hooks };
  if (permissions && Array.isArray(permissions.deny) && permissions.deny.length > 0) {
    settings.permissions = { deny: permissions.deny.slice() };
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

// Write the per-session settings file. Returns { settingsPath, dir, token, cleanup }.
function writeSessionSettings({ port, glissaId, token, baseDir = DEFAULT_BASE_DIR, timeoutSec = DEFAULT_TIMEOUT_SEC, permissions = null, detectScheduledWakeups = true, packReadTelemetry = false, enableProjectMcp = false, rtkPath = null, planLimits = false, userSettingsPath = null, relayPath = RELAY_PATH }) {
  const tok = token || generateToken();
  const dir = path.join(baseDir, safeDirSegment(glissaId));
  fs.mkdirSync(dir, { recursive: true });
  const settingsPath = path.join(dir, 'settings.json');
  const settings = buildHookSettings({ port, glissaId, token: tok, timeoutSec, permissions, detectScheduledWakeups, packReadTelemetry, enableProjectMcp, rtkPath, planLimits, userSettingsPath, relayPath });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return {
    settingsPath,
    dir,
    token: tok,
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

// Delete per-session settings dirs older than maxAgeMs (orphans from prior crashes).
// Best-effort; skips locked/inaccessible entries.
function sweepOrphans(baseDir = DEFAULT_BASE_DIR, maxAgeMs = 24 * 60 * 60 * 1000) {
  let entries;
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return 0; // base dir doesn't exist yet
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
  writeSessionSettings,
  sweepOrphans,
  generateToken,
  safeDirSegment,
  buildStatuslineCommand,
  readUserStatuslineCommand,
  HOOK_EVENTS,
  WAKEUP_TOOL_MATCHER,
  PACK_READ_TOOL_MATCHER,
  DEFAULT_BASE_DIR,
  DEFAULT_TIMEOUT_SEC,
  RELAY_PATH,
  NO_CHAIN,
};
