// ── Mill view (pure) ─────────────────────────────────────────
// Every string, tone, ordering and threshold the Mill tab shows. No DOM, so it is unit-testable from
// node, and public/mill-panel.js stays a builder of elements.
//
// The numeric formatters are the Usage tab's (formatTokens, formatPercent, formatCount): a token count
// is a token count, and two surfaces rounding it differently would read as two different numbers.

import { attentionSignature } from './attention-ack-core.mjs';
import { NO_VALUE, formatCount, formatPercent, formatTokens } from './usage-view-core.mjs';

// A written manifest can never exceed its own budget (the builder refuses that build), so the ladder
// stops at one warning: what this threshold catches is a pack approaching the ceiling it will one day
// fail to build under, not a pack already over it.
export const BUDGET_WARN_PCT = 90;

export const MILL_EMPTY_TEXT = 'No pack specs found.';
export const MILL_HINT = 'Assembled on demand from the pack specs, their published builds and the live sessions.';
const VERSION_CHARS = 12;

export function shortVersion(version) {
  if (typeof version !== 'string' || version === '') return NO_VALUE;
  return version.slice(0, VERSION_CHARS);
}

export function formatBuiltAt(iso) {
  if (typeof iso !== 'string' || iso === '') return NO_VALUE;
  return iso.replace('T', ' ').slice(0, 19);
}

function packsOf(report) {
  return Array.isArray(report?.packs) ? report.packs : [];
}

export function hasStaleWork(pack) {
  if (Number(pack?.staleDeliveries) > 0) return true;
  return (Array.isArray(pack?.distill) ? pack.distill : []).some((row) => row.stale === true);
}

// Invalid specs first (nothing downstream of them is trustworthy), then anything stale, then by name so
// a quiet mill reads as a stable list rather than reshuffling on every pull.
export function sortPackRows(packs) {
  const rank = (pack) => {
    if (!pack.specValid) return 0;
    if (hasStaleWork(pack)) return 1;
    return 2;
  };
  return [...(Array.isArray(packs) ? packs : [])].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    return String(a.name).localeCompare(String(b.name));
  });
}

export function budgetPct(pack) {
  const pct = pack?.built?.budgetPct;
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  return pct;
}

export function budgetTone(pct) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return 'ok';
  if (pct >= BUDGET_WARN_PCT) return 'warn';
  return 'ok';
}

