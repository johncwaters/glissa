'use strict';

// Operator-defined Claude Code hooks (the Hooks tab). Pure: the catalog of events an operator may hook,
// the normalization every write goes through before it touches config.json, the list edits, the
// per-project scoping at spawn, and the translation into the `hooks` block of a per-session settings
// file. No IO, no clock, no Session; the IDs a caller mints come in from outside.
//
// A record is deliberately a subset of what Claude Code accepts: one event, one optional matcher, one
// handler of type `command` or `http`. Anything richer (prompt-type hooks, per-hook `if` clauses) stays
// a hand edit of ~/.claude/settings.json, which Claude Code still honors for a Glissa-spawned session.

const MAX_NAME_LENGTH = 64;
const MAX_MATCHER_LENGTH = 200;
const MAX_COMMAND_LENGTH = 4000;
const MAX_URL_LENGTH = 2000;
const MAX_TIMEOUT_SEC = 600;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HTTP_URL_RE = /^https?:\/\/\S+$/i;


// Every event Claude Code fires that an operator can usefully subscribe to, with what its matcher
// matches (null: the event takes no matcher and one is refused) and `http: false` where Claude Code
// runs command handlers only. Kept as data so the dashboard renders the picker from the report rather
// than carrying a second copy of this list.
/** @typedef {{ name: string, matcher: string | null, description: string, http?: boolean }} HookEventEntry */
/** @type {ReadonlyArray<HookEventEntry>} */
const HOOK_EVENT_CATALOG = Object.freeze([
  { name: 'PreToolUse', matcher: 'tool name (regex), e.g. Bash or Edit|Write', description: 'Before a tool runs. Exit code 2 blocks the call.' },
  { name: 'PostToolUse', matcher: 'tool name (regex)', description: 'After a tool succeeds.' },
  { name: 'PostToolUseFailure', matcher: 'tool name (regex)', description: 'After a tool call fails.' },
  { name: 'PostToolBatch', matcher: null, description: 'After a batch of tool calls Claude Code ran together finishes.' },
  { name: 'PermissionRequest', matcher: 'tool name (regex)', description: 'When Claude Code is about to show a permission prompt.' },
  { name: 'PermissionDenied', matcher: 'tool name (regex)', description: 'After a permission was denied.' },
  { name: 'UserPromptSubmit', matcher: null, description: 'When the operator submits a prompt, before Claude reads it.' },
  { name: 'UserPromptExpansion', matcher: 'expansion source (regex)', description: 'While a submitted prompt is expanded, before Claude reads the result.' },
  { name: 'Notification', matcher: 'notification type: permission_prompt, idle_prompt, auth_success, elicitation_dialog', description: 'When Claude Code raises a notification.' },
  { name: 'MessageDisplay', matcher: null, description: 'When a message is about to be shown in the transcript.' },
  { name: 'Stop', matcher: null, description: 'When the main agent finishes a turn.' },
  { name: 'StopFailure', matcher: 'error type (regex)', description: 'When a turn ends with an API error.' },
  { name: 'SubagentStart', matcher: 'agent type (regex)', description: 'When a subagent starts.' },
  { name: 'SubagentStop', matcher: 'agent type (regex)', description: 'When a subagent finishes.' },
  { name: 'Setup', matcher: 'init, maintenance or resume', description: 'When Claude Code runs its first-time setup for a project.', http: false },
  { name: 'SessionStart', matcher: 'startup, resume, clear or compact', description: 'When a session starts or resumes.', http: false },
  { name: 'SessionEnd', matcher: 'reason: clear, logout, prompt_input_exit, other', description: 'When a session ends.' },
  { name: 'PreCompact', matcher: 'manual or auto', description: 'Before context is compacted.' },
  { name: 'PostCompact', matcher: 'manual or auto', description: 'After context is compacted.' },
  { name: 'TaskCreated', matcher: null, description: 'When a background task is created.' },
  { name: 'TaskCompleted', matcher: null, description: 'When a background task completes.' },
  { name: 'TeammateIdle', matcher: null, description: 'When an agent-team teammate goes idle.' },
  { name: 'WorktreeCreate', matcher: null, description: 'When Claude Code creates a worktree.' },
  { name: 'WorktreeRemove', matcher: null, description: 'When Claude Code removes a worktree.' },
  { name: 'ConfigChange', matcher: 'config source (regex)', description: 'When a settings file changes during a session.' },
  { name: 'FileChanged', matcher: 'file name, matched literally (regex is not applied)', description: 'When a watched file changes.' },
  { name: 'CwdChanged', matcher: null, description: 'When the working directory changes.' },
  { name: 'DirectoryAdded', matcher: 'directory path (regex)', description: 'When a directory is added to the session workspace.' },
  { name: 'InstructionsLoaded', matcher: 'load reason (regex)', description: 'When a CLAUDE.md or rules file is loaded.' },
  { name: 'PreModelSwitch', matcher: 'model name (regex)', description: 'Before the session switches to another model.' },
  { name: 'PostModelSwitch', matcher: 'model name (regex)', description: 'After the session switched to another model.' },
  { name: 'Elicitation', matcher: 'MCP server name (regex)', description: 'When an MCP server asks the operator a question.' },
  { name: 'ElicitationResult', matcher: 'MCP server name (regex)', description: 'After the operator answers an MCP elicitation.' },
]);

