// ── Radar view ───────────────────────────────────────────────
// The one "everything outside your sessions that needs you" surface. Three sections fed by three
// existing control-WS broadcasts: PostHog issues (`posthog-status`), ops (`update-available` plus the
// anomaly block of `health-snapshot`) and the PR auto-review lane (`pr-status`). Radar is an ADDITIONAL
// consumer of the last three: the update banner, the health footer and the PRs tab all keep receiving
// them and rendering them in full. The tab is always present; only its content varies, so an operator
// who has configured none of the lanes still finds the surface and is told where to switch them on.

import { el } from './dom-helpers.js';
import { createPosthogReportDialog } from './dialogs.js';
import { sendControlRequest } from './control-ws.js';
import { createPollAgoTicker, formatAgo, formatDuration } from './poll-ago.js';
import { phaseLabel } from './pr-view-core.mjs';
import { createRenderHold } from './radar-hold-core.mjs';
import {
  healthAnomalyRows,
  hostsDiffer,
  investigationRows,
  needsActionPrRows,
  opsRows,
  partitionRadarProjects,
  radarAttentionCount,
  radarDisplayName,
  radarPlaceholder,
  severityFor as severity,
  shortHost,
  sortIssuesByAttention,
  sparklinePoints,
  summarizeIssues,
  verdictLabel,
} from './radar-core.mjs';

let _latest = null;
let _health = null;
// The anomaly shape of the last health snapshot. A snapshot lands every ten seconds and is almost
// always all-zero, and a full repaint on each one would drop hover state and reset the poll tickers
// for nothing, so only a CHANGE in which anomalies are live repaints the board.
let _healthKey = '';
let _update = null;
let _prs = null;
let _root = null;
let _activityCallback = null;
let _navigateToPrs = null;
const SVG_NS = 'http://www.w3.org/2000/svg';

// Rows are rebuilt wholesale on every broadcast and a row action's outcome line lives inside a row,
// so a broadcast landing mid-request is held (see radar-hold-core.mjs for the whole state machine and
// why it owns its own timer).
const _hold = createRenderHold({ render });

const _pollTicker = createPollAgoTicker(() => _root);

const CHANGE_LABEL = {
  spiking: 'spiking',
  regressed: 'regressed',
  new: 'new',
  quiet: 'quiet',
};

function formatCount(n) {
  if (!Number.isFinite(n)) return '0';
  return String(n);
}

function occurrenceHistoryValues(history) {
  if (!Array.isArray(history)) return [];
  return history
    .map((entry) => {
      if (typeof entry === 'number' && Number.isFinite(entry)) return entry;
      return Number(entry?.occurrences);
    })
    .filter((value) => Number.isFinite(value));
}

function projectsOf(snapshot) {
  return Array.isArray(snapshot?.projects) ? snapshot.projects : [];
}

function issueReportId(issue) {
  return typeof issue?.issueId === 'string' ? issue.issueId : '';
}

function openIssueReport(issue) {
  const issueId = issueReportId(issue);
  if (!issueId) return;
  sendControlRequest('get-posthog-report', { issueId })
    .then((msg) => {
      if (!msg.ok) {
        createPosthogReportDialog({ issueId, issueTitle: issue.title, error: msg.error || 'Could not read report' });
        return;
      }
      if (!msg.found) {
        createPosthogReportDialog({ issueId, issueTitle: issue.title, message: msg.message || 'Report not found' });
        return;
      }
      createPosthogReportDialog({ issueId, issueTitle: issue.title, format: msg.format, content: msg.content || '' });
    })
    .catch((err) => {
      createPosthogReportDialog({ issueId, issueTitle: issue.title, error: err?.message || 'Could not read report' });
    });
}

