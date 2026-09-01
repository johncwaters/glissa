import { buildPanelSection, buildStatChip, el, isPanelHidden, projectsOf } from './dom-helpers.ts';
import { openConfirmDialog } from './session-card/modal.ts';
import { showErrorToast } from './session-card/toast.ts';
import {
  ALL_PROJECTS_LABEL,
  BUILTIN_HINT,
  BUILTIN_TITLE,
  DEFAULT_TIMEOUT_TEXT,
  DISCARD_TEXT,
  DISCARD_TITLE,
  DUPLICATE_LABEL,
  EDITOR_HINT,
  EDIT_HOOK_TITLE,
  FILTER_EMPTY_TEXT,
  FILTER_PLACEHOLDER,
  HOOKS_APPLY_NOTE,
  HOOKS_EMPTY_TEXT,
  HOOKS_HINT,
  HOOKS_LOADING_TEXT,
  HOOK_TEMPLATES,
  HOOK_TYPE_OPTIONS,
  NEW_HOOK_TITLE,
  PREVIEW_HINT,
  PREVIEW_LABEL,
  SHORTCUT_HINT,
  TEMPLATES_LABEL,
  YOUR_HOOKS_TITLE,
  builtinLine,
  builtinOf,
  deleteConfirmText,
  draftProblem,
  duplicateName,
  emptyDraft,
  eventChipText,
  eventsOf,
  filterHooks,
  fromDraft,
  groupHooksByEvent,
  hooksErrorLine,
  hooksOf,
  isDraftDirty,
  isHooksUnavailable,
  matcherHint,
  maxTimeoutOf,
  missingProjectIds,
  scopeLabel,
  settingsEntryPreview,
  shouldApplyHooksReport,
  showsFilter,
  sortHooks,
  targetLine,
  templateDraft,
  timeoutLabel,
  toDraft,
  toggledHook,
  totalsChips,
  typeLabel,
} from './hooks-view-core.ts';
import type { HookBuiltinRow, HookDraft, HookEvent, HookProject, HookRecord, HooksReport } from './hooks-view-core.ts';

let _report: HooksReport | null = null;
let _root: HTMLDivElement | null = null;
let _sendRequest: ((message: Record<string, unknown>) => void) | null = null;
let _requestSeq = 0;
let _latestRequestId: string | null = null;
let _draft: HookDraft | null = null;

let _draftOrigin: Record<string, unknown> | null = null;
let _editorEl: HTMLElement | null = null;
let _editorErrorEl: HTMLElement | null = null;
let _saving = false;

let _editorRequestId: string | null = null;
let _filter = '';

const _openPreviews = new Set<string>();

const _busyIds = new Set<string>();

let _focusAddOnRender = false;

const buildSection = (title: string | null | undefined, hint?: string | null) => buildPanelSection('hooks', title, hint);

function buildLine(className: string, text: string | null | undefined, tone?: string | null) {
  const line = el('p', className, text);
  if (tone) line.dataset.tone = tone;
  return line;
}

function buildButton(className: string, label: string, onClick: () => void, ariaLabel?: string) {
  const button = el('button', className, label);
  button.type = 'button';
  if (ariaLabel) button.setAttribute('aria-label', ariaLabel);
  button.addEventListener('click', onClick);
  return button;
}

function send(message: Record<string, unknown>): string | null {
  if (!_sendRequest) return null;
  _requestSeq += 1;
  const requestId = `hooks-${_requestSeq}`;
  _sendRequest({ requestId, ...message });
  return requestId;
}

function buildField(label: string, control: HTMLElement, hint: string | null) {
  const field = el('label', 'hooks-field');
  field.append(el('span', 'hooks-field-label', label), control);
  if (hint) field.append(el('span', 'hooks-field-hint', hint));
  return field;
}

function buildInput(value: string, placeholder: string, onInput: (value: string) => void) {
  const input = el('input', 'settings-view-input');
  input.type = 'text';
  input.value = value;
  input.autocomplete = 'off';
  input.spellcheck = false;
  if (placeholder) input.placeholder = placeholder;
  input.addEventListener('input', () => onInput(input.value));
  return input;
}

function buildTextarea(value: string, onInput: (value: string) => void) {
  const area = el('textarea', 'settings-view-input hooks-command');
  area.rows = 3;
  area.value = value;
  area.spellcheck = false;
  area.addEventListener('input', () => onInput(area.value));
  return area;
}