const EVENTS_BY_NAME = new Map(HOOK_EVENT_CATALOG.map((entry) => [entry.name, entry]));

/**
 * @typedef {object} UserHook
 * @property {string} id
 * @property {string} name
 * @property {string} event
 * @property {string} [matcher]
 * @property {'command'|'http'} type
 * @property {string} [command]
 * @property {string} [url]
 * @property {number} [timeout]
 * @property {boolean} enabled
 * @property {string[]} [projects]
 */

/** @param {string} error @returns {{ ok: false, error: string }} */
function fail(error) {
  return { ok: false, error };
}

function trimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// The three optional fields are read STRICTLY: a coerced one is worse than a refused one, because
// `enabled: "false"` reads as on, a non-string matcher erases the guard's scope and makes a Bash-only
// hook global, and `timeout: true` becomes a one second deadline.
/** @returns {{ ok: true, matcher: string | null } | { ok: false, error: string }} */
function optionalMatcher(input, catalogEntry) {
  const raw = input.matcher;
  if (raw !== undefined && raw !== null && typeof raw !== 'string') return fail('matcher must be a string');
  const matcher = trimmedString(raw);
  if (!matcher) return { ok: true, matcher: null };
  if (matcher.length > MAX_MATCHER_LENGTH) return fail(`matcher is longer than ${MAX_MATCHER_LENGTH} characters`);
  if (!catalogEntry.matcher) return fail(`${catalogEntry.name} takes no matcher`);
  return { ok: true, matcher };
}

/** @returns {{ ok: true, timeout: number | null } | { ok: false, error: string }} */
function optionalTimeout(input) {
  const raw = input.timeout;
  if (raw === undefined || raw === null || raw === '') return { ok: true, timeout: null };
  const timeout = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_SEC) {
    return fail(`timeout must be a whole number of seconds from 1 to ${MAX_TIMEOUT_SEC}`);
  }
  return { ok: true, timeout };
}

/** @returns {{ ok: true, enabled: boolean } | { ok: false, error: string }} */
function optionalEnabled(input) {
  const raw = input.enabled;
  if (raw === undefined) return { ok: true, enabled: true };
  if (typeof raw !== 'boolean') return fail('enabled must be true or false');
  return { ok: true, enabled: raw };
}

/** @returns {{ ok: true, projects: string[] } | { ok: false, error: string }} */
function optionalProjects(input, knownProjectIds) {
  const raw = input.projects;
  if (raw === undefined || raw === null) return { ok: true, projects: [] };
  if (!Array.isArray(raw)) return fail('projects must be a list of project ids');
  /** @type {string[]} */
  const projects = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry) return fail('projects must be a list of project ids');
    if (knownProjectIds && !knownProjectIds.has(entry)) return fail(`Unknown project ${entry}`);
    if (!projects.includes(entry)) projects.push(entry);
  }
  return { ok: true, projects };
}

/**
 * Turn whatever the dashboard sent into a record config.json may hold, or say what is wrong with it.
 * `id` is minted by the caller for a new hook; an existing one keeps its own.
 * @param {Record<string, unknown>} input
 * @param {{ id: string, knownProjectIds?: Set<string> | null }} options
 * @returns {{ ok: true, hook: UserHook } | { ok: false, error: string }}
 */
function normalizeHook(input, { id, knownProjectIds = null }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('hook must be an object');
  if (!ID_RE.test(String(id))) return fail('hook id is invalid');
  const name = trimmedString(input.name);
  if (!name) return fail('name is required');
  if (name.length > MAX_NAME_LENGTH) return fail(`name is longer than ${MAX_NAME_LENGTH} characters`);
  const event = trimmedString(input.event);
  const catalogEntry = EVENTS_BY_NAME.get(event);
  if (!catalogEntry) return fail(event ? `${event} is not a hook event` : 'event is required');
  const type = trimmedString(input.type);
  if (type !== 'command' && type !== 'http') return fail('type must be command or http');
  if (type === 'http' && catalogEntry.http === false) return fail(`${catalogEntry.name} does not support HTTP hooks`);
  const matcher = optionalMatcher(input, catalogEntry);
  if (!matcher.ok) return matcher;
  const timeout = optionalTimeout(input);
  if (!timeout.ok) return timeout;
  const projects = optionalProjects(input, knownProjectIds);
  if (!projects.ok) return projects;
  const enabled = optionalEnabled(input);
  if (!enabled.ok) return enabled;

  /** @type {UserHook} */
  const hook = { id, name, event, type, enabled: enabled.enabled };
  if (matcher.matcher) hook.matcher = matcher.matcher;
  if (type === 'command') {
    const command = trimmedString(input.command);
    if (!command) return fail('command is required');
    if (command.length > MAX_COMMAND_LENGTH) return fail(`command is longer than ${MAX_COMMAND_LENGTH} characters`);
    hook.command = command;
  }
  if (type === 'http') {
    const url = trimmedString(input.url);
    if (!HTTP_URL_RE.test(url)) return fail('url must start with http:// or https://');
    if (url.length > MAX_URL_LENGTH) return fail(`url is longer than ${MAX_URL_LENGTH} characters`);
    hook.url = url;
  }
  if (timeout.timeout) hook.timeout = timeout.timeout;
  if (projects.projects.length > 0) hook.projects = projects.projects;
  return { ok: true, hook };
}

