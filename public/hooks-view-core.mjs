// ── Hooks view: pure formatting, ordering and draft rules ─────
// Every string the Hooks panel renders and every rule the editor applies before a save is built here,
// so the panel is DOM only and the wording is testable without a browser. The event catalog arrives
// in the report (the server is its one home); nothing here hard-codes an event name.

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
// Below this many hooks a filter box is noise; above it the list needs one.
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
export const DEFAULT_TIMEOUT_TEXT = "Blank uses Claude Code's default (60 seconds).";
// The ceiling the server enforces, used only until a report states its own.
export const DEFAULT_MAX_TIMEOUT_SEC = 600;

export const HOOK_TYPE_OPTIONS = Object.freeze([
  { value: 'command', label: 'Command', hint: 'Run a shell command. It receives the event JSON on stdin.' },
  { value: 'http', label: 'HTTP', hint: 'POST the event JSON to a URL.' },
]);

// Recipes an operator reaches for first. Each is a draft the editor opens pre-filled, so a template is
// exactly as editable as a blank form; nothing is saved until the operator says so.
export const HOOK_TEMPLATES = Object.freeze([
  { id: 'lint', label: 'Lint after edits', summary: 'PostToolUse on Edit|Write', draft: { name: 'Lint after edits', event: 'PostToolUse', matcher: 'Edit|Write', type: 'command', command: 'npx biome check --write "$(jq -r .tool_input.file_path)"' } },
  { id: 'notify', label: 'Notify on Stop', summary: 'Stop, command', draft: { name: 'Notify on Stop', event: 'Stop', matcher: '', type: 'command', command: 'notify-send "Claude finished a turn"' } },
  { id: 'guard', label: 'Guard destructive Bash', summary: 'PreToolUse on Bash, exit 2 blocks', draft: { name: 'Guard destructive Bash', event: 'PreToolUse', matcher: 'Bash', type: 'command', command: 'jq -r .tool_input.command | grep -Eq "rm -rf|git push --force" && exit 2 || exit 0' } },
  { id: 'log', label: 'Log every prompt', summary: 'UserPromptSubmit, appends JSON', draft: { name: 'Log every prompt', event: 'UserPromptSubmit', matcher: '', type: 'command', command: 'cat >> ~/.claude/prompts.jsonl' } },
]);

const EMPTY_REPORT = Object.freeze({ hooks: [], builtin: [], events: [] });

export function isHooksUnavailable(report) {
  return !report || typeof report.error === 'string';
}

export function hooksErrorLine(report) {
  if (!report || typeof report.error !== 'string') return '';
  return report.error;
}

function listOf(report, key) {
  return Array.isArray(report?.[key]) ? report[key] : EMPTY_REPORT[key];
}

export const hooksOf = (report) => listOf(report, 'hooks');
export const builtinOf = (report) => listOf(report, 'builtin');
export const eventsOf = (report) => listOf(report, 'events');

// The limits the server states about itself; the fallback only covers a report from an older backend.
export function maxTimeoutOf(report) {
  const value = report?.limits?.maxTimeoutSec;
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_TIMEOUT_SEC;
}

// A report that arrived out of order (an older request answered after a newer one) is dropped.
export function shouldApplyHooksReport(msg, latestRequestId) {
  if (!msg || typeof msg !== 'object') return false;
  if (typeof msg.requestId !== 'string' || !latestRequestId) return true;
  return msg.requestId === latestRequestId;
}

export function totalsChips(report) {
  const hooks = hooksOf(report);
  const enabled = hooks.filter((hook) => hook.enabled !== false).length;
  return [
    { label: 'yours', value: String(hooks.length), tone: null },
    { label: 'enabled', value: String(enabled), tone: hooks.length > 0 && enabled === 0 ? 'warn' : null },
    { label: 'built in', value: String(builtinOf(report).length), tone: null },
  ];
}

// Event order is the catalog's (lifecycle order), then name, so the list reads like a session.
export function sortHooks(hooks, events) {
  const rank = new Map(events.map((entry, index) => [entry.name, index]));
  const rankOf = (hook) => (rank.has(hook.event) ? rank.get(hook.event) : events.length);
  return [...hooks].sort((a, b) => {
    const byEvent = rankOf(a) - rankOf(b);
    if (byEvent !== 0) return byEvent;
    return String(a.name).localeCompare(String(b.name));
  });
}

// A plain substring filter across what a row shows, so what the operator can see is what they can find.
export function filterHooks(hooks, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return hooks;
  return hooks.filter((hook) => [hook.name, hook.event, hook.matcher, hook.command, hook.url]
    .some((field) => typeof field === 'string' && field.toLowerCase().includes(needle)));
}

