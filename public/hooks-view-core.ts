export const HOOKS_HINT = 'Claude Code hooks injected into every session Glissa spawns.';
export const HOOKS_LOADING_TEXT = 'Loading hooks';
export const HOOKS_EMPTY_TEXT = 'No hooks yet. A hook runs a command, or calls a URL, when a Claude Code event fires in a Glissa session. Start from one of these, or add your own.';
export const TEMPLATES_LABEL = 'Start from';
export const FILTER_PLACEHOLDER = 'Filter by name, event or command';
export const FILTER_EMPTY_TEXT = 'Nothing matches that filter.';
export const PREVIEW_LABEL = 'Preview';
export const PREVIEW_HINT = 'The entry this becomes in the per-session settings file.';
export const DUPLICATE_LABEL = 'Duplicate';
export const DISCARD_TITLE = 'Discard changes';
export const DISCARD_TEXT = 'Close the editor and lose the unsaved changes?';
export const SHORTCUT_HINT = 'Esc cancels. Ctrl+Enter saves.';

export const FILTER_MIN_COUNT = 4;
export const HOOKS_APPLY_NOTE = 'A change reaches a session at its next start or restart. Claude Code sessions only; Codex and Grok sessions do not read this file.';
export const BUILTIN_TITLE = "Glissa's own hooks";
export const BUILTIN_HINT = 'Always present, read-only. Status detection depends on them.';
export const YOUR_HOOKS_TITLE = 'Your hooks';
export const NEW_HOOK_TITLE = 'New hook';
export const EDIT_HOOK_TITLE = 'Edit hook';
export const EDITOR_HINT = 'Saved to config.json.';
export const ALL_PROJECTS_LABEL = 'All projects';
export const NO_MATCHER_TEXT = 'This event takes no matcher.';
export const DEFAULT_TIMEOUT_TEXT = "Blank uses Claude Code's default for the event.";

export const DEFAULT_MAX_TIMEOUT_SEC = 600;

export interface HookRecord {
  id: string;
  name: string;
  event: string;
  matcher?: string;
  type: string;
  command?: string;
  url?: string;
  timeout?: number;
  enabled?: boolean;
  projects?: string[];
}

export interface HookEvent {
  name: string;
  description: string;

  matcher?: string | null;
  http?: boolean;
}

export interface HookBuiltinRow {
  event: string;
  purpose: string;
  matcher?: string | null;
}

export interface HookProject {
  id: string;
  name: string;
  agent?: string;
}

export interface HooksReport {
  hooks?: HookRecord[];
  builtin?: HookBuiltinRow[];
  events?: HookEvent[];
  projects?: HookProject[];
  limits?: { maxTimeoutSec?: unknown } | null;
  error?: unknown;
  requestId?: unknown;
}

export interface HookDraft {
  id: string | null;
  name: string;
  event: string;
  matcher: string;
  type: string;
  command: string;
  url: string;
  timeout: string;
  enabled: boolean;
  projects: string[];
}

export interface HookTemplate {
  id: string;
  label: string;
  summary: string;
  draft: Partial<HookDraft>;
}

export const HOOK_TYPE_OPTIONS = Object.freeze([
  { value: 'command', label: 'Command', hint: 'Run a shell command. It receives the event JSON on stdin.' },
  { value: 'http', label: 'HTTP', hint: 'POST the event JSON to a URL.' },
]);

export const HOOK_TEMPLATES: readonly HookTemplate[] = Object.freeze([
  { id: 'lint', label: 'Lint after edits', summary: 'PostToolUse on Edit|Write', draft: { name: 'Lint after edits', event: 'PostToolUse', matcher: 'Edit|Write', type: 'command', command: 'npx biome check --write "$(jq -r .tool_input.file_path)"' } },
  { id: 'notify', label: 'Notify on Stop', summary: 'Stop, command', draft: { name: 'Notify on Stop', event: 'Stop', matcher: '', type: 'command', command: 'notify-send "Claude finished a turn"' } },
  { id: 'guard', label: 'Guard destructive Bash', summary: 'PreToolUse on Bash, exit 2 blocks', draft: { name: 'Guard destructive Bash', event: 'PreToolUse', matcher: 'Bash', type: 'command', command: 'jq -r .tool_input.command | grep -Eq "rm -rf|git push --force" && exit 2 || exit 0' } },
  { id: 'log', label: 'Log every prompt', summary: 'UserPromptSubmit, appends JSON', draft: { name: 'Log every prompt', event: 'UserPromptSubmit', matcher: '', type: 'command', command: 'cat >> ~/.claude/prompts.jsonl' } },
]);

