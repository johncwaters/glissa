const MAX_NAME_LENGTH = 64;
const MAX_MATCHER_LENGTH = 200;
const MAX_COMMAND_LENGTH = 4000;
const MAX_URL_LENGTH = 2000;
const MAX_TIMEOUT_SEC = 600;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HTTP_URL_RE = /^https?:\/\/\S+$/i;

interface HookEventEntry {
  name: string;
  matcher: string | null;
  description: string;
  http?: boolean;
}

const HOOK_EVENT_CATALOG: readonly HookEventEntry[] = Object.freeze([
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

interface UserHook {
  id: string;
  name: string;
  event: string;
  matcher?: string;
  type: 'command' | 'http';
  command?: string;
  url?: string;
  timeout?: number;
  enabled: boolean;
  projects?: string[];
}

interface HookInput {
  name?: unknown;
  event?: unknown;
  type?: unknown;
  matcher?: unknown;
  command?: unknown;
  url?: unknown;
  timeout?: unknown;
  enabled?: unknown;
  projects?: unknown;
}

interface Failure {
  ok: false;
  error: string;
}

interface ClaudeHookHandler {
  type: string;
  url?: string;
  command?: string;
  timeout?: number;
}

interface HooksBlockEntry {
  matcher?: string;
  hooks: ClaudeHookHandler[];
}

type HooksBlock = Record<string, HooksBlockEntry[]>;

interface StoredHookRecord {
  id?: unknown;
}

function fail(error: string): Failure {
  return { ok: false, error };
}

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalMatcher(
  input: HookInput,
  catalogEntry: HookEventEntry,
): { ok: true; matcher: string | null } | Failure {
  const raw = input.matcher;
  if (raw !== undefined && raw !== null && typeof raw !== 'string') return fail('matcher must be a string');
  const matcher = trimmedString(raw);
  if (!matcher) return { ok: true, matcher: null };
  if (matcher.length > MAX_MATCHER_LENGTH) return fail(`matcher is longer than ${MAX_MATCHER_LENGTH} characters`);
  if (!catalogEntry.matcher) return fail(`${catalogEntry.name} takes no matcher`);
  return { ok: true, matcher };
}

function optionalTimeout(input: HookInput): { ok: true; timeout: number | null } | Failure {
  const raw = input.timeout;
  if (raw === undefined || raw === null || raw === '') return { ok: true, timeout: null };
  const timeout = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_SEC) {
    return fail(`timeout must be a whole number of seconds from 1 to ${MAX_TIMEOUT_SEC}`);
  }
  return { ok: true, timeout };
}

function optionalEnabled(input: HookInput): { ok: true; enabled: boolean } | Failure {
  const raw = input.enabled;
  if (raw === undefined) return { ok: true, enabled: true };
  if (typeof raw !== 'boolean') return fail('enabled must be true or false');
  return { ok: true, enabled: raw };
}

function optionalProjects(
  input: HookInput,
  knownProjectIds: ReadonlySet<string> | null,
): { ok: true; projects: string[] } | Failure {
  const raw = input.projects;
  if (raw === undefined || raw === null) return { ok: true, projects: [] };
  if (!Array.isArray(raw)) return fail('projects must be a list of project ids');
  const projects: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry) return fail('projects must be a list of project ids');
    if (knownProjectIds && !knownProjectIds.has(entry)) return fail(`Unknown project ${entry}`);
    if (!projects.includes(entry)) projects.push(entry);
  }
  return { ok: true, projects };
}

function normalizeHook(
  input: HookInput | null | undefined,
  { id, knownProjectIds = null }: { id: string; knownProjectIds?: ReadonlySet<string> | null },
): { ok: true; hook: UserHook } | Failure {
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

  const hook: UserHook = { id, name, event, type, enabled: enabled.enabled };
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

function readStoredHooks(stored: unknown): UserHook[] {
  if (!Array.isArray(stored)) return [];
  const hooks: UserHook[] = [];
  const seen = new Set<string>();
  for (const raw of stored) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as HookInput & { id?: unknown };
    const id = typeof entry.id === 'string' ? entry.id : '';
    if (!ID_RE.test(id) || seen.has(id)) continue;
    const normalized = normalizeHook(entry, { id });
    if (!normalized.ok) continue;
    seen.add(id);
    hooks.push(normalized.hook);
  }
  return hooks;
}

function upsertHook<T extends { id?: unknown }, U extends { id?: unknown }>(
  hooks: readonly T[],
  hook: U,
): (T | U)[] {
  const index = hooks.findIndex((entry) => entry && entry.id === hook.id);
  if (index === -1) return [...hooks, hook];
  return hooks.map((entry, i) => (i === index ? hook : entry));
}

function removeHook<T extends { id?: unknown }>(hooks: readonly T[], id: string): T[] {
  return hooks.filter((entry) => !entry || entry.id !== id);
}

function rawStoredHooks(stored: unknown): StoredHookRecord[] {
  return Array.isArray(stored) ? stored : [];
}

function hooksForProject(stored: unknown, projectId: string | null): UserHook[] {
  return readStoredHooks(stored).filter((hook) => {
    if (!hook.enabled) return false;
    if (!hook.projects || hook.projects.length === 0) return true;
    return projectId !== null && hook.projects.includes(projectId);
  });
}

function toClaudeHandler(hook: UserHook): ClaudeHookHandler {
  const handler: ClaudeHookHandler = hook.type === 'http'
    ? { type: 'http', url: hook.url }
    : { type: 'command', command: hook.command };
  if (hook.timeout) handler.timeout = hook.timeout;
  return handler;
}

function appendUserHooks(hooksBlock: HooksBlock, userHooks: readonly UserHook[]): HooksBlock {
  for (const hook of userHooks) {
    const entry: HooksBlockEntry = { hooks: [toClaudeHandler(hook)] };
    if (hook.matcher) entry.matcher = hook.matcher;
    const existing = Array.isArray(hooksBlock[hook.event]) ? hooksBlock[hook.event] : [];
    hooksBlock[hook.event] = [...existing, entry];
  }
  return hooksBlock;
}

export {
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
export type {
  ClaudeHookHandler,
  HookEventEntry,
  HookInput,
  HooksBlock,
  HooksBlockEntry,
  StoredHookRecord,
  UserHook,
};
