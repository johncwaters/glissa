import type { ServerMessage } from '#shared/contracts/control-messages.ts';
import { createAttentionAck } from './attention-ack-core.ts';
import { buildPanelSection, buildStatChip, el, externalLink, isPanelHidden, projectsOf } from './dom-helpers.ts';
import { createInvestigationDialog, createPosthogReportDialog } from './dialogs.ts';
import type { InvestigationDialog } from './dialogs.ts';
import { sendControlRequest } from './control-ws.ts';
import { createPollAgoTicker, formatAgo, formatDuration } from './poll-ago.ts';
import { phaseLabel } from './pr-view-core.ts';
import { createRenderHold } from './radar-hold-core.ts';
import { createSettingsLink } from './settings-link.ts';
import { getRadarAttentionAck, setRadarAttentionAck } from './ui-prefs.ts';
import {
  applyInvestigationActivity as patchInvestigationActivity,
  applyInvestigationFinished as patchInvestigationFinished,
  finishedViewOf,
  isOpenInvestigationFrame,
  findIssueInSnapshot,
  healthAnomalyRows,
  hostsDiffer,
  investigationRows,
  investigationViewOf,
  issueSummaryText,
  retainKnownInvestigationIds,
  needsActionPrRows,
  opsRows,
  partitionRadarProjects,
  radarAttentionSignature,
  radarDisplayName,
  radarPlaceholder,
  severityFor as severity,
  shortHost,
  sortIssuesByAttention,
  sparklinePoints,
  summarizeIssues,
  verdictLabel,
} from './radar-core.ts';
import type { InvestigationActivityFrame, InvestigationFinishedFrame, RadarHealthFeed, RadarIssue, RadarProject, RadarProjectAlert, RadarSnapshot, RadarUpdateFeed } from './radar-core.ts';
import type { PrStatusSnapshot } from './pr-view-core.ts';

interface RadarSnapshotWithClock extends RadarSnapshot {
  ts?: number;
  intervalMinutes?: unknown;
}

type RadarProjectEntry = RadarProjectAlert & { project: RadarProject };

interface InvestigationRow {
  id: string;
  issueId: string;
  projectLabel: string;
  title: string;
  summaryLine: string;
  url: string;
  verdict: string;
  mode: string;
  prUrl: string;
  at: number;
}

let _latest: RadarSnapshotWithClock | null = null;
let _health: RadarHealthFeed | null = null;

let _healthKey = '';
let _update: RadarUpdateFeed | null = null;
let _prs: PrStatusSnapshot | null = null;
let _root: HTMLDivElement | null = null;
let _activityCallback: ((unseen: boolean) => void) | null = null;
let _navigateToPrs: (() => void) | null = null;
const SVG_NS = 'http://www.w3.org/2000/svg';
const _attention = createAttentionAck({
  getAck: getRadarAttentionAck,
  setAck: setRadarAttentionAck,
  signature: () => radarAttentionSignature({ posthog: _latest, health: _health }),
  isLooking: () => !isPanelHidden(_root),
});

const _hold = createRenderHold({ render });

const _archivedLocally = new Set<string>();

let _openInvestigation: { projectId: string; issueId: string; dialog: InvestigationDialog } | null = null;

const _issueRows = new Map<string, { copy: HTMLElement; summary: HTMLElement | null }>();

const _pollTicker = createPollAgoTicker(() => _root);

const CHANGE_LABEL: Record<string, string> = {
  spiking: 'spiking',
  regressed: 'regressed',
  worsened: 'worsened',
  new: 'new',
  quiet: 'quiet',
};

function formatCount(n: unknown) {
  if (!Number.isFinite(n)) return '0';
  return String(n);
}

function occurrenceHistoryValues(history: unknown): number[] {
  if (!Array.isArray(history)) return [];
  return (history as unknown[])
    .map((entry) => {
      if (typeof entry === 'number' && Number.isFinite(entry)) return entry;
      return Number((entry as { occurrences?: unknown } | null | undefined)?.occurrences);
    })
    .filter((value) => Number.isFinite(value));
}

function issueReportId(issue: { issueId?: unknown } | null | undefined) {
  return typeof issue?.issueId === 'string' ? issue.issueId : '';
}

