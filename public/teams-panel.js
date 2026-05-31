// ── Teams view ────────────────────────────────────────────────
// Dedicated tab surface for premade agent pipelines. A "team" here is an INSTANCE: a roster bound
// to one project. The same roster can target several projects, and different rosters can share a
// project; each instance is one (teamId, projectId) activation persisted in config.teams.
//
// Each instance renders as a panel with four bands (the lifecycle, top to bottom):
//   1. header   — roster name -> target, live status, next scheduled run
//   2. pipeline — the stage sequence, live during a run (active stage, elapsed vs budget)
//   3. controls — Run / Cancel, the schedule (on/off + inline day/time/tz editor), Remove, guardrails
//   4. runs     — recent runs, each expandable to its summary + buttons that open artifacts in the editor
//
// Talks to the backend over the control WebSocket (list-teams / add-team-instance /
// remove-team-instance / run-team / cancel-team-run / set-team-schedule / get-team-runs /
// open-artifact) and reacts to team-* broadcasts. Safe whether or not the view is mounted.

import { sendControlMsg, sendControlRequest } from './control-ws.js';
import { createConfirmDialog } from './dialogs.js';

let mounted = null; // { container, stackEl, addBar, teams: Map, instances: Map<key, refs>, projects, activations }
let tabActivityCb = null;
const runningKeys = new Set(); // instance keys with a run in flight — drives the tab activity dot

const STAGE_LABEL = {
  researcher: 'Researcher',
  strategist: 'Strategist',
  writer: 'Writer',
  editor: 'Editor',
  publisher: 'Publisher',
};
const STAGE_GLYPH = { idle: '○', active: '●', done: '■', failed: '▲' };
const VERDICT_GLYPH = { ship: '■', fix: '◆', block: '▲', failed: '▲', skipped: '○', done: '●', incomplete: '○' };
const DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
const TZ_PRESETS = [
  'America/Denver', 'America/New_York', 'America/Chicago', 'America/Los_Angeles',
  'UTC', 'Europe/London', 'Europe/Berlin', 'Asia/Tokyo',
];

export function setTabActivityCallback(fn) { tabActivityCb = fn; }
function setTabActivity() { if (tabActivityCb) tabActivityCb(runningKeys.size > 0); }

// ── small helpers ─────────────────────────────────────────────

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}
function key(teamId, projectId) { return `${teamId}:${projectId}`; }
function labelFor(id) { return STAGE_LABEL[id] || (id ? id.charAt(0).toUpperCase() + id.slice(1) : id); }

function projectName(id) {
  if (!mounted || !id) return '';
  const p = (mounted.projects || []).find((x) => x.id === id);
  return p ? p.name : '';
}

function classifyVerdict(text) {
  const v = (text || '').toUpperCase();
  if (v.includes('SHIP')) return 'ship';
  if (v.includes('FIX')) return 'fix';
  if (v.includes('BLOCK')) return 'block';
  if (v.includes('FAIL') || v.includes('DIRTY') || v.includes('HALT') || v.includes('ERROR')) return 'failed';
  if (v.includes('SKIP')) return 'skipped';
  return 'done';
}

// Run folder id is "YYYY-MM-DD-weekday"; show the date + a short weekday.
function formatRunDate(runId) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:-([a-z]+))?/i.exec(runId || '');
  if (!m) return runId || '';
  const wd = m[2] ? ` · ${m[2].charAt(0).toUpperCase()}${m[2].slice(1, 3)}` : '';
  return `${m[1]}${wd}`;
}

function scheduleSummary(sch) {
  if (!sch || !sch.days || !sch.days.length) return '';
  const days = sch.days.map((d) => d.charAt(0).toUpperCase() + d.slice(1, 3)).join('/');
  const tz = sch.tz ? sch.tz.split('/').pop().replace(/_/g, ' ') : '';
  return `${days} ${sch.time || ''} ${tz}`.replace(/\s+/g, ' ').trim();
}

