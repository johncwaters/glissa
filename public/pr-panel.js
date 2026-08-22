// ── PR review view ───────────────────────────────────────────
// Renders GitHub PR auto-review status from `pr-status` control-WS broadcasts into its own top-level
// dashboard tab. The tab is always present; only its content varies, so an operator who has not
// configured the PR lane still finds the surface and is told where to switch it on.

import { decideAttention } from './attention-ack-core.mjs';
import { buildStatChip, el, isPanelHidden, projectsOf } from './dom-helpers.js';
import { phaseLabel, prAttentionSignature, prStatusPlaceholder, severityFor as severity, sortPrsByAttention, summarizePrs } from './pr-view-core.mjs';
import { createPollAgoTicker } from './poll-ago.js';
import { getPrsAttentionAck, setPrsAttentionAck } from './ui-prefs.js';

let _latest = null;
let _root = null;
let _activityCallback = null;
let _ack = getPrsAttentionAck();
const _pollTicker = createPollAgoTicker(() => _root);

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

  // PR titles come from GitHub: built as text, never markup.
  const title = pr.url ? el('a', 'pr-title') : el('span', 'pr-title');
  const label = pr.title || 'Untitled pull request';
  const numbered = Number.isFinite(pr.number) ? `#${pr.number} ${label}` : label;
  title.textContent = numbered;
  title.title = numbered;
  if (pr.url) {
    title.href = pr.url;
    title.target = '_blank';
    title.rel = 'noopener';
  }

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

function storeAck(signature) {
  if (signature === _ack) return;
  _ack = signature;
  setPrsAttentionAck(signature);
}

// A broken PR that arrives while the panel is on screen is already being looked at, so it acknowledges
// itself rather than lighting a dot over the surface showing it (the rule navigator-panel.js applies to
// its own unseen latch).
function refreshActivity() {
  if (!_activityCallback) return;
  const signature = prAttentionSignature(_latest);
  const decision = decideAttention(signature, isPanelHidden(_root) ? _ack : signature);
  storeAck(decision.acknowledged);
  _activityCallback(decision.shown);
}

// Called when the PRs surface becomes visible (desktop tab, phone screen): seeing it is what clears the dot.
export function acknowledgePrAttention() {
  storeAck(prAttentionSignature(_latest));
  refreshActivity();
}

function render() {
  if (!_root) return;
  _root.textContent = '';
  _pollTicker.reset();
  const projects = projectsOf(_latest);
  if (projects.length === 0) {
    _root.append(el('p', 'pr-unconfigured', prStatusPlaceholder(_latest)));
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