// The records config.json holds, defensively: a hand edit that left something unreadable is dropped
// here rather than crashing a spawn or the tab. Each surviving record is re-normalized so the shape
// the rest of the code sees is the one normalizeHook writes.
/** @param {unknown} stored @returns {UserHook[]} */
function readStoredHooks(stored) {
  if (!Array.isArray(stored)) return [];
  const hooks = [];
  const seen = new Set();
  for (const entry of stored) {
    if (!entry || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' ? entry.id : '';
    if (!ID_RE.test(id) || seen.has(id)) continue;
    const normalized = normalizeHook(entry, { id });
    if (!normalized.ok) continue;
    seen.add(id);
    hooks.push(normalized.hook);
  }
  return hooks;
}

// The two list edits run over the RAW stored array, not the normalized read: a record this build
// cannot normalize (an event a newer Claude Code added, a hand edit) must survive an unrelated save or
// delete rather than be erased by the write that rewrites the list.
/**
 * Replace the record with this id, or append when it is new.
 * @template {{ id?: unknown }} T
 * @param {T[]} hooks @param {T} hook @returns {T[]}
 */
function upsertHook(hooks, hook) {
  const index = hooks.findIndex((entry) => entry && entry.id === hook.id);
  if (index === -1) return [...hooks, hook];
  return hooks.map((entry, i) => (i === index ? hook : entry));
}

/**
 * @template {{ id?: unknown }} T
 * @param {T[]} hooks @param {string} id @returns {T[]}
 */
function removeHook(hooks, id) {
  return hooks.filter((entry) => !entry || entry.id !== id);
}

/** The raw records config.json holds, untouched, as the two list edits above want them. @param {unknown} stored */
function rawStoredHooks(stored) {
  return Array.isArray(stored) ? stored : [];
}

// The hooks one spawn should carry: enabled, and either global or naming this project.
/** @param {unknown} stored @param {string | null} projectId @returns {UserHook[]} */
function hooksForProject(stored, projectId) {
  return readStoredHooks(stored).filter((hook) => {
    if (!hook.enabled) return false;
    if (!hook.projects || hook.projects.length === 0) return true;
    return projectId !== null && hook.projects.includes(projectId);
  });
}

// A record with no timeout of its own gets NO timeout key, so Claude Code applies its own default. The
// 5s Glissa uses for its own status callbacks is a promise about an instant 200, not about an operator
// shell command, and stamping it here killed every blank-timeout hook at five seconds.
/** One Claude Code handler object. @param {UserHook} hook */
function toClaudeHandler(hook) {
  /** @type {{ type: string, url?: string, command?: string, timeout?: number }} */
  const handler = hook.type === 'http'
    ? { type: 'http', url: hook.url }
    : { type: 'command', command: hook.command };
  if (hook.timeout) handler.timeout = hook.timeout;
  return handler;
}

/**
 * Append operator hooks to a settings `hooks` block IN PLACE, after whatever Glissa already put there,
 * so Glissa's own status callbacks keep firing first and an operator hook can never displace one.
 * @param {Record<string, Array<{ matcher?: string, hooks: unknown[] }>>} hooksBlock
 * @param {UserHook[]} userHooks
 */
function appendUserHooks(hooksBlock, userHooks) {
  for (const hook of userHooks) {
    const entry = { hooks: [toClaudeHandler(hook)] };
    if (hook.matcher) entry.matcher = hook.matcher;
    const existing = Array.isArray(hooksBlock[hook.event]) ? hooksBlock[hook.event] : [];
    hooksBlock[hook.event] = [...existing, entry];
  }
  return hooksBlock;
}

module.exports = {
  HOOK_EVENT_CATALOG,
  ID_RE,
  MAX_TIMEOUT_SEC,
  normalizeHook,
  readStoredHooks,
  rawStoredHooks,
  upsertHook,
  removeHook,
  hooksForProject,
  appendUserHooks,
};