// Per-row actions, shared by the issue rows and the investigations inbox. Labels are constant for the
// control's whole lifecycle (no "Resolving...", no counts): the sibling status line carries progress
// and outcome, and every button is disabled while a request is in flight so a row cannot be
// double-fired.
function createActionCluster() {
  const wrap = el('div', 'radar-issue-actions');
  const status = el('span', 'radar-issue-action-status');
  status.setAttribute('role', 'status');
  wrap.append(status);
  const buttons = [];

  const setBusy = (busy) => {
    for (const button of buttons) button.disabled = busy;
  };

  const addButton = (label, title, onClick) => {
    const button = el('button', 'radar-issue-action', label);
    button.type = 'button';
    button.title = title;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    buttons.push(button);
    wrap.insertBefore(button, status);
    return button;
  };

  const request = (token, type, payload, pendingText, describe) => {
    _hold.begin(token);
    setBusy(true);
    status.dataset.tone = 'busy';
    status.textContent = pendingText;
    const settle = (tone, text) => {
      setBusy(false);
      status.dataset.tone = tone;
      status.textContent = text;
      _hold.settle(token);
    };
    const resolved = (msg) => {
      if (!msg.ok) {
        settle('error', msg.error || 'Request failed');
        return;
      }
      settle('ok', describe(msg));
    };
    sendControlRequest(type, payload)
      .then(resolved)
      .catch((err) => settle('error', err?.message || 'Request failed'));
  };

  return { addButton, request, wrap };
}

function buildIssueActions(issue, projectId) {
  const { addButton, request, wrap } = createActionCluster();

  const run = (type, payload, pendingText, describe) => request(
    `${type}:${issue.issueId}`,
    type,
    { projectId, issueId: issue.issueId, ...payload },
    pendingText,
    describe,
  );

  addButton('Open session', 'Paste an investigation prompt into the mapped project session', () => {
    run('posthog-open-session', {}, 'Opening session', (msg) => (
      msg.pending
        ? `Starting ${msg.sessionName || 'session'}; the prompt lands when it is up`
        : `Prompt pasted into ${msg.sessionName || 'the session'}; press Enter there`
    ));
  });

  addButton('Resolve', 'Mark this issue resolved in PostHog', () => {
    run('posthog-issue-action', { action: 'resolve' }, 'Resolving in PostHog', () => 'Marked resolved');
  });
  addButton('Suppress', 'Suppress this issue in PostHog', () => {
    run('posthog-issue-action', { action: 'suppress' }, 'Suppressing in PostHog', () => 'Marked suppressed');
  });

  return wrap;
}

function buildIssueRow(issue, projectId) {
  const row = el('div', 'radar-issue');
  row.dataset.severity = severity(issue.change);

  const stripe = el('span', 'radar-stripe');
  stripe.setAttribute('aria-hidden', 'true');

  const change = el('span', 'radar-change', CHANGE_LABEL[issue.change] || String(issue.change || 'unknown'));

  // Issue titles come from a third-party service: built as text, never markup.
  const title = issue.url ? el('a', 'radar-issue-title') : el('span', 'radar-issue-title');
  title.textContent = issue.title || 'Untitled issue';
  title.title = issue.title || '';
  if (issue.url) {
    title.href = issue.url;
    title.target = '_blank';
    title.rel = 'noopener';
  }

  const occurrences = el('span', 'radar-metric');
  occurrences.append(el('span', 'radar-metric-value', formatCount(issue.occurrences)), el('span', 'radar-metric-label', 'occ'));
  const users = el('span', 'radar-metric');
  users.append(el('span', 'radar-metric-value', formatCount(issue.users)), el('span', 'radar-metric-label', 'users'));
  const historyValues = occurrenceHistoryValues(issue.history);
  const sparklinePath = sparklinePoints(historyValues, 64, 16);
  const sparkline = sparklinePath ? document.createElementNS(SVG_NS, 'svg') : null;
  if (sparkline) {
    sparkline.classList.add('radar-sparkline');
    sparkline.setAttribute('viewBox', '0 0 64 16');
    sparkline.setAttribute('width', '64');
    sparkline.setAttribute('height', '16');
    sparkline.setAttribute('aria-hidden', 'true');
    sparkline.setAttribute('focusable', 'false');
    const line = document.createElementNS(SVG_NS, 'polyline');
    line.setAttribute('points', sparklinePath);
    sparkline.append(line);
  }

  const summaryLine = typeof issue.summaryLine === 'string' ? issue.summaryLine.trim() : '';
  const titleWrap = el('span', 'radar-issue-copy');
  titleWrap.append(title);
  if (summaryLine) {
    const summary = el('span', 'radar-issue-summary');
    summary.textContent = summaryLine;
    titleWrap.append(summary);
  }

  row.append(stripe, change, titleWrap);
  if (sparkline) row.append(sparkline);
  row.append(occurrences, users);

  if (issue.inFlight) {
    const chip = el('span', 'radar-verdict', 'investigating');
    chip.dataset.verdict = 'INVESTIGATING';
    row.append(chip);
  }
  if (!issue.inFlight && issue.verdict) {
    const chip = el('span', 'radar-verdict', verdictLabel(issue.verdict));
    chip.dataset.verdict = issue.verdict;
    row.append(chip);
    if (issueReportId(issue)) {
      row.classList.add('radar-issue-reportable');
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', `View investigation report for ${issue.title || issue.issueId}`);
      row.title = 'View investigation report';
      row.addEventListener('click', (event) => {
        // The action buttons live inside the row, so a click on one must not also open the report.
        if (event.target.closest('a, button')) return;
        openIssueReport(issue);
      });
      row.addEventListener('keydown', (event) => {
        if (event.target !== row) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openIssueReport(issue);
      });
    }
  }
  if (issueReportId(issue)) row.append(buildIssueActions(issue, projectId));
  return row;
}

