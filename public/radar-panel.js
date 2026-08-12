// ── Radar view ───────────────────────────────────────────────
// Renders PostHog issue status from `posthog-status` control-WS broadcasts into its own top-level
// dashboard tab. The tab is always present; only its content varies, so an operator who has not
// configured the PostHog lane still finds the surface and is told where to switch it on.

import { el } from './dom-helpers.js';
import { createPosthogReportDialog } from './dialogs.js';
import { sendControlRequest } from './control-ws.js';
import { createPollAgoTicker } from './poll-ago.js';
import { severityFor as severity, sortIssuesByAttention, sparklinePoints, summarizeIssues } from './radar-core.mjs';

let _latest = null;
let _root = null;
let _activityCallback = null;
// Rows are rebuilt wholesale on every posthog-status broadcast, and two of the three row actions
// force an immediate tick. Re-rendering mid-request would drop the in-flight disable (inviting a
// double fire) and wipe the outcome line the operator has not read yet, so a broadcast arriving while
// any action is outstanding is held and applied once they all settle.
const _pendingActions = new Set();
let _renderDeferred = false;
let _deferredRenderTimer = null;
// How long a settled action's outcome line survives before the held broadcast repaints the rows. Long
// enough to read one short line, short enough that the board is never meaningfully stale.
const OUTCOME_READ_MS = 4000;
const SVG_NS = 'http://www.w3.org/2000/svg';

const _pollTicker = createPollAgoTicker(() => _root);

// Armed when an action settles: the forced tick it triggered lands within a second or two, and a
// repaint the instant the outcome line appears would leave the operator with no feedback at all.
function armOutcomeHold() {
  if (_deferredRenderTimer !== null) return;
  _deferredRenderTimer = setTimeout(() => {
    _deferredRenderTimer = null;
    // Another action started inside the window; its own settle re-arms the hold.
    if (_pendingActions.size > 0) return;
    if (!_renderDeferred) return;
    _renderDeferred = false;
    render();
  }, OUTCOME_READ_MS);
}

const CHANGE_LABEL = {
  spiking: 'spiking',
  regressed: 'regressed',
  worsened: 'worsened',
  new: 'new',
  quiet: 'quiet',
};