const EMPTY_REPORT = Object.freeze({ hooks: [], builtin: [], events: [] });

export function isHooksUnavailable(report: HooksReport | null | undefined) {
  return !report || typeof report.error === 'string';
}

export function hooksErrorLine(report: HooksReport | null | undefined) {
  if (!report || typeof report.error !== 'string') return '';
  return report.error;
}

function listOf(report: HooksReport | null | undefined, key: 'hooks' | 'builtin' | 'events'): unknown[] {
  const value = report?.[key];
  return Array.isArray(value) ? value : EMPTY_REPORT[key];
}

export const hooksOf = (report: HooksReport | null | undefined) => listOf(report, 'hooks') as HookRecord[];
export const builtinOf = (report: HooksReport | null | undefined) => listOf(report, 'builtin') as HookBuiltinRow[];
export const eventsOf = (report: HooksReport | null | undefined) => listOf(report, 'events') as HookEvent[];

export function maxTimeoutOf(report: HooksReport | null | undefined) {
  const value = report?.limits?.maxTimeoutSec;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_TIMEOUT_SEC;
}

export function shouldApplyHooksReport(msg: unknown, latestRequestId: unknown) {
  if (!msg || typeof msg !== 'object') return false;
  const requestId = (msg as { requestId?: unknown }).requestId;
  if (typeof requestId !== 'string' || !latestRequestId) return true;
  return requestId === latestRequestId;
}

export function totalsChips(report: HooksReport | null | undefined): { label: string; value: string; tone: string | null }[] {
  const hooks = hooksOf(report);
  const enabled = hooks.filter((hook) => hook.enabled !== false).length;
  return [
    { label: 'yours', value: String(hooks.length), tone: null },
    { label: 'enabled', value: String(enabled), tone: hooks.length > 0 && enabled === 0 ? 'warn' : null },
    { label: 'built in', value: String(builtinOf(report).length), tone: null },
  ];
}

export function sortHooks(hooks: HookRecord[], events: HookEvent[]): HookRecord[] {
  const rank = new Map(events.map((entry, index): [string, number] => [entry.name, index]));
  const rankOf = (hook: HookRecord) => rank.get(hook.event) ?? events.length;
  return [...hooks].sort((a, b) => {
    const byEvent = rankOf(a) - rankOf(b);
    if (byEvent !== 0) return byEvent;
    return String(a.name).localeCompare(String(b.name));
  });
}

export function filterHooks(hooks: HookRecord[], query: unknown): HookRecord[] {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return hooks;
  return hooks.filter((hook) => [hook.name, hook.event, hook.matcher, hook.command, hook.url]
    .some((field) => typeof field === 'string' && field.toLowerCase().includes(needle)));
}

export function showsFilter(hooks: readonly unknown[]) {
  return hooks.length >= FILTER_MIN_COUNT;
}

export function groupHooksByEvent(sortedHooks: HookRecord[]) {
  const groups: { event: string; hooks: HookRecord[] }[] = [];
  for (const hook of sortedHooks) {
    const last = groups[groups.length - 1];
    if (last && last.event === hook.event) { last.hooks.push(hook); continue; }
    groups.push({ event: hook.event, hooks: [hook] });
  }
  return groups;
}

export function settingsEntryPreview(hook: HookRecord) {
  const handler: { type: string; url?: string; command?: string; timeout?: number } = hook.type === 'http'
    ? { type: 'http', url: hook.url || '' }
    : { type: 'command', command: hook.command || '' };

  if (Number.isInteger(hook.timeout) && Number(hook.timeout) > 0) handler.timeout = hook.timeout;
  const entry = hook.matcher ? { matcher: hook.matcher, hooks: [handler] } : { hooks: [handler] };
  return JSON.stringify({ hooks: { [hook.event]: [entry] } }, null, 2);
}

export function duplicateName(name: string) {
  return `${name} copy`;
}

function eventEntry(events: HookEvent[], name: string): HookEvent | null {
  return events.find((entry) => entry.name === name) || null;
}

export function matcherHint(events: HookEvent[], name: string) {
  const entry = eventEntry(events, name);
  if (!entry) return '';
  if (!entry.matcher) return NO_MATCHER_TEXT;
  return `Matches ${entry.matcher}. Blank matches every ${entry.name}.`;
}

export function targetLine(hook: HookRecord) {
  if (hook.type === 'http') return hook.url || '';
  return hook.command || '';
}