function summaryStat(label, value, tone) {
  const wrap = el('span', 'radar-stat');
  if (tone) wrap.dataset.tone = tone;
  wrap.append(el('span', 'radar-stat-value', value), el('span', 'radar-stat-label', label));
  return wrap;
}

// The only per-project time still rendered, and only for the projects that earned a card by being
// stale or errored: the section's one global clock covers the healthy case.
function alertTextOf(entry) {
  if (entry.error) return `poll failed: ${entry.error}`;
  if (entry.staleMs > 0) return `stale ${formatDuration(entry.staleMs)}`;
  return '';
}

// Project names come from PostHog: text only, never markup; title tooltip keeps the raw value reachable.
function appendProjectLabel(parent, project, { showHost, nameTag, nameClass, hostClass }) {
  const name = el(nameTag, nameClass, radarDisplayName(project));
  name.title = project.name || '';
  parent.append(name);
  const host = showHost ? shortHost(project.host) : '';
  if (host) parent.append(el('span', hostClass, host));
}

function buildProject(entry, showHost) {
  const project = entry.project;
  const wrap = el('div', 'radar-project');
  const issues = sortIssuesByAttention(project.issues);
  const counts = summarizeIssues(issues);

  const head = el('div', 'radar-project-head');
  appendProjectLabel(head, project, { showHost, nameTag: 'h3', nameClass: 'radar-project-name', hostClass: 'radar-project-host' });
  wrap.append(head);

  const summary = el('div', 'radar-project-summary');
  summary.append(summaryStat(counts.active === 1 ? 'active issue' : 'active issues', formatCount(counts.active)));
  summary.append(summaryStat('spiking', formatCount(counts.spiking), counts.spiking > 0 ? 'crit' : null));
  const alertText = alertTextOf(entry);
  if (alertText) {
    const alert = el('span', 'radar-project-alert', alertText);
    alert.dataset.tone = entry.error ? 'crit' : 'warn';
    summary.append(alert);
  }
  wrap.append(summary);

  if (issues.length === 0) return wrap;
  const list = el('div', 'radar-issues');
  for (const issue of issues) list.append(buildIssueRow(issue, project.projectId));
  wrap.append(list);
  return wrap;
}

// One row per healthy project, in one bordered block: a state dot, the name, and the count. No host,
// no clock, no "No tracked issues." - the row's existence already says the project is being watched.
function buildQuietRow(entry, showHost) {
  const project = entry.project;
  const row = el('div', 'radar-quiet-row');
  const dot = el('span', 'radar-quiet-dot');
  dot.setAttribute('aria-hidden', 'true');
  row.append(dot);
  appendProjectLabel(row, project, { showHost, nameTag: 'span', nameClass: 'radar-quiet-name', hostClass: 'radar-quiet-host' });
  row.append(el('span', 'radar-quiet-count', '0 issues'));
  return row;
}

function attentionCount() {
  return radarAttentionCount({ posthog: _latest, health: _health, prs: _prs });
}

function buildSection(title, hint) {
  const section = el('section', 'radar-section');
  const head = el('div', 'radar-section-head');
  head.append(el('h2', 'radar-section-title', title));
  if (hint) head.append(el('span', 'radar-section-hint', hint));
  section.append(head);
  return section;
}