function issueRowKey(projectId: unknown, issueId: unknown) {
  return [String(projectId ?? ''), String(issueId ?? '')].join('::');
}

function patchIssueRowSummary(projectId: unknown, issueId: unknown, issue: RadarIssue | null) {
  const handle = _issueRows.get(issueRowKey(projectId, issueId));
  if (!handle || !handle.copy.isConnected) return false;
  const text = issueSummaryText(issue);
  if (!text) {
    handle.summary?.remove();
    handle.summary = null;
    return true;
  }
  if (!handle.summary) {
    handle.summary = el('span', 'radar-issue-summary');
    handle.copy.append(handle.summary);
  }
  handle.summary.textContent = text;
  return true;
}

function openInvestigationView(issue: RadarIssue, projectId: unknown, projectLabel: string) {
  const issueId = issueReportId(issue);
  if (!issueId) return;
  _openInvestigation?.dialog.close();
  const dialog = createInvestigationDialog({
    issueTitle: String(issue.title || issueId),
    projectLabel,
    onOpenReport: () => openIssueReport(issue),
  });
  _openInvestigation = { projectId: String(projectId ?? ''), issueId, dialog };
  dialog.update(investigationViewOf(issue));
}

function refreshOpenInvestigation() {
  if (!_openInvestigation) return;
  if (!_openInvestigation.dialog.isOpen()) {
    _openInvestigation = null;
    return;
  }
  const issue = findIssueInSnapshot(_latest, _openInvestigation.projectId, _openInvestigation.issueId);
  if (!issue) return;
  _openInvestigation.dialog.update(investigationViewOf(issue));
}

function openIssueReport(issue: { issueId?: unknown; title?: unknown }) {
  const issueId = issueReportId(issue);
  if (!issueId) return;
  sendControlRequest('get-posthog-report', { issueId })
    .then((msg) => {
      if (!msg.ok) {
        createPosthogReportDialog({ issueId, issueTitle: String(issue.title ?? ''), error: String(msg.error || 'Could not read report') });
        return;
      }
      if (!msg.found) {
        createPosthogReportDialog({ issueId, issueTitle: String(issue.title ?? ''), message: String(msg.message || 'Report not found') });
        return;
      }
      createPosthogReportDialog({ issueId, issueTitle: String(issue.title ?? ''), format: String(msg.format ?? ''), content: String(msg.content || '') });
    })
    .catch((err: unknown) => {
      createPosthogReportDialog({ issueId, issueTitle: String(issue.title ?? ''), error: String((err as Error | null)?.message || 'Could not read report') });
    });
}

function createActionCluster() {
  const wrap = el('div', 'radar-issue-actions');
  const status = el('span', 'radar-issue-action-status');
  status.setAttribute('role', 'status');
  wrap.append(status);
  const buttons: HTMLButtonElement[] = [];

  const setBusy = (busy: boolean) => {
    for (const button of buttons) button.disabled = busy;
  };

  const addButton = (label: string, title: string, onClick: () => void) => {
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

  const request = (
    token: string,
    type: string,
    payload: Record<string, unknown>,
    pendingText: string,
    describe: (message: ServerMessage) => string,
    onOk: ((message: ServerMessage) => void) | null = null,
  ) => {
    _hold.begin(token);
    setBusy(true);
    status.dataset.tone = 'busy';
    status.textContent = pendingText;
    const settle = (tone: string, text: string) => {
      setBusy(false);
      status.dataset.tone = tone;
      status.textContent = text;
      _hold.settle(token);
    };
    const resolved = (msg: ServerMessage) => {
      if (!msg.ok) {
        settle('error', String(msg.error || 'Request failed'));
        return;
      }
      if (onOk) onOk(msg);
      settle('ok', describe(msg));
    };
    sendControlRequest(type, payload)
      .then(resolved)
      .catch((err: unknown) => settle('error', String((err as Error | null)?.message || 'Request failed')));
  };

  return { addButton, request, wrap };
}

function buildIssueActions(issue: RadarIssue, projectId: unknown, projectLabel: string) {
  const { addButton, request, wrap } = createActionCluster();

  const run = (type: string, payload: Record<string, unknown>, pendingText: string, describe: (message: ServerMessage) => string) => request(
    `${type}:${issue.issueId}`,
    type,
    { projectId, issueId: issue.issueId, ...payload },
    pendingText,
    describe,
  );

  if (issue.inFlight) {
    addButton('View investigation', 'Watch the running investigation', () => openInvestigationView(issue, projectId, projectLabel));
  }
  if (!issue.inFlight) {
    addButton('Open session', 'Paste an investigation prompt into the mapped project session', () => {
      run('posthog-open-session', {}, 'Opening session', (msg) => (
        msg.pending
          ? `Starting ${String(msg.sessionName || 'session')}; the prompt lands when it is up`
          : `Prompt pasted into ${String(msg.sessionName || 'the session')}; press Enter there`
      ));
    });
  }

  addButton('Resolve', 'Mark this issue resolved in PostHog', () => {
    run('posthog-issue-action', { action: 'resolve' }, 'Resolving in PostHog', () => 'Marked resolved');
  });
  addButton('Suppress', 'Suppress this issue in PostHog', () => {
    run('posthog-issue-action', { action: 'suppress' }, 'Suppressing in PostHog', () => 'Marked suppressed');
  });

  return wrap;
}

function makeRowOpenable(row: HTMLDivElement, label: string, open: () => void) {
  row.classList.add('radar-issue-reportable');
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.setAttribute('aria-label', label);
  row.title = label;
  row.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest('a, button')) return;
    open();
  });
  row.addEventListener('keydown', (event) => {
    if (event.target !== row) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    open();
  });
}