function formatNextFire(ms) {
  try {
    return new Date(ms).toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch { return ''; }
}

function isValidTz(tz) {
  if (!tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// Editor artifact label from its filename: "drafts.md" -> "Drafts".
function artifactLabel(file) {
  const base = String(file).replace(/\.[^.]+$/, '');
  return base.charAt(0).toUpperCase() + base.slice(1);
}

// Trust posture as scannable chips, derived from the team's permission deny-list so it stays
// data-driven. The mode chip (skip-permissions) is the one to notice, so it carries the warning tint.
function renderGuardrails(perm, outputPath) {
  const wrap = el('div', 'team-guardrails');
  const mode = (perm?.mode) || 'interactive';
  const deny = (perm?.deny) || [];
  const has = (re) => deny.some((d) => re.test(d));
  wrap.append(el('span', 'guardrail-chip guardrail-mode', mode === 'yolo' ? 'skip-permissions' : `${mode} mode`));
  wrap.append(el('span', 'guardrail-chip', `writes only ${outputPath}/`));
  const blocks = [];
  if (has(/\b(rm|rmdir|del|rd)\b/i)) blocks.push('file deletes');
  if (has(/git\s+(push|reset|clean)/i)) blocks.push('git push/reset');
  if (has(/npm\s+(publish|version)/i)) blocks.push('npm publish');
  if (has(/curl|wget|invoke-webrequest|iwr/i)) blocks.push('network');
  if (has(/secret|\.env/i)) blocks.push('secrets');
  if (blocks.length) {
    wrap.append(el('span', 'guardrail-blocks-label', 'blocks'));
    for (const b of blocks) wrap.append(el('span', 'guardrail-chip guardrail-block', b));
  }
  return wrap;
}

function mmss(totalSec) {
  const s = Math.max(0, totalSec | 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function ensureTzDatalist() {
  if (document.getElementById('tz-presets')) return;
  const dl = document.createElement('datalist');
  dl.id = 'tz-presets';
  for (const z of TZ_PRESETS) { const o = document.createElement('option'); o.value = z; dl.append(o); }
  document.body.append(dl);
}

// ── pipeline rail ─────────────────────────────────────────────

function setNode(node, state) {
  if (!node) return;
  node.dataset.state = state;
  const glyph = node.querySelector('.stage-glyph');
  if (glyph) glyph.textContent = STAGE_GLYPH[state] || STAGE_GLYPH.idle;
}
function resetPipeline(stageNodes) { for (const n of stageNodes.values()) setNode(n, 'idle'); }
// Activating a stage implies every earlier stage is done.
function markStage(stageNodes, stageId, state) {
  if (state !== 'active') { setNode(stageNodes.get(stageId), state); return; }
  const ids = [...stageNodes.keys()];
  const idx = ids.indexOf(stageId);
  ids.forEach((id, i) => {
    const nextState = i < idx ? 'done' : i === idx ? 'active' : 'idle';
    setNode(stageNodes.get(id), nextState);
  });
}
function settleActive(stageNodes) {
  for (const n of stageNodes.values()) if (n.dataset.state === 'active') setNode(n, 'done');
}
function stageIndexLabel(refs, stageId) {
  const ids = [...refs.stageNodes.keys()];
  const i = ids.indexOf(stageId);
  return i >= 0 ? `${i + 1} of ${ids.length}` : '';
}

// ── running indicator ─────────────────────────────────────────

function setStatus(refs, text, kind) {
  refs.status.textContent = text;
  refs.status.dataset.kind = kind || '';
}
// Compact resting state: idle, configured panels collapse to header + Run. They expand on the chevron,
// when a run starts, or when setup is needed. Elements stay in the DOM (live handlers keep updating
// them); CSS just hides the lower bands while collapsed.
function setCollapsed(refs, collapsed) {
  refs.collapsed = collapsed;
  refs.panel.classList.toggle('collapsed', collapsed);
  if (refs.collapseBtn) {
    refs.collapseBtn.setAttribute('aria-expanded', String(!collapsed));
    refs.collapseBtn.setAttribute('aria-label', collapsed ? 'Expand team details' : 'Collapse team details');
  }
}
function tickElapsed(refs) {
  const sec = refs.stageStartMs ? Math.round((Date.now() - refs.stageStartMs) / 1000) : 0;
  refs.elapsedEl.textContent = `${mmss(sec)} / ${mmss(refs.budget)}`;
  // Tint the timer once a stage runs past its budget, so a stuck stage reads at a glance.
  refs.elapsedEl.classList.toggle('over-budget', refs.budget > 0 && sec > refs.budget);
}
function startStageClock(refs) { refs.stageStartMs = Date.now(); if (refs.timer) tickElapsed(refs); }
function setRunning(refs, on) {
  refs.running = on;
  if (on) setCollapsed(refs, false); // a running team always shows its pipeline
  refs.runGroup.classList.toggle('running', on);
  refs.runBtn.hidden = on;
  refs.cancelBtn.hidden = !on;
  refs.schedCb.disabled = on;
  refs.editBtn.disabled = on;
  refs.removeBtn.disabled = on;
  if (on) {
    if (!refs.timer) {
      if (!refs.stageStartMs) refs.stageStartMs = Date.now();
      refs.timer = setInterval(() => tickElapsed(refs), 1000);
      tickElapsed(refs);
    }
  } else if (refs.timer) {
    clearInterval(refs.timer);
    refs.timer = null;
    refs.elapsedEl.textContent = '';
    refs.stageStartMs = 0;
  }
}

function failText(msg) {
  if (msg.reason === 'halt') return 'No topic available, the content calendar had nothing to cover.';
  const at = msg.stage ? ` @ ${labelFor(msg.stage)}` : '';
  const why = msg.reason ? ` · ${msg.reason}` : '';
  return `Failed${at}${why}`;
}

// Where a finished run landed: merged into the base branch, or parked on its own branch.
function mergeNote(msg) {
  if (msg.merged) return msg.base ? ` · merged to ${msg.base}` : ' · merged';
  if (msg.branch) return ` · on ${msg.branch}`;
  return '';
}

// ── recent runs ───────────────────────────────────────────────

function artifactButtons(refs, r) {
  const detail = refs.team.stageDetail || [];
  const avail = (r.reached || []).map((id) => detail.find((s) => s.id === id)).filter((s) => s?.produces);
  if (!avail.length) return null;
  const wrap = el('div', 'run-artifacts');
  wrap.append(el('span', 'run-artifacts-label', 'Open'));
  for (const s of avail) {
    const b = el('button', 'run-artifact', artifactLabel(s.produces));
    b.type = 'button';
    b.addEventListener('click', () => {
      sendControlMsg({ type: 'open-artifact', teamId: refs.teamId, projectId: refs.projectId, runId: r.runId, artifact: s.produces });
    });
    wrap.append(b);
  }
  return wrap;
}

function renderRunRow(refs, r) {
  const hasVerdict = !!r.verdict;
  const kind = hasVerdict ? classifyVerdict(r.verdict) : 'incomplete';
  const li = el('li', 'run-item');
  li.dataset.verdict = kind;

  const row = el('button', 'run-row');
  row.type = 'button';
  row.setAttribute('aria-expanded', 'false');
  const verdict = el('span', 'run-verdict', hasVerdict ? `${VERDICT_GLYPH[kind] || ''} ${r.verdict}`.trim() : 'Incomplete');
  verdict.dataset.verdict = kind;
  const topic = el('span', 'run-topic', r.topic || '(no topic recorded)');
  if (r.topic) topic.title = r.topic;
  const date = el('span', 'run-date', formatRunDate(r.runId));
  const chevron = el('span', 'run-chevron', '▸');
  chevron.setAttribute('aria-hidden', 'true');
  row.append(verdict, topic, date, chevron);

  const detail = el('div', 'run-detail');
  detail.hidden = true;
  if (r.summary) detail.append(el('p', 'run-summary', r.summary));
  if (r.platforms) detail.append(el('p', 'run-platforms', `Platforms: ${r.platforms}`));
  if (r.reached?.length) {
    detail.append(el('p', 'run-reached', `Ran: ${r.reached.map(labelFor).join(' → ')}`));
  }
  const arts = artifactButtons(refs, r);
  if (arts) detail.append(arts);
  else detail.append(el('p', 'run-noartifacts', 'No files were written for this run.'));

  row.addEventListener('click', () => {
    const open = detail.hidden;
    detail.hidden = !open;
    row.setAttribute('aria-expanded', String(open));
    li.classList.toggle('open', open);
  });

  li.append(row, detail);
  return li;
}

function renderRuns(refs, runs) {
  if (!runs || runs.length === 0) {
    refs.runsList.replaceChildren(el('li', 'run-item run-empty', 'No runs yet.'));
    return;
  }
  refs.runsList.replaceChildren(...runs.map((r) => renderRunRow(refs, r)));
}

// Show or hide the "fill the pack" banner for this instance. Driven by get-team-pack-status so the
// operator sees the setup callout BEFORE running, not only after a halted run.
function renderSetup(refs, ps) {
  if (!refs.setupEl) return;
  if (!ps || ps.configured) { refs.setupEl.hidden = true; refs.setupEl.replaceChildren(); return; }
  refs.setupEl.hidden = false;
  setCollapsed(refs, false); // an unfilled pack is a blocker; never hide it behind the collapsed state
  const head = el('p', 'team-setup-head', 'Set up this project’s pack before the first run.');
  const sub = el('p', 'team-setup-sub', 'The pack is this project’s specifics (voice, brand, channels) that the agents read on every run.');

  // A guided interview agent reads the project, asks for the subjective bits, and writes the pack for
  // you. It opens as its own terminal session card you answer in.
  const auto = el('button', 'team-setup-auto', 'Set up automatically');
  auto.type = 'button';
  auto.addEventListener('click', () => {
    auto.disabled = true;
    setStatus(refs, 'Starting setup…', 'run');
    sendControlMsg({ type: 'setup-team-pack', teamId: refs.teamId, projectId: refs.projectId });
  });

  refs.setupEl.replaceChildren(head, sub, auto);
}

// Pull a single instance's full state in one request: runs, active flag, schedule + next fire.
function refreshInstance(refs) {
  refs.runsList.replaceChildren(el('li', 'run-item run-empty', 'Loading…'));
  sendControlRequest('get-team-pack-status', { teamId: refs.teamId, projectId: refs.projectId })
    .then((ps) => renderSetup(refs, ps))
    .catch(() => {});
  sendControlRequest('get-team-runs', { teamId: refs.teamId, projectId: refs.projectId })
    .then((msg) => {
      if (msg.schedule) refs.schedule = msg.schedule;
      refs.enabled = !!msg.enabled;
      if (!refs.running) refs.schedCb.checked = refs.enabled;
      applyScheduleSummary(refs, msg.nextFire);
      renderRuns(refs, msg.runs || []);
      if (msg.active && !refs.running) {
        setRunning(refs, true);
        setStatus(refs, 'Running…', 'run');
        runningKeys.add(key(refs.teamId, refs.projectId));
        setTabActivity();
      }
    })
    .catch(() => { refs.runsList.replaceChildren(el('li', 'run-item run-empty', 'Could not load run history.')); });
}

function applyScheduleSummary(refs, nextFire) {
  const sch = refs.schedule;
  const hasDays = sch?.days?.length;
  if (refs.enabled && hasDays) {
    refs.schedSummary.textContent = scheduleSummary(sch);
    refs.next.hidden = !nextFire;
    if (nextFire) refs.next.textContent = `Next run ${formatNextFire(nextFire)}`;
  } else {
    refs.schedSummary.textContent = hasDays ? `${scheduleSummary(sch)} · off` : 'Manual only';
    refs.next.hidden = true;
  }
}

// ── schedule editor ───────────────────────────────────────────

function buildScheduleEditor() {
  ensureTzDatalist();
  const wrap = el('div', 'team-sched-editor');
  wrap.hidden = true;

  const daysRow = el('div', 'sched-days');
  daysRow.setAttribute('role', 'group');
  daysRow.setAttribute('aria-label', 'Days to run');
  const dayBtns = new Map();
  for (const [tok, label] of DAYS) {
    const b = el('button', 'sched-day', label);
    b.type = 'button';
    b.dataset.day = tok;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => {
      b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
    });
    daysRow.append(b);
    dayBtns.set(tok, b);
  }

  const fields = el('div', 'sched-fields');
  const timeField = el('label', 'sched-field');
  timeField.append(el('span', 'sched-field-label', 'Time'));
  const timeInput = document.createElement('input');
  timeInput.type = 'time';
  timeInput.className = 'sched-time';
  timeField.append(timeInput);
  const tzField = el('label', 'sched-field');
  tzField.append(el('span', 'sched-field-label', 'Time zone'));
  const tzInput = document.createElement('input');
  tzInput.type = 'text';
  tzInput.className = 'sched-tz';
  tzInput.setAttribute('list', 'tz-presets');
  tzInput.spellcheck = false;
  tzInput.autocomplete = 'off';
  tzField.append(tzInput);
  fields.append(timeField, tzField);

  const actions = el('div', 'sched-editor-actions');
  const saveBtn = el('button', 'sched-save', 'Save schedule');
  saveBtn.type = 'button';
  const cancelBtn = el('button', 'sched-cancel', 'Cancel');
  cancelBtn.type = 'button';
  const err = el('span', 'sched-err');
  actions.append(saveBtn, cancelBtn, err);

  wrap.append(daysRow, fields, actions);

  return {
    wrap, dayBtns, timeInput, tzInput, saveBtn, cancelBtn, err,
    getValues() {
      const days = [...dayBtns].filter(([, b]) => b.getAttribute('aria-pressed') === 'true').map(([t]) => t);
      return { days, time: timeInput.value, tz: tzInput.value.trim() };
    },
    setValues(sch) {
      const set = new Set(((sch?.days) || []).map((d) => String(d).toLowerCase().slice(0, 3)));
      for (const [tok, b] of dayBtns) b.setAttribute('aria-pressed', String(set.has(tok)));
      timeInput.value = (sch?.time) || '05:00';
      tzInput.value = (sch?.tz) || 'America/Denver';
      err.textContent = '';
    },
  };
}

// ── instance panel ────────────────────────────────────────────

function renderInstancePanel(team, activation) {
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

  if (team.description) panel.append(el('p', 'team-desc', team.description));

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

  // setup banner — shown when this project's pack is not yet filled in (get-team-pack-status).
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
    schedule: activation.schedule || team.schedule || null, enabled: !!activation.enabled,
    timer: null, stageStartMs: 0, budget: team.stageTimeoutSeconds || 900, running: false, collapsed: true,
  };

  collapseBtn.addEventListener('click', () => setCollapsed(refs, !refs.collapsed));

  // The run executes in an isolated git worktree (see team-git.js), so it never touches the working
  // tree and needs no clean-repo preflight.
  runBtn.addEventListener('click', () => {
    resetPipeline(stageNodes);
    setRunning(refs, true);
    setStatus(refs, 'Starting…', 'run');
    runningKeys.add(k);
    setTabActivity();
    sendControlMsg({ type: 'run-team', teamId: team.id, projectId });
  });

  cancelBtn.addEventListener('click', () => {
    setStatus(refs, 'Cancelling…', '');
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

// ── add-team bar ──────────────────────────────────────────────

function buildAddBar() {
  const bar = el('div', 'teams-add');
  const toggle = el('button', 'teams-add-toggle', '+ Add team');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');

  const form = el('div', 'teams-add-form');
  form.hidden = true;
  const rosterField = el('label', 'teams-add-field');
  rosterField.append(el('span', 'teams-add-label', 'Roster'));
  const rosterSel = el('select', 'teams-add-roster');
  rosterField.append(rosterSel);
  const projField = el('label', 'teams-add-field');
  projField.append(el('span', 'teams-add-label', 'Target project'));
  const projSel = el('select', 'teams-add-project');
  projField.append(projSel);
  const addBtn = el('button', 'teams-add-confirm', 'Add');
  addBtn.type = 'button';
  const cancelBtn = el('button', 'teams-add-cancel', 'Cancel');
  cancelBtn.type = 'button';
  const err = el('span', 'teams-add-err');
  form.append(rosterField, projField, addBtn, cancelBtn, err);

  bar.append(toggle, form);
  return { bar, toggle, form, rosterSel, projSel, addBtn, cancelBtn, err };
}

function populateRosterOptions(sel) {
  sel.replaceChildren();
  const def = el('option', null, 'Select a roster');
  def.value = ''; def.disabled = true; def.selected = true;
  sel.append(def);
  for (const t of mounted.teams.values()) {
    const o = el('option', null, t.name || t.id);
    o.value = t.id;
    sel.append(o);
  }
}
function populateProjectOptions(sel) {
  sel.replaceChildren();
  const projects = mounted.projects || [];
  if (!projects.length) {
    const o = el('option', null, 'Add a session first');
    o.value = ''; o.disabled = true; o.selected = true;
    sel.append(o);
    sel.disabled = true;
    if (mounted.addBar) mounted.addBar.addBtn.disabled = true;
    return;
  }
  const def = el('option', null, 'Select a project');
  def.value = ''; def.disabled = true; def.selected = true;
  sel.append(def);
  for (const p of projects) {
    const o = el('option', null, p.name);
    o.value = p.id;
    sel.append(o);
  }
}

function wireAddBar(add) {
  add.toggle.addEventListener('click', () => {
    const open = add.form.hidden;
    add.form.hidden = !open;
    add.toggle.setAttribute('aria-expanded', String(open));
    add.err.textContent = '';
    if (open) requestAnimationFrame(() => add.rosterSel.focus());
  });
  add.cancelBtn.addEventListener('click', () => {
    add.form.hidden = true;
    add.toggle.setAttribute('aria-expanded', 'false');
  });
  add.addBtn.addEventListener('click', () => {
    add.err.textContent = '';
    const teamId = add.rosterSel.value;
    const projectId = add.projSel.value;
    if (!teamId || !projectId) { add.err.textContent = 'Pick a roster and a project.'; return; }
    if (mounted.instances.has(key(teamId, projectId))) { add.err.textContent = 'That team already targets that project.'; return; }
    sendControlMsg({ type: 'add-team-instance', teamId, projectId });
  });
}

// ── stack assembly ────────────────────────────────────────────

function buildEmptyState() {
  const box = el('div', 'teams-empty-state');
  box.append(el('p', 'teams-empty-title', 'No team instances yet'));
  box.append(el('p', 'teams-empty-desc', 'A team is a premade roster (like the Marketing Pipeline) pointed at one of your projects. Add one above to run it on demand or on a schedule.'));
  return box;
}

function renderStack() {
  const stack = mounted.stackEl;
  for (const refs of mounted.instances.values()) if (refs.timer) clearInterval(refs.timer);
  mounted.instances.clear();

  if (!mounted.teams.size) {
    stack.replaceChildren(el('p', 'teams-empty', 'No teams defined under teams/.'));
    return;
  }
  const instances = (mounted.activations || []).filter((a) => mounted.teams.has(a.teamId));
  if (!instances.length) {
    stack.replaceChildren(buildEmptyState());
    return;
  }
  const panels = instances.map((a) => renderInstancePanel(mounted.teams.get(a.teamId), a));
  stack.replaceChildren(...panels);
  for (const a of instances) {
    const refs = mounted.instances.get(key(a.teamId, a.projectId));
    if (refs) refreshInstance(refs);
  }
}

function addInstancePanel(team, activation) {
  const k = key(team.id, activation.projectId);
  if (mounted.instances.has(k)) return;
  if (!mounted.instances.size) mounted.stackEl.replaceChildren(); // clear the empty state
  mounted.stackEl.append(renderInstancePanel(team, activation));
  const refs = mounted.instances.get(k);
  if (refs) refreshInstance(refs);
}

function removeInstancePanel(k) {
  const refs = mounted.instances.get(k);
  if (!refs) return;
  if (refs.timer) clearInterval(refs.timer);
  refs.panel.remove();
  mounted.instances.delete(k);
  runningKeys.delete(k);
  setTabActivity();
  if (!mounted.instances.size) mounted.stackEl.replaceChildren(buildEmptyState());
}

// (Re)render the whole view into `container`. `projects` is [{ id, name }].
export function mountTeamsView(container, projects = []) {
  if (mounted) {
    for (const refs of mounted.instances.values()) if (refs.timer) clearInterval(refs.timer);
  }
  runningKeys.clear();
  mounted = { container, stackEl: null, addBar: null, teams: new Map(), instances: new Map(), projects, activations: [] };

  const intro = el('p', 'teams-intro', 'Premade agent pipelines. Bind a roster to a project, run it on demand or on a schedule, then open what each run produced. Each team reads its specifics from the project’s pack: the voice, brand, and channels you fill in once.');
  const add = buildAddBar();
  mounted.addBar = add;
  const stack = el('div', 'teams-stack');
  mounted.stackEl = stack;
  stack.append(el('p', 'teams-loading', 'Loading teams…'));
  // A config surface reads as a centered column, not a full-bleed wall; the view stays the
  // full-width scroll container so the scrollbar sits at the viewport edge, not mid-screen.
  const content = el('div', 'teams-content');
  content.append(intro, add.bar, stack);
  container.replaceChildren(content);
  wireAddBar(add);

  sendControlRequest('list-teams', {})
    .then((msg) => {
      mounted.teams = new Map((msg.teams || []).map((t) => [t.id, t]));
      mounted.activations = msg.activations || [];
      populateRosterOptions(add.rosterSel);
      populateProjectOptions(add.projSel);
      renderStack();
    })
    .catch(() => { stack.replaceChildren(el('p', 'teams-empty', 'Failed to load teams.')); });
}

// ── broadcast handling ────────────────────────────────────────

function onInstanceAdded(msg) {
  if (!mounted) return;
  mounted.activations = msg.activations || mounted.activations;
  if (mounted.addBar) {
    mounted.addBar.form.hidden = true;
    mounted.addBar.toggle.setAttribute('aria-expanded', 'false');
  }
  const team = mounted.teams.get(msg.teamId);
  if (!team) return;
  const activation = (mounted.activations || []).find((a) => a.teamId === msg.teamId && a.projectId === msg.projectId)
    || { teamId: msg.teamId, projectId: msg.projectId };
  addInstancePanel(team, activation);
}

function onInstanceRemoved(msg) {
  if (!mounted) return;
  mounted.activations = msg.activations || mounted.activations;
  removeInstancePanel(key(msg.teamId, msg.projectId));
}

// Called by app.js for team-* broadcasts: structural changes, the tab activity dot, the live
// pipeline, the running indicator + status, and a run-history refresh on completion.
export function handleTeamMessage(msg) {
  const { type, teamId, projectId } = msg;

  if (type === 'team-instance-added') { onInstanceAdded(msg); return; }
  if (type === 'team-instance-removed') { onInstanceRemoved(msg); return; }

  const k = key(teamId, projectId);
  if (type === 'team-run-accepted' || type === 'team-run-started' || type === 'team-stage-started') runningKeys.add(k);
  if (type === 'team-run-complete' || type === 'team-run-failed' || type === 'team-run-skipped' || type === 'team-run-needs-setup') runningKeys.delete(k);
  setTabActivity();

  if (!mounted) return;

  if (type === 'team-schedule-updated') {
    mounted.activations = msg.activations || mounted.activations;
    const r = mounted.instances.get(k);
    if (r) refreshInstance(r);
    return;
  }

  const refs = mounted.instances.get(k);
  if (!refs) return;

  switch (type) {
    case 'team-run-accepted':
      setRunning(refs, true);
      setStatus(refs, 'Accepted…', 'run');
      break;
    case 'team-run-started':
      setRunning(refs, true);
      resetPipeline(refs.stageNodes);
      setStatus(refs, 'Running…', 'run');
      break;
    case 'team-stage-started':
      setRunning(refs, true);
      markStage(refs.stageNodes, msg.stage, 'active');
      startStageClock(refs);
      setStatus(refs, `${labelFor(msg.stage)} · ${stageIndexLabel(refs, msg.stage)}`, 'run');
      break;
    case 'team-stage-complete':
      markStage(refs.stageNodes, msg.stage, 'done');
      break;
    case 'team-run-complete':
      settleActive(refs.stageNodes);
      setRunning(refs, false);
      setStatus(refs, `Complete · ${msg.verdict || 'done'}${mergeNote(msg)}`, 'ok');
      refreshInstance(refs);
      break;
    case 'team-run-failed':
      if (msg.stage) markStage(refs.stageNodes, msg.stage, 'failed');
      setRunning(refs, false);
      setStatus(refs, failText(msg), 'fail');
      refreshInstance(refs);
      break;
    case 'team-run-skipped':
      setRunning(refs, false);
      setStatus(refs, 'Skipped (already running)', '');
      break;
    case 'team-run-needs-setup': {
      setRunning(refs, false);
      const files = (msg.unfilled || []).join(', ');
      setStatus(refs, `Setup needed: fill the pack (${files || 'pack files'}) then run again`, 'fail');
      break;
    }
    case 'setup-team-pack-started':
      setStatus(refs, msg.already
        ? 'Setup already running, answer it in its session'
        : 'Setup started, answer the questions in its terminal session', 'run');
      break;
    case 'team-pack-updated':
      renderSetup(refs, msg);
      if (msg.configured) {
        setStatus(refs, 'Pack ready, click Run', 'ok');
      } else {
        const remaining = (msg.unfilled || []).join(', ');
        setStatus(refs, `Pack still needs: ${remaining || 'more input'}`, 'fail');
      }
      break;
    default:
      break;
  }
}
