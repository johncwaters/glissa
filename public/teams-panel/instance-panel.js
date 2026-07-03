// ── Instance panel ────────────────────────────────────────────
// Builds one team-instance panel: header, pipeline rail, conversation, controls, schedule editor,
// setup banner, guardrails, and recent runs. Wires all of its own event handlers.

import { createConfirmDialog } from '../dialogs.js';
import { sendControlMsg } from '../control-ws.js';
import { el } from '../dom-helpers.js';
import { autosizeChat } from './chat.js';
import { STAGE_GLYPH, isValidTz, key, labelFor } from './format-core.mjs';
import { resetPipeline } from './pipeline.js';
import { mounted, notifyTabActivity, runningKeys } from './registry.js';
import { setCollapsed, setRunning, setStatus } from './run-status.js';
import { buildScheduleEditor } from './schedule-editor.js';

function projectName(id) {
  if (!mounted || !id) return '';
  const p = (mounted.projects || []).find((x) => x.id === id);
  return p ? p.name : '';
}

// Trust posture, slimmed. The dangerous mode (skip-permissions) keeps a loud boxed chip because it is
// the one real "notice me"; the routine write-scope and deny-list fold into a single quiet caption so
// the panel is not a wall of boxes. Still derived from the team's permission deny-list, so it stays
// data-driven.
function renderGuardrails(perm, outputPath) {
  const wrap = el('div', 'team-guardrails');
  const mode = (perm?.mode) || 'interactive';
  const deny = (perm?.deny) || [];
  const has = (re) => deny.some((d) => re.test(d));
  // skip-permissions is the one real hazard, so it keeps a loud boxed chip; every other mode is routine
  // posture and rides quietly in the caption.
  const parts = [];
  if (mode === 'yolo') { wrap.append(el('span', 'guardrail-chip guardrail-mode', 'skip-permissions')); }
  if (mode !== 'yolo') parts.push(`${mode} mode`);
  const blocks = [];
  if (has(/\b(rm|rmdir|del|rd)\b/i)) blocks.push('file deletes');
  if (has(/git\s+(push|reset|clean)/i)) blocks.push('git push/reset');
  if (has(/npm\s+(publish|version)/i)) blocks.push('npm publish');
  if (has(/curl|wget|invoke-webrequest|iwr/i)) blocks.push('network');
  if (has(/secret|\.env/i)) blocks.push('secrets');
  parts.push(`writes ${outputPath} only`);
  if (blocks.length) parts.push(`blocks ${blocks.join(', ')}`);
  wrap.append(el('span', 'guardrail-summary', parts.join(' · ')));
  return wrap;
}