function buildEventSelect(draft: HookDraft, events: HookEvent[], onChange: (value: string) => void) {
  const select = el('select', 'settings-view-input hooks-select');
  for (const entry of events) {
    const option = el('option', null, entry.name);
    option.value = entry.name;
    option.title = entry.description;
    if (entry.name === draft.event) option.selected = true;
    select.append(option);
  }
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

function buildTypeRow(draft: HookDraft, onChange: (value: string) => void) {
  const row = el('div', 'hooks-type-row');
  row.setAttribute('role', 'radiogroup');
  for (const option of HOOK_TYPE_OPTIONS) {
    const label = el('label', 'settings-view-toggle hooks-choice');
    const radio = el('input', 'settings-view-checkbox');
    radio.type = 'radio';
    radio.name = 'hooks-type';
    radio.value = option.value;
    radio.checked = draft.type === option.value;
    radio.title = option.hint;
    radio.addEventListener('change', () => { if (radio.checked) onChange(option.value); });
    label.append(radio, el('span', null, option.label));
    row.append(label);
  }
  return row;
}

function buildProjectPicker(draft: HookDraft, projects: HookProject[]) {
  const wrap = el('div', 'hooks-projects');
  if (projects.length === 0) {
    wrap.append(el('span', 'hooks-field-hint', ALL_PROJECTS_LABEL));
    return wrap;
  }
  const everyLabel = el('label', 'settings-view-project-choice hooks-choice');
  const everyBox = el('input', 'settings-view-checkbox');
  everyBox.type = 'checkbox';
  everyBox.checked = draft.projects.length === 0;
  everyLabel.append(everyBox, el('span', null, ALL_PROJECTS_LABEL));
  wrap.append(everyLabel);
  const boxes: HTMLInputElement[] = [];
  for (const project of projects) {
    const label = el('label', 'settings-view-project-choice hooks-choice');
    const box = el('input', 'settings-view-checkbox');
    box.type = 'checkbox';
    box.value = project.id;
    box.checked = draft.projects.includes(project.id);
    box.addEventListener('change', () => {
      draft.projects = boxes.filter((entry) => entry.checked).map((entry) => entry.value);
      everyBox.checked = draft.projects.length === 0;
    });
    boxes.push(box);
    label.append(box, el('span', null, project.name));
    if (project.agent !== 'claude-code') {
      label.append(el('span', 'hooks-choice-note', project.agent));
      label.title = 'Not a Claude Code project: this hook will not reach its sessions.';
    }
    wrap.append(label);
  }
  everyBox.addEventListener('change', () => {
    if (!everyBox.checked) { everyBox.checked = draft.projects.length === 0; return; }
    for (const box of boxes) box.checked = false;
    draft.projects = [];
  });
  return wrap;
}

function buildTemplateRow(events: HookEvent[]) {
  const row = el('div', 'hooks-templates');
  row.append(el('span', 'hooks-templates-label', TEMPLATES_LABEL));
  for (const template of HOOK_TEMPLATES) {
    const chip = buildButton('hooks-chip', template.label, () => openEditor(null, templateDraft(template, events)));
    chip.title = template.summary;
    row.append(chip);
  }
  return row;
}

function setEditorError(text: string | null) {
  if (!_editorErrorEl) return;
  _editorErrorEl.textContent = text || '';
  _editorErrorEl.hidden = !text;
}

function buildEditor(draft: HookDraft) {
  const events = eventsOf(_report);
  const projects = projectsOf<HookProject>(_report);
  const section = buildSection(draft.id ? EDIT_HOOK_TITLE : NEW_HOOK_TITLE, EDITOR_HINT);
  section.classList.add('hooks-editor');
  const form = el('form', 'hooks-form');
  form.addEventListener('submit', (event) => { event.preventDefault(); submitEditor(); });
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); requestCloseEditor(); return; }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submitEditor(); }
  });
  if (!draft.id) form.append(buildTemplateRow(events));

  const matcherHintEl = el('span', 'hooks-field-hint', matcherHint(events, draft.event));
  const matcherInput = buildInput(draft.matcher, '', (value) => { draft.matcher = value; });
  const commandField = buildField('Command', buildTextarea(draft.command, (value) => { draft.command = value; }), 'Runs through the shell with the event JSON on stdin. Exit 2 blocks the action where the event allows it.');
  const urlField = buildField('URL', buildInput(draft.url, 'http://127.0.0.1:8080/hook', (value) => { draft.url = value; }), 'Claude Code POSTs the event JSON to it.');
  const syncType = () => {
    commandField.hidden = draft.type !== 'command';
    urlField.hidden = draft.type !== 'http';
  };
  syncType();

  const matcherField = buildField('Matcher', matcherInput, null);
  matcherField.append(matcherHintEl);
  const syncMatcher = () => {
    const entry = events.find((candidate) => candidate.name === draft.event);
    matcherHintEl.textContent = matcherHint(events, draft.event);
    matcherInput.disabled = !!entry && !entry.matcher;
    if (matcherInput.disabled) { matcherInput.value = ''; draft.matcher = ''; }
  };
  syncMatcher();

  const timeoutInput = el('input', 'settings-view-input hooks-timeout');
  timeoutInput.type = 'number';
  timeoutInput.inputMode = 'numeric';
  timeoutInput.min = '1';
  timeoutInput.max = String(maxTimeoutOf(_report));
  timeoutInput.value = draft.timeout;
  timeoutInput.addEventListener('input', () => { draft.timeout = timeoutInput.value; });

  const enabledLabel = el('label', 'settings-view-toggle hooks-choice');
  const enabledBox = el('input', 'settings-view-checkbox');
  enabledBox.type = 'checkbox';
  enabledBox.checked = draft.enabled;
  enabledBox.addEventListener('change', () => { draft.enabled = enabledBox.checked; });
  enabledLabel.append(enabledBox, el('span', null, 'Enabled'));

  form.append(
    buildField('Name', buildInput(draft.name, 'Lint after edits', (value) => { draft.name = value; }), null),
    buildField('Event', buildEventSelect(draft, events, (value) => { draft.event = value; syncMatcher(); }), null),
    matcherField,
    buildField('Type', buildTypeRow(draft, (value) => { draft.type = value; syncType(); }), null),
    commandField,
    urlField,
    buildField('Timeout (seconds)', timeoutInput, DEFAULT_TIMEOUT_TEXT),
    buildField('Projects', buildProjectPicker(draft, projects), null),
    buildField('', enabledLabel, null),
  );

  _editorErrorEl = el('p', 'hooks-editor-error');
  _editorErrorEl.setAttribute('role', 'alert');
  _editorErrorEl.hidden = true;
  const footer = el('div', 'hooks-editor-footer');
  const shortcut = el('span', 'hooks-editor-shortcut', SHORTCUT_HINT);
  const cancel = buildButton('btn-dialog btn-dialog-cancel', 'Cancel', requestCloseEditor);
  const save = el('button', 'btn-dialog btn-dialog-confirm', draft.id ? 'Save changes' : 'Add hook');
  save.type = 'submit';
  footer.append(_editorErrorEl, shortcut, cancel, save);
  form.append(footer);
  section.append(form);
  return section;
}