function buildIssueRow(issue: RadarIssue, projectId: unknown, projectLabel: string) {
  const row = el('div', 'radar-issue');
  row.dataset.severity = severity(issue.change);

  const stripe = el('span', 'radar-stripe');
  stripe.setAttribute('aria-hidden', 'true');

  const change = el('span', 'radar-change', CHANGE_LABEL[issue.change ?? ''] || String(issue.change || 'unknown'));

  const title = externalLink('radar-issue-title', String(issue.title || 'Untitled issue'), issue.url as string | null | undefined, String(issue.title || ''));

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

  const summaryText = issueSummaryText(issue);
  const titleWrap = el('span', 'radar-issue-copy');
  titleWrap.append(title);
  let summary: HTMLElement | null = null;
  if (summaryText) {
    summary = el('span', 'radar-issue-summary');
    summary.textContent = summaryText;
    titleWrap.append(summary);
  }
  _issueRows.set(issueRowKey(projectId, issue.issueId), { copy: titleWrap, summary });

  row.append(stripe, change, titleWrap);
  if (sparkline) row.append(sparkline);
  row.append(occurrences, users);

  const issueName = String(issue.title || issue.issueId);
  if (issue.inFlight) {
    const chip = el('span', 'radar-verdict', 'investigating');
    chip.dataset.verdict = 'INVESTIGATING';
    row.append(chip);
    if (issueReportId(issue)) {
      makeRowOpenable(row, `Watch the investigation of ${issueName}`, () => openInvestigationView(issue, projectId, projectLabel));
    }
  }
  if (!issue.inFlight && issue.verdict) {
    const chip = el('span', 'radar-verdict', verdictLabel(issue.verdict));
    chip.dataset.verdict = issue.verdict;
    row.append(chip);
    if (issueReportId(issue)) {
      makeRowOpenable(row, `View investigation report for ${issueName}`, () => openIssueReport(issue));
    }
  }
  if (issueReportId(issue)) row.append(buildIssueActions(issue, projectId, projectLabel));
  return row;
}

const summaryStat = (label: string, value: string, tone?: string | null) => buildStatChip('radar', label, value, tone);

function alertTextOf(entry: RadarProjectEntry) {
  if (entry.error) return `poll failed: ${entry.error}`;
  if (entry.staleMs > 0) return `stale ${formatDuration(entry.staleMs)}`;
  return '';
}

function appendProjectLabel(
  parent: HTMLElement,
  project: RadarProject,
  { showHost, nameTag, nameClass, hostClass }: { showHost: boolean; nameTag: 'h3' | 'span'; nameClass: string; hostClass: string }
) {
  const name = el(nameTag, nameClass, radarDisplayName(project));
  name.title = String(project.name || '');
  parent.append(name);
  const host = showHost ? shortHost(project.host) : '';
  if (host) parent.append(el('span', hostClass, host));
}