function buildErrorsSection(projects) {
  const section = buildSection('Errors');
  if (projects.length === 0) {
    section.append(el('p', 'radar-unconfigured', radarPlaceholder(_latest)));
    return section;
  }
  const globalTickEl = el('div', 'radar-global-tick');
  _pollTicker.track(globalTickEl, _latest?.ts);
  section.append(globalTickEl);
  const intervalMs = Number(_latest?.intervalMinutes) > 0 ? Number(_latest.intervalMinutes) * 60000 : 0;
  const { loud, quiet } = partitionRadarProjects(projects, Date.now(), { intervalMs });
  const showHost = hostsDiffer(projects);
  for (const entry of loud) section.append(buildProject(entry, showHost));
  if (quiet.length === 0) return section;
  const quietBlock = el('div', 'radar-quiet');
  for (const entry of quiet) quietBlock.append(buildQuietRow(entry, showHost));
  section.append(quietBlock);
  return section;
}

// ── Investigations inbox ─────────────────────────────────────
// One row per completed investigation. Deliberately independent of the Errors section: a
// resolved issue's row is gone from there, and this is where its verdict survives. Quiet review
// material by design, so it contributes nothing to the attention count.
function buildInvestigationActions(row) {
  const { addButton, request, wrap } = createActionCluster();

  if (row.issueId) {
    addButton('Open report', 'Open the investigation report for this issue', () => {
      openIssueReport({ issueId: row.issueId, title: row.title });
    });
  }
  addButton('Archive', 'Remove this investigation from the inbox', () => {
    request(
      `archive:${row.id}`,
      'posthog-archive-investigation',
      { id: row.id },
      'Archiving',
      () => 'Archived',
    );
  });

  return wrap;
}

function buildInvestigationRow(row) {
  const item = el('div', 'radar-investigation');

  const verdict = el('span', 'radar-verdict', verdictLabel(row.verdict));
  verdict.dataset.verdict = row.verdict;

  // Titles and summaries come from a third-party service and a headless agent: text, never markup.
  const title = row.url ? el('a', 'radar-issue-title') : el('span', 'radar-issue-title');
  title.textContent = row.title;
  title.title = row.title;
  if (row.url) {
    title.href = row.url;
    title.target = '_blank';
    title.rel = 'noopener';
  }

  const copy = el('span', 'radar-issue-copy');
  copy.append(title);
  if (row.summaryLine) {
    const summary = el('span', 'radar-issue-summary');
    summary.textContent = row.summaryLine;
    copy.append(summary);
  }
  // An auto-fix job's durable output. The url is validated in radar-core, so an absent one means the
  // job opened no pull request rather than that the link was dropped.
  if (row.prUrl) {
    const pr = el('a', 'radar-investigation-pr', 'fix PR');
    pr.href = row.prUrl;
    pr.target = '_blank';
    pr.rel = 'noopener';
    pr.title = row.prUrl;
    copy.append(pr);
  }

  item.append(verdict);
  // Which job produced this row. Only the fix lane is tagged: an investigation is the default job and
  // labelling every row with it would say nothing.
  if (row.mode === 'fix') {
    const mode = el('span', 'radar-verdict', 'fix');
    mode.dataset.mode = 'fix';
    item.append(mode);
  }
  item.append(copy);
  if (row.projectLabel) {
    const project = el('span', 'radar-investigation-project');
    project.textContent = row.projectLabel;
    item.append(project);
  }
  if (row.at > 0) {
    const when = el('span', 'radar-investigation-time', formatAgo(row.at));
    when.title = new Date(row.at).toLocaleString();
    item.append(when);
  }
  item.append(buildInvestigationActions(row));
  return item;
}

function buildInvestigationsSection(rows) {
  const section = buildSection('Investigations', 'completed, not yet archived');
  const list = el('div', 'radar-investigations');
  for (const row of rows) list.append(buildInvestigationRow(row));
  section.append(list);
  return section;
}

function buildOpsSection(rows) {
  const section = buildSection('Ops');
  const list = el('div', 'radar-ops');
  for (const row of rows) {
    const item = el('div', 'radar-ops-row');
    item.dataset.tone = row.tone;
    const stripe = el('span', 'radar-stripe');
    stripe.setAttribute('aria-hidden', 'true');
    item.append(stripe, el('span', 'radar-ops-text', row.text));
    // The update command is copy-pasteable text, exactly as the banner shows it; Radar mirrors the
    // notice quietly rather than owning a second copy button for it.
    if (row.detail) item.append(el('code', 'radar-ops-detail', row.detail));
    list.append(item);
  }
  section.append(list);
  return section;
}