function openEditor(hook: HookRecord | null, draft: HookDraft | null = null) {
  _draft = draft || (hook ? toDraft(hook) : emptyDraft(eventsOf(_report)));

  _draftOrigin = fromDraft(hook ? toDraft(hook) : emptyDraft(eventsOf(_report)));
  _editorEl = buildEditor(_draft);
  render({ force: true });
  _editorEl.scrollIntoView({ block: 'nearest' });
  const first = _editorEl.querySelector('input[type=text]');
  if (first instanceof HTMLInputElement) first.focus();
}

function closeEditor() {
  _draft = null;
  _draftOrigin = null;
  _editorEl = null;
  _editorErrorEl = null;
  _saving = false;
  _editorRequestId = null;
  _focusAddOnRender = true;
  render({ force: true });
}

function requestCloseEditor() {
  if (!_draft || !_draftOrigin || !isDraftDirty(_draft, _draftOrigin)) { closeEditor(); return; }
  openConfirmDialog({ title: DISCARD_TITLE, message: DISCARD_TEXT, confirmLabel: 'Discard', danger: true, onConfirm: closeEditor });
}

function submitEditor() {
  if (!_draft || _saving) return;
  const problem = draftProblem(_draft, eventsOf(_report), maxTimeoutOf(_report));
  if (problem) { setEditorError(problem); return; }
  _saving = true;
  setEditorError('');
  _editorRequestId = send({ type: 'save-hook', hook: fromDraft(_draft) });
  if (!_editorRequestId) _saving = false;
}

function buildPreview(hook: HookRecord) {
  const details = el('details', 'hooks-preview');
  details.open = _openPreviews.has(hook.id);
  details.addEventListener('toggle', () => {
    if (details.open) { _openPreviews.add(hook.id); return; }
    _openPreviews.delete(hook.id);
  });
  const summary = el('summary', 'hooks-preview-summary', PREVIEW_LABEL);
  summary.title = PREVIEW_HINT;
  const code = el('pre', 'hooks-preview-code', settingsEntryPreview(hook));
  details.append(summary, code);
  return details;
}