export function renderInstancePanel(team, activation) {
  const projectId = activation.projectId;
  const k = key(team.id, projectId);
  const panel = el('section', 'team-panel collapsed'); // resting state; expands on chevron, run, or setup
  panel.dataset.key = k;

  // Band 1: header (scan line)
  const head = el('header', 'team-panel-head');
  const headline = el('div', 'team-headline');
  headline.append(el('h2', 'team-panel-name', team.name || team.id));
  const target = el('span', 'team-target');
  target.append(el('span', 'team-target-arrow', '→'));
  target.append(el('span', 'team-target-name', projectName(projectId) || '(project removed)'));
  headline.append(target);
  head.append(headline);
  const headRight = el('div', 'team-head-right');
  const statusGroup = el('div', 'team-status-group');
  const status = el('span', 'team-status', 'Idle');
  status.setAttribute('role', 'status');
  const next = el('span', 'team-next');
  next.hidden = true;
  statusGroup.append(status, next);
  const collapseBtn = el('button', 'team-collapse', '▸');
  collapseBtn.type = 'button';
  collapseBtn.setAttribute('aria-expanded', 'false');
  collapseBtn.setAttribute('aria-label', 'Expand team details');
  headRight.append(statusGroup, collapseBtn);
  head.append(headRight);
  panel.append(head);

  if (team.description) {
    const desc = el('p', 'team-desc', team.description);
    desc.title = team.description; // clamped to 2 lines in CSS; full text on hover
    panel.append(desc);
  }

  // Band 2: pipeline rail
  const stages = (team.stageDetail?.length) ? team.stageDetail : (team.stages || []).map((id) => ({ id }));
  const pipeline = el('ol', 'team-pipeline');
  pipeline.setAttribute('aria-label', 'Pipeline stages');
  const stageNodes = new Map();
  stages.forEach((s, i) => {
    if (i > 0) {
      const arrow = el('li', 'pipeline-arrow', '→');
      arrow.setAttribute('aria-hidden', 'true');
      pipeline.append(arrow);
    }
    const node = el('li', 'pipeline-stage');
    node.dataset.stage = s.id;
    node.dataset.state = 'idle';
    if (s.optional) node.dataset.optional = 'true';
    if (s.summary) node.title = s.summary + (s.optional ? ' (optional)' : '');
    node.append(el('span', 'stage-glyph', STAGE_GLYPH.idle));
    node.append(el('span', 'stage-name', labelFor(s.id)));
    if (s.model) node.append(el('span', 'stage-model', s.model));
    pipeline.append(node);
    stageNodes.set(s.id, node);
  });
  panel.append(pipeline);

  // Band 2.5: conversation (live feed + operator steering + answering a paused agent question)
  const chatWrap = el('div', 'team-chat');
  const chatLog = el('div', 'team-chat-log');
  chatLog.setAttribute('role', 'log');
  chatLog.setAttribute('aria-live', 'polite');
  chatLog.setAttribute('aria-label', 'Team conversation');
  const chatPending = el('div', 'chat-pending-question');
  chatPending.hidden = true;
  const chatForm = el('form', 'team-chat-input');
  const chatField = document.createElement('textarea');
  chatField.className = 'chat-input-field';
  chatField.rows = 1;
  chatField.disabled = true;
  chatField.placeholder = 'Run the team to chat with it';
  chatField.setAttribute('aria-label', 'Message the team');
  const chatSend = el('button', 'chat-send', 'Send');
  chatSend.type = 'submit';
  chatForm.append(chatField, chatSend);
  chatWrap.append(chatLog, chatPending, chatForm);
  panel.append(chatWrap);

  // Band 3: controls
  const controls = el('div', 'team-control-row');
  const runGroup = el('div', 'team-run-group');
  const runBtn = el('button', 'team-run-btn', 'Run now');
  runBtn.type = 'button';
  const cancelBtn = el('button', 'team-cancel-btn', 'Cancel');
  cancelBtn.type = 'button';
  cancelBtn.hidden = true;
  const spinner = el('span', 'team-spinner');
  spinner.setAttribute('aria-hidden', 'true');
  const elapsedEl = el('span', 'team-elapsed');
  runGroup.append(runBtn, cancelBtn, spinner, elapsedEl);

  const schedGroup = el('div', 'team-sched-group');
  const schedToggle = el('label', 'team-sched-toggle');
  const schedCb = document.createElement('input');
  schedCb.type = 'checkbox';
  schedToggle.append(schedCb, el('span', null, 'Schedule'));
  const schedSummary = el('span', 'team-sched-summary', 'Manual only');
  const editBtn = el('button', 'team-sched-edit', 'Edit');
  editBtn.type = 'button';
  editBtn.setAttribute('aria-expanded', 'false');
  const removeBtn = el('button', 'team-remove-btn', 'Remove');
  removeBtn.type = 'button';
  schedGroup.append(schedToggle, schedSummary, editBtn, removeBtn);

  controls.append(runGroup, schedGroup);
  panel.append(controls);

  // schedule editor (revealed by Edit)
  const editor = buildScheduleEditor();
  panel.append(editor.wrap);

  // setup banner - shown when this project's pack is not yet filled in (get-team-pack-status).
  // Sits above the guardrails divider: it's an action you take before running, not run history.
  const setupEl = el('div', 'team-setup');
  setupEl.hidden = true;
  panel.append(setupEl);

  // guardrails
  panel.append(renderGuardrails(team.permissions, team.outputPath));

  // Band 4: recent runs
  const runsWrap = el('div', 'team-runs');
  runsWrap.append(el('h3', 'team-runs-title', 'Recent runs'));
  const runsList = el('ul', 'team-runs-list');
  runsWrap.append(runsList);
  panel.append(runsWrap);

  const refs = {
    teamId: team.id, projectId, team, panel,
    stageNodes, status, next, runGroup, runBtn, cancelBtn, elapsedEl,
    schedCb, schedSummary, editBtn, removeBtn, editor, runsList, setupEl, collapseBtn,
    chatWrap, chatLog, chatPending, chatField, chatSend, chatAwaiting: false,
    schedule: activation.schedule || team.schedule || null, enabled: !!activation.enabled,
    timer: null, stageStartMs: 0, budget: team.stageTimeoutSeconds || 900, running: false, collapsed: true,
  };

  collapseBtn.addEventListener('click', () => setCollapsed(refs, !refs.collapsed));

  // Post an operator message (steering note, or the answer to a paused stage's question). Enter sends,
  // Shift+Enter inserts a newline. The backend rejects a post when no run is active.
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatField.value.trim();
    if (!text) return;
    sendControlMsg({ type: 'post-team-message', teamId: team.id, projectId, text });
    chatField.value = '';
    autosizeChat(chatField);
  });
  chatField.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatForm.requestSubmit(); }
  });
  chatField.addEventListener('input', () => autosizeChat(chatField));

  // The run executes in an isolated git worktree (see team-git.js), so it never touches the working
  // tree and needs no clean-repo preflight.
  runBtn.addEventListener('click', () => {
    resetPipeline(stageNodes);
    setRunning(refs, true);
    setStatus(refs, 'Starting...', 'run');
    runningKeys.add(k);
    notifyTabActivity();
    sendControlMsg({ type: 'run-team', teamId: team.id, projectId });
  });

  cancelBtn.addEventListener('click', () => {
    setStatus(refs, 'Cancelling...', '');
    sendControlMsg({ type: 'cancel-team-run', teamId: team.id, projectId });
  });

  schedCb.addEventListener('change', () => {
    refs.enabled = schedCb.checked;
    sendControlMsg({ type: 'set-team-schedule', teamId: team.id, projectId, enabled: schedCb.checked, schedule: refs.schedule || undefined });
  });

  editBtn.addEventListener('click', () => {
    const open = editor.wrap.hidden;
    if (open) editor.setValues(refs.schedule);
    editor.wrap.hidden = !open;
    editBtn.setAttribute('aria-expanded', String(open));
    if (open) requestAnimationFrame(() => editor.dayBtns.get('mon')?.focus());
  });

  editor.saveBtn.addEventListener('click', () => {
    const v = editor.getValues();
    editor.err.textContent = '';
    if (!v.days.length) { editor.err.textContent = 'Pick at least one day.'; return; }
    if (!/^\d{2}:\d{2}$/.test(v.time)) { editor.err.textContent = 'Time must be HH:MM.'; return; }
    if (!isValidTz(v.tz)) { editor.err.textContent = 'Unknown time zone.'; return; }
    refs.schedule = v;
    refs.enabled = true;
    schedCb.checked = true;
    sendControlMsg({ type: 'set-team-schedule', teamId: team.id, projectId, enabled: true, schedule: v });
    editor.wrap.hidden = true;
    editBtn.setAttribute('aria-expanded', 'false');
  });
  editor.cancelBtn.addEventListener('click', () => {
    editor.wrap.hidden = true;
    editBtn.setAttribute('aria-expanded', 'false');
  });

  removeBtn.addEventListener('click', () => {
    createConfirmDialog({
      title: 'Remove this team?',
      message: `Remove ${team.name || team.id} → ${projectName(projectId) || 'this project'}? Its run history on disk is kept; only the schedule and this panel go away.`,
      confirmLabel: 'Remove',
      danger: true,
      onConfirm: () => sendControlMsg({ type: 'remove-team-instance', teamId: team.id, projectId }),
    });
  });

  mounted.instances.set(k, refs);
  return panel;
}