function buildProject(entry: RadarProjectEntry, showHost: boolean) {
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
  for (const issue of issues) list.append(buildIssueRow(issue, project.projectId, radarDisplayName(project)));
  wrap.append(list);
  return wrap;
}

function buildQuietRow(entry: RadarProjectEntry, showHost: boolean) {
  const project = entry.project;
  const row = el('div', 'radar-quiet-row');
  const dot = el('span', 'radar-quiet-dot');
  dot.setAttribute('aria-hidden', 'true');
  row.append(dot);
  appendProjectLabel(row, project, { showHost, nameTag: 'span', nameClass: 'radar-quiet-name', hostClass: 'radar-quiet-host' });
  row.append(el('span', 'radar-quiet-count', '0 issues'));
  return row;
}

const buildSection = (title: string, hint?: string | null) => buildPanelSection('radar', title, hint);

function buildErrorsSection(projects: RadarProject[]) {
  const section = buildSection('Errors');
  if (projects.length === 0) {
    section.append(el('p', 'radar-unconfigured', radarPlaceholder(_latest)));
    return section;
  }
  const globalTickEl = el('div', 'radar-global-tick');
  _pollTicker.track(globalTickEl, _latest?.ts);
  section.append(globalTickEl);
  const intervalMinutes = _latest?.intervalMinutes;
  const intervalMs = Number(intervalMinutes) > 0 ? Number(intervalMinutes) * 60000 : 0;
  const { loud, quiet } = partitionRadarProjects(projects, Date.now(), { intervalMs });
  const showHost = hostsDiffer(projects);
  for (const entry of loud) section.append(buildProject(entry, showHost));
  if (quiet.length === 0) return section;
  const quietBlock = el('div', 'radar-quiet');
  for (const entry of quiet) quietBlock.append(buildQuietRow(entry, showHost));
  section.append(quietBlock);
  return section;
}

function buildInvestigationActions(row: InvestigationRow) {
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
      () => _archivedLocally.add(row.id),
    );
  });

  return wrap;
}