function buildRow(hook: HookRecord, { grouped = false }: { grouped?: boolean } = {}) {
  const projects = projectsOf<HookProject>(_report);
  const row = el('article', 'hooks-row');
  row.setAttribute('aria-label', hook.name);
  if (hook.enabled === false) row.dataset.state = 'off';
  const main = el('div', 'hooks-row-main');
  const head = el('div', 'hooks-row-head');

  head.append(el('span', 'hooks-row-name', hook.name));
  const chipText = grouped ? (hook.matcher || '') : eventChipText(hook);
  if (chipText) head.append(el('span', 'hooks-row-event', chipText));
  const target = el('code', 'hooks-row-target', targetLine(hook));
  target.title = targetLine(hook);
  const meta = el('p', 'hooks-row-meta', [typeLabel(hook.type), timeoutLabel(hook), scopeLabel(hook, projects)].filter(Boolean).join(' / '));
  main.append(head, target, meta);
  const missing = missingProjectIds(hook, projects);
  if (missing.length > 0) main.append(buildLine('hooks-row-meta', `Scoped to a project no longer in config: ${missing.join(', ')}`, 'warn'));
  main.append(buildPreview(hook));

  const actions = el('div', 'hooks-row-actions');
  const toggleLabel = el('label', 'settings-view-toggle hooks-choice');
  const toggle = el('input', 'settings-view-checkbox');
  toggle.type = 'checkbox';
  toggle.checked = hook.enabled !== false;
  toggle.disabled = _busyIds.has(hook.id);
  toggle.setAttribute('aria-label', `${hook.name} enabled`);
  toggle.addEventListener('change', () => {
    _busyIds.add(hook.id);
    toggle.disabled = true;
    send({ type: 'save-hook', hook: toggledHook(hook) });
  });
  toggleLabel.append(toggle, el('span', null, 'On'));
  const edit = buildButton('hooks-btn', 'Edit', () => openEditor(hook), `Edit ${hook.name}`);
  const duplicate = buildButton('hooks-btn', DUPLICATE_LABEL, () => {
    const copy = toDraft({ ...hook, name: duplicateName(hook.name) });
    copy.id = null;
    openEditor(null, copy);
  }, `Duplicate ${hook.name}`);
  const remove = buildButton('hooks-btn hooks-btn-danger', 'Delete', () => {
    openConfirmDialog({
      title: 'Delete hook',
      message: deleteConfirmText(hook),
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: () => {
        _busyIds.add(hook.id);
        send({ type: 'delete-hook', id: hook.id });
        render({ force: true });
      },
    });
  }, `Delete ${hook.name}`);
  remove.disabled = _busyIds.has(hook.id);
  actions.append(toggleLabel, edit, duplicate, remove);
  row.append(main, actions);
  return row;
}

function buildBuiltinRow(entry: HookBuiltinRow) {
  const row = el('article', 'hooks-row hooks-row-builtin');
  const main = el('div', 'hooks-row-main');
  main.append(el('span', 'hooks-row-event', builtinLine(entry)), el('p', 'hooks-row-meta', entry.purpose));
  row.append(main);
  return row;
}

function buildTotalsSection() {
  const section = buildSection('Hooks', HOOKS_HINT);
  const chips = el('div', 'hooks-stats');
  for (const chip of totalsChips(_report)) chips.append(buildStatChip('hooks', chip.label, chip.value, chip.tone));
  section.append(chips, buildLine('hooks-meta', HOOKS_APPLY_NOTE));
  return section;
}

function buildFilter() {
  const input = el('input', 'settings-view-input hooks-filter');
  input.type = 'search';
  input.value = _filter;
  input.placeholder = FILTER_PLACEHOLDER;
  input.setAttribute('aria-label', FILTER_PLACEHOLDER);
  input.addEventListener('input', () => {
    _filter = input.value;
    const list = _root?.querySelector('.hooks-list-yours');
    if (list) list.replaceWith(buildYoursList());
  });
  return input;
}

function buildEmptyState() {
  const empty = el('div', 'hooks-empty-state');
  empty.append(buildLine('hooks-empty', HOOKS_EMPTY_TEXT), buildTemplateRow(eventsOf(_report)));
  return empty;
}