function measured(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function budgetLine(pack) {
  const built = pack?.built;
  if (!built) return '';
  if (!measured(built.tokenEstimate)) return 'The manifest records no token estimate.';
  const pct = budgetPct(pack);
  const spent = formatTokens(built.tokenEstimate);
  if (pct === null) return `${spent} tokens, no budget declared`;
  return `${spent} of ${formatTokens(built.budgetTokens)} tokens, ${formatPercent(pct)} of budget`;
}

export function indexLine(built) {
  if (!built) return '';
  if (!measured(built.indexTokenEstimate)) return '';
  const cap = Number(built.indexTokenCap);
  const used = formatTokens(built.indexTokenEstimate);
  if (!Number.isFinite(cap) || cap <= 0) return `index ${used} tokens`;
  return `index ${used} of ${formatTokens(cap)} tokens, the always-loaded tier`;
}

export function builtLine(pack) {
  const built = pack?.built;
  if (!built) return pack?.builtReason ? `Not built: ${pack.builtReason}` : 'Not built.';
  return `Version ${shortVersion(built.version)}, built ${formatBuiltAt(built.builtAt)}`;
}

export function contentLine(built) {
  if (!built) return '';
  return [
    `${formatCount(built.fileCount)} source files`,
    `${formatCount(built.ruleCount)} rules`,
    `${formatCount(built.skillCount)} skills`,
    `${formatCount(built.outputs.length + built.moreOutputs)} delivered files`,
  ].join(', ');
}

export function specErrorLine(pack) {
  if (pack?.specValid) return '';
  const errors = Array.isArray(pack?.specErrors) ? pack.specErrors : [];
  if (errors.length === 0) return 'Spec is invalid.';
  return `Spec is invalid: ${errors.join('; ')}`;
}

export function deliveryLabel(delivery) {
  const name = typeof delivery?.sessionName === 'string' && delivery.sessionName ? delivery.sessionName : 'session';
  const state = typeof delivery?.state === 'string' && delivery.state ? delivery.state.toLowerCase() : '';
  if (!state) return name;
  return `${name} (${state})`;
}

// Reads are the whole point of the telemetry: a delivered pack nothing ever opened cost context for
// nothing, so the count is said even when it is zero.
export function deliveryDetail(delivery) {
  const parts = [`${formatCount(delivery?.reads ?? 0)} reads`];
  const sinceNotice = delivery?.readsSinceNotice;
  if (typeof sinceNotice === 'number' && Number.isFinite(sinceNotice)) {
    parts.push(`${formatCount(sinceNotice)} since the staleness notice`);
  }
  parts.push(`version ${shortVersion(delivery?.version)}`);
  return parts.join(', ');
}

export function deliveryTone(delivery) {
  return delivery?.stale === true ? 'warn' : 'ok';
}

export function deliveryStaleText(delivery) {
  if (delivery?.stale === true) return 'stale';
  return '';
}

export function distillText(row) {
  if (row?.stale === true) return `stale: ${row.reason || 'sources changed since the last distill'}`;
  if (row?.stale === false) return 'current';
  return `check failed: ${row?.reason || 'unknown reason'}`;
}

export function distillTone(row) {
  if (row?.stale === false) return 'ok';
  return 'warn';
}

export function consumerLine(pack) {
  const consumers = pack?.consumers || {};
  const projects = Array.isArray(consumers.projects) ? consumers.projects : [];
  const parts = [];
  if (projects.length > 0) parts.push(`projects: ${projects.join(', ')}`);
  if (consumers.prReview) parts.push('the PR review lane');
  if (consumers.posthog) parts.push('the Radar lane');
  if (parts.length === 0) return 'Delivered to nothing: no project or lane names this pack.';
  return `Delivered to ${parts.join(', ')}.`;
}

export function deliveryEmptyText(pack) {
  if (!pack?.built) return 'Nothing is running it: the pack has never been built.';
  return 'No live session is running this pack.';
}

export function totalsChips(report) {
  const totals = report?.totals || {};
  return [
    { label: 'packs', value: formatCount(totals.packCount ?? 0) },
    { label: 'built', value: formatCount(totals.builtCount ?? 0) },
    { label: 'invalid specs', value: formatCount(totals.invalidSpecs ?? 0), tone: Number(totals.invalidSpecs) > 0 ? 'crit' : null },
    { label: 'stale deliveries', value: formatCount(totals.staleDeliveries ?? 0), tone: Number(totals.staleDeliveries) > 0 ? 'warn' : null },
    { label: 'stale distills', value: formatCount(totals.staleDistills ?? 0), tone: Number(totals.staleDistills) > 0 ? 'warn' : null },
    { label: 'pack reads', value: formatCount(totals.totalReads ?? 0) },
  ];
}

// Watchers are the automation's own health: auto-rebuild switched on with zero watchers means every
// rebuild is waiting on the 15 minute sweep, which is a different surface from a mill that is off.
export function autoRebuildLine(report) {
  if (!report) return '';
  if (report.autoRebuild !== true) return 'Auto rebuild is off. A pack changes only when glissa pack build runs.';
  const watchers = report.watcherCount;
  if (typeof watchers !== 'number' || !Number.isFinite(watchers)) return 'Auto rebuild is on.';
  return `Auto rebuild is on, watching ${formatCount(watchers)} source roots.`;
}

export function distillerLine(report) {
  if (report?.distillerEnabled === true) return 'The distiller lane is on: drifted derived files are regenerated on its schedule.';
  return 'The distiller lane is off. Drift is reported here; glissa pack distill regenerates.';
}

export function isMillUnavailable(report) {
  return typeof report?.error === 'string' && report.error !== '';
}

export function millErrorLine(report) {
  if (!isMillUnavailable(report)) return '';
  return `The context mill report is unavailable: ${report.error}`;
}

export function configWarningsOf(report) {
  return Array.isArray(report?.configWarnings) ? report.configWarnings : [];
}

/*
 * What the Mill dot means: something the operator has to act on, never a standing fact. A spec that
 * does not validate never builds, a session running an older build is carrying context that has moved,
 * and a drifted derived file is a pack telling the agent something no longer true.
 */
export function millAttentionSignature(report) {
  const parts = [];
  for (const warning of configWarningsOf(report)) parts.push(`config:${warning}`);
  for (const pack of packsOf(report)) {
    if (!pack.specValid) parts.push(`invalid:${pack.name}`);
    if (Number(pack.staleDeliveries) > 0) parts.push(`stale:${pack.name}:${pack.staleDeliveries}`);
    for (const row of Array.isArray(pack.distill) ? pack.distill : []) {
      if (row.stale === true) parts.push(`distill:${row.output}`);
    }
  }
  return attentionSignature(parts);
}

export function shouldApplyMillReport(msg, latestRequestId) {
  if (!msg || typeof msg !== 'object') return false;
  const id = msg.requestId;
  // A connect-time replay carries no id; only a reply to a request we superseded is stale.
  if (id == null) return true;
  return id === latestRequestId;
}

export { NO_VALUE, formatCount, formatPercent, formatTokens };