export function showsFilter(hooks) {
  return hooks.length >= FILTER_MIN_COUNT;
}

// Already-sorted hooks bucketed by event, in the order they arrive, so a long list reads as a session.
export function groupHooksByEvent(sortedHooks) {
  const groups = [];
  for (const hook of sortedHooks) {
    const last = groups[groups.length - 1];
    if (last && last.event === hook.event) { last.hooks.push(hook); continue; }
    groups.push({ event: hook.event, hooks: [hook] });
  }
  return groups;
}

// The Claude Code settings entry a record becomes: the same shape session/core/user-hooks-core.js
// writes, shown so an operator can compare it with a hand-written hook or paste it elsewhere.
export function settingsEntryPreview(hook) {
  /** @type {{ type: string, url?: string, command?: string, timeout?: number }} */
  const handler = hook.type === 'http'
    ? { type: 'http', url: hook.url || '' }
    : { type: 'command', command: hook.command || '' };
  // No timeout key when the record has none, exactly as the injector writes it: Claude Code's own
  // default applies, and the preview must not promise a number nothing writes.
  if (Number.isInteger(hook.timeout) && hook.timeout > 0) handler.timeout = hook.timeout;
  const entry = hook.matcher ? { matcher: hook.matcher, hooks: [handler] } : { hooks: [handler] };
  return JSON.stringify({ hooks: { [hook.event]: [entry] } }, null, 2);
}

export function duplicateName(name) {
  return `${name} copy`;
}

function eventEntry(events, name) {
  return events.find((entry) => entry.name === name) || null;
}

export function matcherHint(events, name) {
  const entry = eventEntry(events, name);
  if (!entry) return '';
  if (!entry.matcher) return NO_MATCHER_TEXT;
  return `Matches ${entry.matcher}. Blank matches every ${entry.name}.`;
}

export function targetLine(hook) {
  if (hook.type === 'http') return hook.url || '';
  return hook.command || '';
}

export function typeLabel(type) {
  const option = HOOK_TYPE_OPTIONS.find((entry) => entry.value === type);
  return option ? option.label : String(type || '');
}

export function timeoutLabel(hook) {
  if (!Number.isInteger(hook.timeout) || hook.timeout <= 0) return '';
  return `${hook.timeout}s timeout`;
}

export function scopeLabel(hook, projects) {
  const ids = Array.isArray(hook.projects) ? hook.projects : [];
  if (ids.length === 0) return ALL_PROJECTS_LABEL;
  const names = ids.map((id) => {
    const project = projects.find((entry) => entry.id === id);
    return project ? project.name : id;
  });
  return names.join(', ');
}

export function eventChipText(hook) {
  if (!hook.matcher) return hook.event;
  return `${hook.event} / ${hook.matcher}`;
}

export function builtinLine(row) {
  if (!row.matcher) return row.event;
  return `${row.event} / ${row.matcher}`;
}

// A hook that is wired to a project no longer in config still shows, so it can be repointed or removed.
export function missingProjectIds(hook, projects) {
  const ids = Array.isArray(hook.projects) ? hook.projects : [];
  const known = new Set(projects.map((project) => project.id));
  return ids.filter((id) => !known.has(id));
}

// ── Drafts ──
// The editor works on a flat draft of strings; toDraft/fromDraft are the only two conversions.

/**
 * @typedef {object} HookDraft
 * @property {string|null} id
 * @property {string} name
 * @property {string} event
 * @property {string} matcher
 * @property {string} type
 * @property {string} command
 * @property {string} url
 * @property {string} timeout
 * @property {boolean} enabled
 * @property {string[]} projects
 */

/** @returns {HookDraft} */
export function emptyDraft(events) {
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

/** @returns {HookDraft} */
export function toDraft(hook) {
  return {
    id: hook.id,
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

// What the client can tell BEFORE asking the server; the server re-checks everything, so a rule that
// only it can judge (an unknown project, a duplicate id) is not repeated here.
export function draftProblem(draft, events, maxTimeoutSec = DEFAULT_MAX_TIMEOUT_SEC) {
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

// The wire shape of a save. Blank optionals are omitted rather than sent empty.
export function fromDraft(draft) {
  const hook = {
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

export function templateDraft(template, events) {
  const draft = { ...emptyDraft(events), ...template.draft };
  if (!eventEntry(events, draft.event)) draft.event = emptyDraft(events).event;
  return draft;
}

export function isDraftDirty(draft, original) {
  return JSON.stringify(fromDraft(draft)) !== JSON.stringify(original);
}

export function toggledHook(hook) {
  return { ...hook, enabled: hook.enabled === false };
}

export function deleteConfirmText(hook) {
  return `Delete the hook "${hook.name}"? Sessions already running keep it until they restart.`;
}