const VERDICT_LABEL = {
  ROOT_CAUSE: 'root cause',
  NEEDS_HUMAN: 'needs you',
  TRANSIENT: 'transient',
  ERROR: 'error',
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

// Per-row actions. Labels are constant for the control's whole lifecycle (no "Resolving...", no
// counts): the sibling status line carries progress and outcome, and the buttons are disabled while
// a request is in flight so the row cannot be double-fired.
function buildIssueActions(issue, projectId) {
  const wrap = el('div', 'radar-issue-actions');
  const status = el('span', 'radar-issue-action-status');
  status.setAttribute('role', 'status');
  const buttons = [];
  // Controls that are unavailable for this row's own reasons (an investigation already running), as
  // opposed to the temporary in-flight disable. They must stay off when a request finishes.
  const permanentlyOff = new Set();

  const setBusy = (busy) => {
    for (const button of buttons) button.disabled = busy || permanentlyOff.has(button);
  };

  const run = (type, payload, pendingText, describe) => {
    const token = `${type}:${issue.issueId}`;
    _pendingActions.add(token);
    setBusy(true);
    status.dataset.tone = 'busy';
    status.textContent = pendingText;
    const settle = (tone, text) => {
      _pendingActions.delete(token);
      setBusy(false);
      status.dataset.tone = tone;
      status.textContent = text;
      armOutcomeHold();
    };
    sendControlRequest(type, { projectId, issueId: issue.issueId, ...payload })
      .then((msg) => settle(msg.ok ? 'ok' : 'error', msg.ok ? describe(msg) : (msg.error || 'Request failed')))
      .catch((err) => settle('error', err?.message || 'Request failed'));
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
    wrap.append(button);
    return button;
  };

  addButton('Open session', 'Paste an investigation prompt into the mapped project session', () => {
    run('posthog-open-session', {}, 'Opening session', (msg) => (
      msg.pending
        ? `Starting ${msg.sessionName || 'session'}; the prompt lands when it is up`
        : `Prompt pasted into ${msg.sessionName || 'the session'}; press Enter there`
    ));
  });

  // A re-run only makes sense once an investigation has already produced a verdict; while one is in
  // flight the server would refuse anyway, so the control is disabled rather than shown as bait.
  if (issue.verdict) {
    const rerun = addButton('Investigate', 'Run a fresh headless investigation for this issue', () => {
      run('posthog-reinvestigate', {}, 'Requesting investigation', () => 'Investigation started');
    });
    if (issue.inFlight) permanentlyOff.add(rerun);
    rerun.disabled = !!issue.inFlight;
  }

  addButton('Resolve', 'Mark this issue resolved in PostHog', () => {
    run('posthog-issue-action', { action: 'resolve' }, 'Resolving in PostHog', () => 'Marked resolved');
  });
  addButton('Suppress', 'Suppress this issue in PostHog', () => {
    run('posthog-issue-action', { action: 'suppress' }, 'Suppressing in PostHog', () => 'Marked suppressed');
  });

  wrap.append(status);
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
    const chip = el('span', 'radar-verdict', VERDICT_LABEL[issue.verdict] || String(issue.verdict).toLowerCase());
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

function buildProject(project) {
  const wrap = el('div', 'radar-project');
  const issues = sortIssuesByAttention(project.issues);
  const counts = summarizeIssues(issues);

  const head = el('div', 'radar-project-head');
  // Project names come from PostHog: text only, never markup.
  head.append(el('h3', 'radar-project-name', project.name || `project ${project.projectId}`));
  if (project.host) head.append(el('span', 'radar-project-host', project.host));
  wrap.append(head);

  const summary = el('div', 'radar-project-summary');
  summary.append(summaryStat(counts.active === 1 ? 'active issue' : 'active issues', formatCount(counts.active)));
  summary.append(summaryStat('spiking', formatCount(counts.spiking), counts.spiking > 0 ? 'crit' : null));
  const tickEl = el('span', 'radar-project-tick');
  _pollTicker.track(tickEl, project.lastTickAt);
  summary.append(tickEl);
  wrap.append(summary);

  if (issues.length === 0) {
    wrap.append(el('div', 'radar-empty', 'No tracked issues.'));
    return wrap;
  }
  const list = el('div', 'radar-issues');
  for (const issue of issues) list.append(buildIssueRow(issue, project.projectId));
  wrap.append(list);
  return wrap;
}

function attentionCount() {
  return projectsOf(_latest).reduce((total, project) => {
    const counts = summarizeIssues(project.issues);
    return total + counts.spiking + counts.needsHuman;
  }, 0);
}

function render() {
  if (!_root) return;
  _root.textContent = '';
  _pollTicker.reset();
  const projects = projectsOf(_latest);
  if (projects.length === 0) {
    _root.append(el('p', 'radar-unconfigured', 'PostHog monitoring is not configured, or has not ticked yet. Open Settings and its PostHog tab to set it up.'));
    return;
  }
  const globalTickEl = el('div', 'radar-global-tick');
  _pollTicker.track(globalTickEl, _latest?.ts);
  _root.append(globalTickEl);
  for (const project of projects) _root.append(buildProject(project));
}

// Mirrors the Teams tab's activity seam: the view owns the condition, app.js owns the dot element.
export function setRadarActivityCallback(callback) {
  _activityCallback = callback;
  if (_activityCallback) _activityCallback(attentionCount() > 0);
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
  const actionInProgress = _pendingActions.size > 0 || _deferredRenderTimer !== null;
  if (actionInProgress) _renderDeferred = true;
  if (!actionInProgress) render();
  if (_activityCallback) _activityCallback(attentionCount() > 0);
}
