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
export const MILL_HINT = 'Specs, builds, delivery, drift.';
export const MILL_LOADING_TEXT = 'Reading pack specs.';
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

function familyOf(pack) {
  return typeof pack?.group === 'string' && pack.group ? pack.group : String(pack?.name ?? '');
}

// Invalid specs first (nothing downstream of them is trustworthy), then anything stale, then by name so
// a quiet mill reads as a stable list rather than reshuffling on every pull. A pack's per-project
// variants stay with it: they are separate packs, but they are the same pack's story.
export function sortPackRows(packs) {
  const rank = (pack) => {
    if (!pack.specValid) return 0;
    if (hasStaleWork(pack)) return 1;
    return 2;
  };
  const rows = [...(Array.isArray(packs) ? packs : [])];
  const familyRank = new Map();
  for (const pack of rows) {
    const family = familyOf(pack);
    const worst = Math.min(rank(pack), familyRank.has(family) ? familyRank.get(family) : rank(pack));
    familyRank.set(family, worst);
  }
  return rows.sort((a, b) => {
    const familyA = familyOf(a);
    const familyB = familyOf(b);
    const byRank = familyRank.get(familyA) - familyRank.get(familyB);
    if (byRank !== 0) return byRank;
    if (familyA !== familyB) return familyA.localeCompare(familyB);
    const byVariant = (a.group ? 1 : 0) - (b.group ? 1 : 0);
    if (byVariant !== 0) return byVariant;
    return String(a.name).localeCompare(String(b.name));
  });
}

/** One line saying what a derived row is, or '' for an ordinary pack. */
export function variantNote(pack) {
  const group = typeof pack?.group === 'string' && pack.group ? pack.group : '';
  if (!group) return '';
  const projects = Array.isArray(pack?.consumers?.projects) ? pack.consumers.projects : [];
  const project = projects.length > 0 ? projects[0] : 'its project';
  return `variant of "${group}", project ${project}`;
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
  if (!measured(built.tokenEstimate)) return 'tokens unknown';
  const pct = budgetPct(pack);
  const spent = formatTokens(built.tokenEstimate);
  if (pct === null) return `${spent} tokens, no budget`;
  return `${spent} / ${formatTokens(built.budgetTokens)} tokens, ${formatPercent(pct)}`;
}

export function indexLine(built) {
  if (!built) return '';
  if (!measured(built.indexTokenEstimate)) return '';
  const cap = Number(built.indexTokenCap);
  const used = formatTokens(built.indexTokenEstimate);
  if (!Number.isFinite(cap) || cap <= 0) return `index ${used} tokens`;
  return `index ${used} / ${formatTokens(cap)} tokens`;
}

// A pack nothing delivers is not built ON PURPOSE (the mill skips its watchers and its sweep), so it
// reads as a plain fact rather than as the unbuilt-pack warning a consumed pack would earn.
export function builtLine(pack) {
  const built = pack?.built;
  if (built?.empty === true) return `${shortVersion(built.version)} built ${formatBuiltAt(built.builtAt)}, empty`;
  if (built) return `${shortVersion(built.version)} built ${formatBuiltAt(built.builtAt)}`;
  if (pack?.hasConsumers === false) return 'not built: no consumers';
  return pack?.builtReason ? `Not built: ${pack.builtReason}` : 'Not built.';
}

export function builtTone(pack) {
  if (pack?.built) return 'ok';
  if (pack?.hasConsumers === false) return 'ok';
  return 'warn';
}

export function contentLine(built) {
  if (!built) return '';
  return [
    `${formatCount(built.fileCount)} files`,
    `${formatCount(built.ruleCount)} rules`,
    `${formatCount(built.skillCount)} skills`,
    `${formatCount(built.outputs.length + built.moreOutputs)} outputs`,
  ].join(', ');
}

export function specErrorLine(pack) {
  if (pack?.specValid) return '';
  const errors = Array.isArray(pack?.specErrors) ? pack.specErrors : [];
  if (errors.length === 0) return 'Spec is invalid.';
  return `Spec is invalid: ${errors.join('; ')}`;
}

export function deliveryLabel(delivery) {
  const name = typeof delivery?.project === 'string' && delivery.project ? delivery.project : 'session';
  const state = typeof delivery?.state === 'string' && delivery.state ? delivery.state.toLowerCase() : '';
  const count = Number(delivery?.sessionCount);
  const sessions = Number.isFinite(count) && count > 1 ? `${formatCount(count)} sessions` : '';
  const parts = [sessions, state].filter((part) => part !== '');
  if (parts.length === 0) return name;
  return `${name} (${parts.join(', ')})`;
}

export function deliveryDetail(delivery) {
  return `version ${shortVersion(delivery?.version)}`;
}