function openPrsView() {
  if (!_navigateToPrs) return;
  _navigateToPrs();
}

function buildPrRow(row) {
  const item = el('div', 'radar-pr-row');
  item.dataset.severity = row.severity;
  const stripe = el('span', 'radar-stripe');
  stripe.setAttribute('aria-hidden', 'true');
  const { label: phaseText } = phaseLabel(row.phase);
  const numbered = row.number === null ? row.title : `#${row.number} ${row.title}`;
  // Titles and repo slugs come from GitHub: built as text, never markup.
  const title = el('span', 'radar-pr-title');
  title.textContent = numbered;
  title.title = numbered;
  item.append(stripe, el('span', 'radar-pr-phase', phaseText), title, el('span', 'radar-pr-repo', row.projectLabel));

  item.tabIndex = 0;
  item.setAttribute('role', 'button');
  item.setAttribute('aria-label', `Open the pull requests view for ${numbered}`);
  item.title = row.reason || 'Open the pull requests view';
  item.addEventListener('click', () => openPrsView());
  item.addEventListener('keydown', (event) => {
    if (event.target !== item) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openPrsView();
  });
  return item;
}

function buildPrsSection(rows) {
  const section = buildSection('Pull requests', 'needing action');
  const list = el('div', 'radar-prs');
  for (const row of rows) list.append(buildPrRow(row));
  section.append(list);
  return section;
}

function render() {
  if (!_root) return;
  _root.textContent = '';
  _pollTicker.reset();
  const projects = projectsOf(_latest);
  const investigations = investigationRows(_latest);
  const ops = opsRows({ update: _update, health: _health });
  const prs = needsActionPrRows(_prs);
  // Nothing configured anywhere: the bare hint, with no section chrome to make an empty board look
  // like a broken one.
  if (projects.length === 0 && investigations.length === 0 && ops.length === 0 && prs.length === 0) {
    _root.append(el('p', 'radar-unconfigured', radarPlaceholder(_latest)));
    return;
  }
  _root.append(buildErrorsSection(projects));
  if (investigations.length > 0) _root.append(buildInvestigationsSection(investigations));
  if (ops.length > 0) _root.append(buildOpsSection(ops));
  if (prs.length > 0) _root.append(buildPrsSection(prs));
}

// Every feed repaints through here, so an in-flight per-issue action still holds the board: a health
// snapshot landing mid-request must not wipe an outcome line either.
function renderOrDefer() {
  _hold.request();
}

function refreshActivity() {
  if (!_activityCallback) return;
  _activityCallback(attentionCount() > 0);
}

// The tab-activity seam (defined in pr-panel.js): the view owns the condition, app.js owns the dot element.
// The condition is now the FULL Radar attention count (issues + live anomalies + needs-action PRs),
// so the desktop tab dot and the phone More dot, which both hang off this one callback, agree.
export function setRadarActivityCallback(callback) {
  _activityCallback = callback;
  refreshActivity();
}

// A PR row is a pointer, not a second PR view: app.js owns the navigation (desktop tab vs phone
// screen), Radar only knows that the operator asked to go there.
export function setRadarNavigateToPrs(navigate) {
  _navigateToPrs = navigate;
}

export function mountRadarView(parent) {
  if (_root) return _root;
  const root = el('div', 'radar-content');
  parent.appendChild(root);
  _root = root;
  _pollTicker.ensure();
  render();
  return root;
}

export function applyPosthogStatus(msg) {
  _latest = msg;
  renderOrDefer();
  refreshActivity();
}

// A health snapshot lands every ten seconds; only a change in which anomalies are live is worth a
// repaint, and an all-zero snapshot renders nothing at all.
export function applyHealthSnapshot(stats) {
  _health = stats;
  const key = healthAnomalyRows(stats).map((row) => row.key).join(',');
  if (key === _healthKey) return;
  _healthKey = key;
  renderOrDefer();
  refreshActivity();
}

export function applyUpdateAvailable(msg) {
  _update = msg;
  renderOrDefer();
}

export function applyPrStatus(msg) {
  _prs = msg;
  renderOrDefer();
  refreshActivity();
}
