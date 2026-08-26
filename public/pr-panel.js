// ── PR review view ───────────────────────────────────────────
// Renders GitHub PR auto-review status from `pr-status` control-WS broadcasts into its own top-level
// dashboard tab. The tab is always present; only its content varies, so an operator who has not
// configured the PR lane still finds the surface and is told where to switch it on.

import { createAttentionAck } from './attention-ack-core.mjs';
import { buildStatChip, el, externalLink, isPanelHidden, projectsOf } from './dom-helpers.js';
import { phaseLabel, prAttentionSignature, prStatusPlaceholder, severityFor as severity, sortPrsByAttention, summarizePrs } from './pr-view-core.mjs';
import { createPollAgoTicker } from './poll-ago.js';
import { createSettingsLink } from './settings-link.js';
import { getPrsAttentionAck, setPrsAttentionAck } from './ui-prefs.js';

/** @typedef {{ projects?: unknown }} PrStatus */

/** @type {PrStatus|null} */
let _latest = null;
/** @type {HTMLDivElement|null} */
let _root = null;
/** @type {((isActive: boolean) => void)|null} */
let _activityCallback = null;
const _pollTicker = createPollAgoTicker(() => _root);
const _attention = createAttentionAck({
  getAck: getPrsAttentionAck,
  setAck: setPrsAttentionAck,
  signature: () => prAttentionSignature(_latest),
  isLooking: () => !isPanelHidden(_root),
});

function shortSha(sha) {
  if (typeof sha !== 'string') return '';
  return sha.slice(0, 7);
}

function buildPrRow(pr) {
  const row = el('div', 'pr-row');
  row.dataset.severity = severity(pr.phase, { inFlight: !!pr.inFlight, pingedError: !!pr.pingedError });

  const stripe = el('span', 'pr-stripe');
  stripe.setAttribute('aria-hidden', 'true');

  const { label: phaseText, known: phaseKnown } = phaseLabel(pr.phase);
  const phase = el('span', 'pr-phase', phaseText);
  if (!phaseKnown) phase.dataset.unknown = 'true';

  const label = pr.title || 'Untitled pull request';
  const numbered = Number.isFinite(pr.number) ? `#${pr.number} ${label}` : label;
  // PR titles come from GitHub: built as text, never markup.
  const title = externalLink('pr-title', numbered, pr.url);

  row.append(stripe, phase, title);

  const sha = shortSha(pr.headSha);
  if (sha) row.append(el('span', 'pr-sha', sha));
  if (pr.inFlight) row.append(el('span', 'pr-chip', 'reviewing'));
  if (pr.wasConflicting) {
    const chip = el('span', 'pr-chip', 'was conflicting');
    chip.dataset.tone = 'dim';
    row.append(chip);
  }
  const reason = typeof pr.reason === 'string' ? pr.reason.trim() : '';
  if (reason) row.append(el('div', 'pr-reason', reason));
  return row;
}

const summaryStat = (label, value, tone) => buildStatChip('pr', label, value, tone);

function buildProject(project) {
  const wrap = el('div', 'pr-project');
  const prs = sortPrsByAttention(project.prs);
  const counts = summarizePrs(prs);

  const head = el('div', 'pr-project-head');
  // Project names are operator-supplied: text only, never markup.
  head.append(el('h3', 'pr-project-name', project.name || project.projectId || 'project'));
  if (project.repoSlug) head.append(el('span', 'pr-project-repo', project.repoSlug));
  wrap.append(head);

  const summary = el('div', 'pr-project-summary');
  summary.append(summaryStat(counts.open === 1 ? 'open pr' : 'open prs', String(counts.open)));
  summary.append(summaryStat('in review', String(counts.inReview)));
  summary.append(summaryStat('errors', String(counts.errors), counts.errors > 0 ? 'crit' : null));
  const tickEl = el('span', 'pr-project-tick');
  _pollTicker.track(tickEl, project.lastTickAt);
  summary.append(tickEl);
  wrap.append(summary);

  if (prs.length === 0) {
    wrap.append(el('div', 'pr-empty', 'No open pull requests.'));
    return wrap;
  }
  const list = el('div', 'pr-rows');
  for (const pr of prs) list.append(buildPrRow(pr));
  wrap.append(list);
  return wrap;
}

function refreshActivity() {
  if (!_activityCallback) return;
  _activityCallback(_attention.refresh());
}

export function acknowledgePrAttention() {
  _attention.acknowledge();
  refreshActivity();
}

function render() {
  if (!_root) return;
  _root.textContent = '';
  _pollTicker.reset();
  const projects = projectsOf(_latest);
  if (projects.length === 0) {
    const empty = el('p', 'pr-unconfigured', prStatusPlaceholder(_latest));
    const link = createSettingsLink('lanes-unattended', 'pr-review-enabled', 'Enable PR review');
    empty.append(document.createTextNode(' '), link);
    _root.append(empty);
    return;
  }
  for (const project of projects) _root.append(buildProject(project));
}

// The tab-activity seam shared by every view that raises a dot: the view owns the condition, app.js owns the dot element.
export function setPrActivityCallback(callback) {
  _activityCallback = callback;
  refreshActivity();
}

export function mountPrView(parent) {
  if (_root) return _root;
  const root = el('div', 'pr-content');
  parent.appendChild(root);
  _root = root;
  _pollTicker.ensure();
  render();
  return root;
}

export function applyPrStatus(msg) {
  _latest = msg;
  render();
  refreshActivity();
}