function buildInvestigationRow(row: InvestigationRow) {
  const item = el('div', 'radar-investigation');

  const verdict = el('span', 'radar-verdict', verdictLabel(row.verdict));
  verdict.dataset.verdict = row.verdict;

  const title = externalLink('radar-issue-title', row.title, row.url);

  const copy = el('span', 'radar-issue-copy');
  copy.append(title);
  if (row.summaryLine) {
    const summary = el('span', 'radar-issue-summary');
    summary.textContent = row.summaryLine;
    copy.append(summary);
  }

  if (row.prUrl) {
    const pr = el('a', 'radar-investigation-pr', 'fix PR');
    pr.href = row.prUrl;
    pr.target = '_blank';
    pr.rel = 'noopener';
    pr.title = row.prUrl;
    copy.append(pr);
  }

  item.append(verdict);

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

function buildInvestigationsSection(rows: InvestigationRow[]) {
  const section = buildSection('Investigations', 'completed, not yet archived');
  const list = el('div', 'radar-investigations');
  for (const row of rows) list.append(buildInvestigationRow(row));
  section.append(list);
  return section;
}

function buildOpsSection(rows: { kind: string; key: string; text: string; detail: string; tone: string }[]) {
  const section = buildSection('Ops');
  const list = el('div', 'radar-ops');
  for (const row of rows) {
    const item = el('div', 'radar-ops-row');
    item.dataset.tone = row.tone;
    const stripe = el('span', 'radar-stripe');
    stripe.setAttribute('aria-hidden', 'true');
    item.append(stripe, el('span', 'radar-ops-text', row.text));

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

function buildPrRow(row: { severity: string; phase: string; number: number | null; title: string; projectLabel: string; reason: string }) {
  const item = el('div', 'radar-pr-row');
  item.dataset.severity = row.severity;
  const stripe = el('span', 'radar-stripe');
  stripe.setAttribute('aria-hidden', 'true');
  const { label: phaseText } = phaseLabel(row.phase);
  const numbered = row.number === null ? row.title : `#${row.number} ${row.title}`;

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

function buildPrsSection(rows: { severity: string; phase: string; number: number | null; title: string; projectLabel: string; reason: string }[]) {
  const section = buildSection('Pull requests', 'needing action');
  const list = el('div', 'radar-prs');
  for (const row of rows) list.append(buildPrRow(row));
  section.append(list);
  return section;
}

function render() {
  if (!_root) return;
  _root.textContent = '';
  _issueRows.clear();
  _pollTicker.reset();
  const projects = projectsOf<RadarProject>(_latest);
  const investigations = investigationRows(_latest, _archivedLocally);
  const ops = opsRows({ update: _update, health: _health });
  const prs = needsActionPrRows(_prs);

  if (projects.length === 0 && investigations.length === 0 && ops.length === 0 && prs.length === 0) {
    const empty = el('p', 'radar-unconfigured', radarPlaceholder(_latest));
    const link = createSettingsLink('lanes-posthog', 'posthog-enabled', 'Enable PostHog');
    empty.append(document.createTextNode(' '), link);
    _root.append(empty);
    return;
  }
  _root.append(buildErrorsSection(projects));
  if (investigations.length > 0) _root.append(buildInvestigationsSection(investigations));
  if (ops.length > 0) _root.append(buildOpsSection(ops));
  if (prs.length > 0) _root.append(buildPrsSection(prs));
}

function renderOrDefer() {
  _hold.request();
}

function refreshActivity() {
  if (!_activityCallback) return;
  _activityCallback(_attention.refresh());
}

export function acknowledgeRadarAttention() {
  _attention.acknowledge();
  refreshActivity();
}

export function setRadarActivityCallback(callback: (unseen: boolean) => void) {
  _activityCallback = callback;
  refreshActivity();
}

export function setRadarNavigateToPrs(navigate: () => void) {
  _navigateToPrs = navigate;
}

export function mountRadarView(parent: HTMLElement) {
  if (_root) return _root;
  const root = el('div', 'radar-content');
  parent.appendChild(root);
  _root = root;
  _pollTicker.ensure();
  render();
  return root;
}

export function applyPosthogStatus(msg: unknown) {
  _latest = msg as RadarSnapshotWithClock;

  retainKnownInvestigationIds(_latest, _archivedLocally);
  renderOrDefer();
  refreshActivity();
  refreshOpenInvestigation();
}

export function applyInvestigationActivity(msg: unknown) {
  const frame = msg as InvestigationActivityFrame;
  const wasInFlight = findIssueInSnapshot(_latest, frame.projectId, frame.issueId)?.inFlight === true;
  if (!patchInvestigationActivity(_latest, frame)) return;
  refreshOpenInvestigation();
  const issue = findIssueInSnapshot(_latest, frame.projectId, frame.issueId);
  if (wasInFlight && patchIssueRowSummary(frame.projectId, frame.issueId, issue)) return;
  renderOrDefer();
}

function finishOpenInvestigationFromFrame(frame: InvestigationFinishedFrame) {
  if (!_openInvestigation?.dialog.isOpen()) return;
  if (!isOpenInvestigationFrame(_openInvestigation, frame)) return;
  _openInvestigation.dialog.update(finishedViewOf(frame));
}

export function applyInvestigationFinished(msg: unknown) {
  const frame = msg as InvestigationFinishedFrame;
  if (!patchInvestigationFinished(_latest, frame)) {
    finishOpenInvestigationFromFrame(frame);
    return;
  }
  refreshOpenInvestigation();
  renderOrDefer();
  refreshActivity();
}

export function applyHealthSnapshot(stats: unknown) {
  _health = stats as RadarHealthFeed;
  const key = healthAnomalyRows(_health).map((row) => row.key).join(',');
  if (key === _healthKey) return;
  _healthKey = key;
  renderOrDefer();
  refreshActivity();
}

export function applyUpdateAvailable(msg: unknown) {
  _update = msg as RadarUpdateFeed;
  renderOrDefer();
}

export function applyPrStatus(msg: unknown) {
  _prs = msg as PrStatusSnapshot;
  renderOrDefer();
  refreshActivity();
}