export function typeLabel(type: unknown) {
  const option = HOOK_TYPE_OPTIONS.find((entry) => entry.value === type);
  return option ? option.label : String(type || '');
}

export function timeoutLabel(hook: HookRecord) {
  if (!Number.isInteger(hook.timeout) || Number(hook.timeout) <= 0) return '';
  return `${hook.timeout}s timeout`;
}

export function scopeLabel(hook: HookRecord, projects: HookProject[]) {
  const ids: string[] = Array.isArray(hook.projects) ? hook.projects : [];
  if (ids.length === 0) return ALL_PROJECTS_LABEL;
  const names = ids.map((id) => {
    const project = projects.find((entry) => entry.id === id);
    return project ? project.name : id;
  });
  return names.join(', ');
}

export function eventChipText(hook: HookRecord) {
  if (!hook.matcher) return hook.event;
  return `${hook.event} / ${hook.matcher}`;
}

export function builtinLine(row: HookBuiltinRow) {
  if (!row.matcher) return row.event;
  return `${row.event} / ${row.matcher}`;
}

export function missingProjectIds(hook: HookRecord, projects: HookProject[]) {
  const ids: string[] = Array.isArray(hook.projects) ? hook.projects : [];
  const known = new Set(projects.map((project) => project.id));
  return ids.filter((id) => !known.has(id));
}

export function emptyDraft(events: HookEvent[]): HookDraft {
  const first = events[0];
  return {
    id: null,
    name: '',
    event: first ? first.name : '',
    matcher: '',
    type: 'command',
    command: '',
    url: '',
    timeout: '',
    enabled: true,
    projects: [],
  };
}

export function toDraft(hook: HookRecord): HookDraft {
  return {
    id: hook.id ?? null,
    name: hook.name || '',
    event: hook.event || '',
    matcher: hook.matcher || '',
    type: hook.type === 'http' ? 'http' : 'command',
    command: hook.command || '',
    url: hook.url || '',
    timeout: Number.isInteger(hook.timeout) ? String(hook.timeout) : '',
    enabled: hook.enabled !== false,
    projects: Array.isArray(hook.projects) ? [...hook.projects] : [],
  };
}

export function draftProblem(draft: HookDraft, events: HookEvent[], maxTimeoutSec: number = DEFAULT_MAX_TIMEOUT_SEC) {
  if (!draft.name.trim()) return 'Give the hook a name.';
  const entry = eventEntry(events, draft.event);
  if (!entry) return 'Pick an event.';
  if (draft.matcher.trim() && !entry.matcher) return `${entry.name} takes no matcher.`;
  if (draft.type === 'http' && entry.http === false) return `${entry.name} does not support HTTP hooks.`;
  if (draft.type === 'command' && !draft.command.trim()) return 'Enter the command to run.';
  if (draft.type === 'http' && !/^https?:\/\/\S+$/i.test(draft.url.trim())) return 'Enter a URL starting with http:// or https://.';
  if (draft.timeout.trim() !== '') {
    const timeout = Number(draft.timeout);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > maxTimeoutSec) return `Timeout must be a whole number of seconds from 1 to ${maxTimeoutSec}.`;
  }
  return null;
}

export function fromDraft(draft: HookDraft): Record<string, unknown> {
  const hook: Record<string, unknown> = {
    name: draft.name.trim(),
    event: draft.event,
    type: draft.type,
    enabled: draft.enabled !== false,
  };
  if (draft.id) hook.id = draft.id;
  if (draft.matcher.trim()) hook.matcher = draft.matcher.trim();
  if (draft.type === 'command') hook.command = draft.command.trim();
  if (draft.type === 'http') hook.url = draft.url.trim();
  if (draft.timeout.trim() !== '') hook.timeout = Number(draft.timeout);
  if (draft.projects.length > 0) hook.projects = [...draft.projects];
  return hook;
}

export function templateDraft(template: HookTemplate, events: HookEvent[]): HookDraft {
  const draft = { ...emptyDraft(events), ...template.draft };
  if (!eventEntry(events, draft.event)) draft.event = emptyDraft(events).event;
  return draft;
}

export function isDraftDirty(draft: HookDraft, original: unknown) {
  return JSON.stringify(fromDraft(draft)) !== JSON.stringify(original);
}

export function toggledHook(hook: HookRecord): HookRecord {
  return { ...hook, enabled: hook.enabled === false };
}

export function deleteConfirmText(hook: HookRecord) {
  return `Delete the hook "${hook.name}"? Sessions already running keep it until they restart.`;
}