function buildYoursList() {
  const wrap = el('div', 'hooks-list-yours');
  const hooks = hooksOf(_report);
  if (hooks.length === 0) {
    wrap.append(buildEmptyState());
    return wrap;
  }
  const shown = filterHooks(sortHooks(hooks, eventsOf(_report)), _filter);
  if (shown.length === 0) {
    wrap.append(buildLine('hooks-empty', FILTER_EMPTY_TEXT));
    return wrap;
  }
  for (const group of groupHooksByEvent(shown)) {
    const groupEl = el('div', 'hooks-group');
    groupEl.append(el('h3', 'hooks-group-title', group.event));
    const list = el('div', 'hooks-list');
    for (const hook of group.hooks) list.append(buildRow(hook, { grouped: true }));
    groupEl.append(list);
    wrap.append(groupEl);
  }
  return wrap;
}

function buildYoursSection() {
  const section = buildSection(YOUR_HOOKS_TITLE, null);
  const add = buildButton('hooks-btn hooks-btn-add', '+ New hook', () => openEditor(null));
  add.disabled = !!_draft;
  const head = section.querySelector('.hooks-section-head');
  if (head) head.append(add);
  if (showsFilter(hooksOf(_report))) section.append(buildFilter());
  section.append(buildYoursList());
  return section;
}

function buildBuiltinSection() {
  const details = el('details', 'hooks-builtin');
  const summary = el('summary', 'hooks-builtin-summary');
  summary.append(el('span', 'hooks-section-title', `${BUILTIN_TITLE} (${builtinOf(_report).length})`), el('span', 'hooks-section-hint', BUILTIN_HINT));
  const list = el('div', 'hooks-list');
  for (const entry of builtinOf(_report)) list.append(buildBuiltinRow(entry));
  details.append(summary, list);
  return details;
}

function buildBody() {
  const content = el('div', 'hooks-content');
  if (!_report) {
    content.append(buildLine('hooks-empty', HOOKS_LOADING_TEXT));
    return content;
  }
  if (isHooksUnavailable(_report)) {
    content.append(buildLine('hooks-warning', hooksErrorLine(_report)));
    return content;
  }
  content.append(buildTotalsSection());
  if (_editorEl) content.append(_editorEl);
  content.append(buildYoursSection(), buildBuiltinSection());
  return content;
}

function render({ force = false }: { force?: boolean } = {}) {
  if (!_root) return;
  if (!force && isPanelHidden(_root)) return;
  _root.replaceChildren(buildBody());
  if (!_focusAddOnRender) return;
  _focusAddOnRender = false;
  const add = _root.querySelector('.hooks-btn-add');
  if (add instanceof HTMLButtonElement) add.focus();
}

export function setHooksRequestSender(send: (message: Record<string, unknown>) => void) {
  _sendRequest = send;
}

export function requestHooksReport() {
  if (!_sendRequest) return;
  _requestSeq += 1;
  _latestRequestId = `hooks-report-${_requestSeq}`;
  _sendRequest({ type: 'request-hooks-report', requestId: _latestRequestId });
}

export function mountHooksView(parent: HTMLElement) {
  if (_root) return;
  _root = el('div', 'hooks-panel');
  parent.append(_root);
  render({ force: true });
}

export function refreshHooksView() {
  render({ force: true });
}

export function applyHooksReport(msg: unknown) {
  if (!shouldApplyHooksReport(msg, _latestRequestId)) return;
  _report = msg as HooksReport;
  _busyIds.clear();

  _saving = false;
  render();
}

export function applySaveHookResult(msg: unknown) {
  if (!msg || typeof msg !== 'object') return;
  const result = msg as { requestId?: unknown; ok?: unknown; error?: unknown };
  const wasEditorSave = _editorRequestId !== null && result.requestId === _editorRequestId;
  if (wasEditorSave) { _editorRequestId = null; _saving = false; }
  if (result.ok) {
    if (wasEditorSave) closeEditor();
    requestHooksReport();
    return;
  }
  const error = typeof result.error === 'string' && result.error ? result.error : 'Could not save the hook';
  if (wasEditorSave) { setEditorError(error); return; }
  showErrorToast(error, { persist: true });
  requestHooksReport();
}

export function applyDeleteHookResult(msg: unknown) {
  if (!msg || typeof msg !== 'object') return;
  const result = msg as { ok?: unknown; error?: unknown };
  if (!result.ok) showErrorToast(typeof result.error === 'string' && result.error ? result.error : 'Could not delete the hook', { persist: true });
  requestHooksReport();
}