export function deliveryTone(delivery) {
  return delivery?.stale === true ? 'warn' : 'ok';
}

export function deliveryStaleText(delivery) {
  if (delivery?.stale !== true) return '';
  const stale = Number(delivery?.staleSessions);
  const sessions = Number(delivery?.sessionCount);
  if (!Number.isFinite(stale) || !Number.isFinite(sessions)) return 'stale';
  if (sessions <= 1 || stale >= sessions || stale <= 0) return 'stale';
  return `${formatCount(stale)} of ${formatCount(sessions)} stale`;
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

// Display prose for the lane kinds pack-core enumerates. A kind with no entry here falls back to its
// config label, so adding a pack-naming key server-side surfaces here rather than vanishing.
const LANE_DISPLAY = { prReview: 'the PR review lane', posthog: 'the Radar lane' };

export function consumerLine(pack) {
  const consumers = pack?.consumers || {};
  const projects = Array.isArray(consumers.projects) ? consumers.projects : [];
  const lanes = Array.isArray(consumers.lanes) ? consumers.lanes : [];
  const parts = [];
  if (projects.length > 0) parts.push(`projects ${projects.join(', ')}`);
  for (const lane of lanes) parts.push(LANE_DISPLAY[lane?.kind] || String(lane?.label ?? 'a lane'));
  if (parts.length === 0) return 'consumers: none';
  return `consumers: ${parts.join(', ')}`;
}

export function deliveryEmptyText(pack) {
  if (pack?.hasConsumers === false) return 'no consumers';
  if (!pack?.built) return 'no build';
  if (pack.built.empty === true) return 'empty build, not delivered';
  return 'no live sessions';
}

export function openRateText(measurement) {
  const openRate = measurement?.openRate;
  if (typeof openRate !== 'number' || !Number.isFinite(openRate)) return NO_VALUE;
  return formatPercent(openRate * 100);
}

export function measurementEmptyText(pack) {
  if (!pack?.measurement) return 'not yet measured';
  return '';
}

export function measurementLines(pack) {
  const measurement = pack?.measurement;
  if (!measurement) return [];
  const lines = [
    { label: 'deliveries', value: formatCount(measurement.deliveries), tone: 'ok' },
    { label: 'measurable deliveries', value: formatCount(measurement.measurableDeliveries), tone: 'ok' },
    { label: 'opened sessions', value: `${formatCount(measurement.openedSessions)} (${openRateText(measurement)})`, tone: 'ok' },
    { label: 'distinct files read', value: formatCount(measurement.distinctFilesRead), tone: 'ok' },
    { label: 'median files read', value: measured(measurement.medianFilesRead) ? formatCount(measurement.medianFilesRead) : NO_VALUE, tone: 'ok' },
  ];
  if (Number(measurement.liveSessions) > 0) {
    lines.push({ label: 'live sessions', value: formatCount(measurement.liveSessions), tone: 'ok' });
  }
  if (Number(measurement.ambiguousPrompts) > 0) {
    lines.push({ label: 'ambiguous prompts', value: formatCount(measurement.ambiguousPrompts), tone: 'warn' });
  }
  if (Number(measurement.unmeasurableDeliveries) > 0) {
    lines.push({
      label: 'unmeasurable deliveries',
      value: `${formatCount(measurement.unmeasurableDeliveries)} (read hooks unavailable)`,
      tone: 'warn',
    });
  }
  return lines;
}

function meanCountText(value) {
  if (!measured(value)) return NO_VALUE;
  return Number.isInteger(value) ? formatCount(value) : String(Number(value.toFixed(2)));
}

function outcomeValue(bucket) {
  return [
    `${formatCount(bucket?.sessions)} sessions`,
    `${meanCountText(bucket?.meanInterruptions)} mean interruptions`,
    `${measured(bucket?.abortRate) ? formatPercent(bucket.abortRate * 100) : NO_VALUE} abort rate`,
    `${measured(bucket?.meanTokens) ? formatTokens(bucket.meanTokens) : NO_VALUE} mean tokens`,
  ].join(', ');
}

export function outcomeSplitLines(measurement) {
  if (!measurement) return [];
  return [
    { label: 'opened outcomes', value: outcomeValue(measurement.opened), tone: 'ok' },
    { label: 'unopened outcomes', value: outcomeValue(measurement.unopened), tone: 'ok' },
  ];
}

// ── Assignment (the "Deliver to" control) ──
// Which packs a project's sessions are spawned against is a field on the project record, edited here and
// persisted by `set-project-packs`. The ephemeral lanes' lists stay config-file only, so they render as
// the read-only sentence consumerLine already writes.

export const DELIVER_TO_TITLE = 'Deliver to';
export const DELIVER_TO_EMPTY_TEXT = 'No projects.';
export const DELIVER_TO_CAP_NOTE = 'at cap';

function assignableProjects(report) {
  return Array.isArray(report?.projects) ? report.projects : [];
}

function packCap(report) {
  const max = Number(report?.maxPacksPerProject);
  if (!Number.isFinite(max) || max <= 0) return Number.POSITIVE_INFINITY;
  return max;
}

/**
 * One assignment row per project: whether this pack is delivered to it, whether it still can be, and
 * the project's current list (which is what the toggle sends back, since the message replaces the whole
 * list rather than describing a delta).
 */
export function deliveryTargets(report, pack) {
  // A variant is never assigned: a project assigns the GROUP, and the mill derives the variant from it.
  if (typeof pack?.group === 'string' && pack.group) return [];
  const name = typeof pack?.name === 'string' ? pack.name : '';
  const cap = packCap(report);
  const targets = [];
  for (const project of assignableProjects(report)) {
    const id = typeof project?.id === 'string' ? project.id : '';
    if (id === '') continue;
    const packs = Array.isArray(project?.packs) ? project.packs : [];
    const checked = packs.includes(name);
    targets.push({
      id,
      name: typeof project?.name === 'string' ? project.name : id,
      checked,
      // A project already at the per-session cap can drop a pack but not take another.
      disabled: !checked && packs.length >= cap,
      packs,
    });
  }
  return targets;
}

/**
 * What one toggle asks the server for. A DELTA, not a list: the server re-reads the project's current
 * packs inside its own write, so two dashboards toggling different packs cannot overwrite each other
 * with the snapshot each was rendered from.
 */
export function packDeltaFor(target, packName) {
  return { projectId: target?.id, pack: packName, deliver: target?.checked !== true };
}

export function deliverToCapHint(report) {
  const cap = packCap(report);
  if (!Number.isFinite(cap)) return '';
  return `${cap} packs max per project. Next spawn applies.`;
}

export function outputTokenLine(output) {
  return `${formatTokens(output?.tokenEstimate)} tokens`;
}

export function moreOutputsLine(count) {
  const numeric = Number(count);
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  return `${formatCount(numeric)} more files`;
}

export function totalsChips(report) {
  const totals = report?.totals || {};
  return [
    { label: 'packs', value: formatCount(totals.packCount ?? 0) },
    { label: 'built', value: formatCount(totals.builtCount ?? 0) },
    // Informational, never toned: an unconsumed pack is skipped on purpose, not a problem to fix.
    { label: 'no consumers', value: formatCount(totals.unconsumed ?? 0) },
    { label: 'invalid specs', value: formatCount(totals.invalidSpecs ?? 0), tone: Number(totals.invalidSpecs) > 0 ? 'crit' : null },
    { label: 'stale deliveries', value: formatCount(totals.staleDeliveries ?? 0), tone: Number(totals.staleDeliveries) > 0 ? 'warn' : null },
    { label: 'stale distills', value: formatCount(totals.staleDistills ?? 0), tone: Number(totals.staleDistills) > 0 ? 'warn' : null },
  ];
}

// Watchers are the automation's own health: auto-rebuild switched on with zero watchers means every
// rebuild is waiting on the 15 minute sweep, which is a different surface from a mill that is off.
export function autoRebuildLine(report) {
  if (!report) return '';
  if (report.autoRebuild !== true) return 'auto rebuild off, glissa pack build only';
  const watchers = report.watcherCount;
  if (typeof watchers !== 'number' || !Number.isFinite(watchers)) return 'auto rebuild on';
  if (watchers > 0) return `auto rebuild on, ${formatCount(watchers)} watched roots`;
  // Zero watchers has two meanings, and only one of them is a problem. With nothing delivered anywhere
  // there is deliberately nothing to watch; with something delivered, every rebuild is waiting on the
  // fallback sweep, which is the state this line was written to catch.
  if (nothingIsConsumed(report)) return 'auto rebuild on, no consumers';
  return `auto rebuild on, ${formatCount(watchers)} watched roots, fallback sweep only`;
}

function nothingIsConsumed(report) {
  const packCount = Number(report?.totals?.packCount);
  const unconsumed = Number(report?.totals?.unconsumed);
  if (!Number.isFinite(packCount) || !Number.isFinite(unconsumed)) return false;
  return packCount > 0 && unconsumed === packCount;
}

export function distillerLine(report) {
  if (report?.distillerEnabled === true) return 'distiller on';
  return 'distiller off, glissa pack distill regenerates';
}

export function isMillUnavailable(report) {
  return typeof report?.error === 'string' && report.error !== '';
}

export function millErrorLine(report) {
  if (!isMillUnavailable(report)) return '';
  return `mill unavailable: ${report.error}`;
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

export { NO_VALUE };
