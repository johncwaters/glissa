// ── Radar view ───────────────────────────────────────────────
// Renders PostHog issue status from `posthog-status` control-WS broadcasts into its own top-level
// dashboard tab. The tab is always present; only its content varies, so an operator who has not
// configured the PostHog lane still finds the surface and is told where to switch it on.

import { el } from './dom-helpers.js';
import { createPosthogReportDialog } from './dialogs.js';
import { sendControlRequest } from './control-ws.js';
import { createPollAgoTicker } from './poll-ago.js';
import { severityFor as severity, sortIssuesByAttention, summarizeIssues } from './radar-core.mjs';

let _latest = null;
let _root = null;
let _activityCallback = null;
const _pollTicker = createPollAgoTicker(() => _root);

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
      createPosthogReportDialog({ issueId, issueTitle: issue.title, content: msg.content || '' });
    })
    .catch((err) => {
      createPosthogReportDialog({ issueId, issueTitle: issue.title, error: err?.message || 'Could not read report' });
    });
}

function buildIssueRow(issue) {
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

  row.append(stripe, change, title, occurrences, users);

  if (issue.inFlight) {
    const chip = el('span', 'radar-verdict', 'investigating');
    chip.dataset.verdict = 'INVESTIGATING';
    row.append(chip);
    return row;
  }
  if (issue.verdict) {
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
        if (event.target.closest('a')) return;
        openIssueReport(issue);
      });
      row.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openIssueReport(issue);
      });
    }
  }
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
  for (const issue of issues) list.append(buildIssueRow(issue));
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
  render();
  if (_activityCallback) _activityCallback(attentionCount() > 0);
}
