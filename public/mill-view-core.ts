import { attentionSignature } from './attention-ack-core.ts';
import { NO_VALUE, formatCount, formatPercent, formatTokens } from './usage-view-core.ts';

export const BUDGET_WARN_PCT = 90;

export interface MillOutput {
  relPath: string;
  tokenEstimate?: unknown;
}

export interface MillBuild {
  version?: unknown;
  builtAt?: unknown;
  empty?: unknown;
  tokenEstimate?: unknown;
  budgetTokens?: unknown;
  budgetPct?: unknown;
  indexTokenEstimate?: unknown;
  indexTokenCap?: unknown;
  fileCount?: unknown;
  ruleCount?: unknown;
  skillCount?: unknown;
  outputs: MillOutput[];
  moreOutputs: number;
}

export interface MillDistillRow {
  output: string;
  stale?: unknown;
  reason?: unknown;
  source?: unknown;
}

export interface MillDelivery {
  project?: unknown;
  state?: unknown;
  sessionCount?: unknown;
  version?: unknown;
  stale?: unknown;
  staleSessions?: unknown;
  pending?: unknown;
}

export interface MillConsumerLane {
  kind?: string;
  label?: unknown;
}

export interface MillConsumers {
  projects?: string[];
  lanes?: MillConsumerLane[];
}

export interface MillLine {
  label: string;
  value: string;
  tone: string;
}

export interface MillOutcomeBucket {
  sessions?: unknown;
  meanInterruptions?: unknown;
  abortRate?: unknown;
  meanTokens?: unknown;
}

export interface MillMeasurement {
  deliveries?: unknown;
  measurableDeliveries?: unknown;
  unmeasurableDeliveries?: unknown;
  openedSessions?: unknown;
  openRate?: unknown;
  distinctFilesRead?: unknown;
  medianFilesRead?: unknown;
  liveSessions?: unknown;
  ambiguousPrompts?: unknown;
  opened?: MillOutcomeBucket | null;
  unopened?: MillOutcomeBucket | null;
}

export interface MillPack {
  name: string;
  group?: unknown;
  specValid?: unknown;
  specErrors?: unknown;
  staleDeliveries?: unknown;
  distill: MillDistillRow[];
  deliveredTo: MillDelivery[];
  built?: MillBuild | null;
  builtReason?: unknown;
  hasConsumers?: unknown;
  consumers?: MillConsumers | null;
  deliveries?: MillDelivery[];
  measurement?: MillMeasurement | null;
}

export interface MillTotals {
  packCount?: unknown;
  builtCount?: unknown;
  unconsumed?: unknown;
  invalidSpecs?: unknown;
  staleDeliveries?: unknown;
  staleDistills?: unknown;
}

export interface MillReport {
  packs?: MillPack[];
  totals?: MillTotals | null;
  autoRebuild?: unknown;
  watcherCount?: unknown;
  distillerEnabled?: unknown;
  error?: unknown;
  configWarnings?: unknown;
}

export const MILL_EMPTY_TEXT = 'No pack specs found.';
export const MILL_HINT = 'Specs, builds, delivery, drift.';
export const MILL_LOADING_TEXT = 'Reading pack specs.';
const VERSION_CHARS = 12;

export function shortVersion(version: unknown) {
  if (typeof version !== 'string' || version === '') return NO_VALUE;
  return version.slice(0, VERSION_CHARS);
}

export function formatBuiltAt(iso: unknown) {
  if (typeof iso !== 'string' || iso === '') return NO_VALUE;
  return iso.replace('T', ' ').slice(0, 19);
}

function packsOf(report: MillReport | null | undefined): MillPack[] {
  return Array.isArray(report?.packs) ? report.packs : [];
}

export function hasStaleWork(pack: MillPack | null | undefined) {
  if (Number(pack?.staleDeliveries) > 0) return true;
  const distillRows: MillDistillRow[] = Array.isArray(pack?.distill) ? pack.distill : [];
  return distillRows.some((row) => row.stale === true);
}

function familyOf(pack: MillPack) {
  return typeof pack?.group === 'string' && pack.group ? pack.group : String(pack?.name ?? '');
}

export function sortPackRows(packs: unknown): MillPack[] {
  const rank = (pack: MillPack) => {
    if (!pack.specValid) return 0;
    if (hasStaleWork(pack)) return 1;
    return 2;
  };
  const packRows: MillPack[] = Array.isArray(packs) ? packs : [];
  const rows = [...packRows];
  const familyRank = new Map<string, number>();
  for (const pack of rows) {
    const family = familyOf(pack);
    const worst = Math.min(rank(pack), familyRank.get(family) ?? rank(pack));
    familyRank.set(family, worst);
  }
  return rows.sort((a, b) => {
    const familyA = familyOf(a);
    const familyB = familyOf(b);
    const byRank = (familyRank.get(familyA) ?? 0) - (familyRank.get(familyB) ?? 0);
    if (byRank !== 0) return byRank;
    if (familyA !== familyB) return familyA.localeCompare(familyB);
    const byVariant = (a.group ? 1 : 0) - (b.group ? 1 : 0);
    if (byVariant !== 0) return byVariant;
    return String(a.name).localeCompare(String(b.name));
  });
}

export function variantNote(pack: MillPack | null | undefined) {
  const group = typeof pack?.group === 'string' && pack.group ? pack.group : '';
  if (!group) return '';
  const projects: string[] = Array.isArray(pack?.consumers?.projects) ? pack.consumers.projects : [];
  const project = projects.length > 0 ? projects[0] : 'its project';
  return `variant of "${group}", project ${project}`;
}

export function budgetPct(pack: Pick<MillPack, 'built'> | null | undefined) {
  const pct = pack?.built?.budgetPct;
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  return pct;
}

export function budgetTone(pct: unknown) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return 'ok';
  if (pct >= BUDGET_WARN_PCT) return 'warn';
  return 'ok';
}

function measured(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function budgetLine(pack: Pick<MillPack, 'built'> | null | undefined) {
  const built = pack?.built;
  if (!built) return '';
  if (!measured(built.tokenEstimate)) return 'tokens unknown';
  const pct = budgetPct(pack);
  const spent = formatTokens(built.tokenEstimate);
  if (pct === null) return `${spent} tokens, no budget`;
  return `${spent} / ${formatTokens(built.budgetTokens)} tokens, ${formatPercent(pct)}`;
}

export function indexLine(built: MillBuild | null | undefined) {
  if (!built) return '';
  if (!measured(built.indexTokenEstimate)) return '';
  const cap = Number(built.indexTokenCap);
  const used = formatTokens(built.indexTokenEstimate);
  if (!Number.isFinite(cap) || cap <= 0) return `index ${used} tokens`;
  return `index ${used} / ${formatTokens(cap)} tokens`;
}

export function builtLine(pack: MillPack | null | undefined) {
  const built = pack?.built;
  if (built?.empty === true) return `${shortVersion(built.version)} built ${formatBuiltAt(built.builtAt)}, empty`;
  if (built) return `${shortVersion(built.version)} built ${formatBuiltAt(built.builtAt)}`;
  if (pack?.hasConsumers === false) return 'not built: no consumers';
  return pack?.builtReason ? `Not built: ${pack.builtReason}` : 'Not built.';
}

export function builtTone(pack: MillPack | null | undefined) {
  if (pack?.built) return 'ok';
  if (pack?.hasConsumers === false) return 'ok';
  return 'warn';
}

export function contentLine(built: MillBuild | null | undefined) {
  if (!built) return '';
  return [
    `${formatCount(built.fileCount)} files`,
    `${formatCount(built.ruleCount)} rules`,
    `${formatCount(built.skillCount)} skills`,
    `${formatCount(built.outputs.length + built.moreOutputs)} outputs`,
  ].join(', ');
}

export function specErrorLine(pack: MillPack | null | undefined) {
  if (pack?.specValid) return '';
  const errors: unknown[] = Array.isArray(pack?.specErrors) ? pack.specErrors : [];
  if (errors.length === 0) return 'Spec is invalid.';
  return `Spec is invalid: ${errors.join('; ')}`;
}

export function deliveryLabel(delivery: MillDelivery | null | undefined) {
  const name = typeof delivery?.project === 'string' && delivery.project ? delivery.project : 'session';
  const state = typeof delivery?.state === 'string' && delivery.state ? delivery.state.toLowerCase() : '';
  const count = Number(delivery?.sessionCount);
  const sessions = Number.isFinite(count) && count > 1 ? `${formatCount(count)} sessions` : '';
  const parts = [sessions, state].filter((part) => part !== '');
  if (parts.length === 0) return name;
  return `${name} (${parts.join(', ')})`;
}

export function deliveryDetail(delivery: MillDelivery | null | undefined) {
  if (delivery?.pending === true) return 'delivers on next spawn';
  return `version ${shortVersion(delivery?.version)}`;
}

export function deliveryTone(delivery: MillDelivery | null | undefined) {
  return delivery?.stale === true ? 'warn' : 'ok';
}

export function deliveryStaleText(delivery: MillDelivery | null | undefined) {
  if (delivery?.stale !== true) return '';
  const stale = Number(delivery?.staleSessions);
  const sessions = Number(delivery?.sessionCount);
  if (!Number.isFinite(stale) || !Number.isFinite(sessions)) return 'stale';
  if (sessions <= 1 || stale >= sessions || stale <= 0) return 'stale';
  return `${formatCount(stale)} of ${formatCount(sessions)} stale`;
}

export function distillText(row: MillDistillRow | null | undefined) {
  if (row?.stale === true) return `stale: ${row.reason || 'sources changed since the last distill'}`;
  if (row?.stale === false) return 'current';
  return `check failed: ${row?.reason || 'unknown reason'}`;
}

export function distillTone(row: Pick<MillDistillRow, 'stale'> | null | undefined) {
  if (row?.stale === false) return 'ok';
  return 'warn';
}

const LANE_DISPLAY: Record<string, string> = { prReview: 'the PR review lane', posthog: 'the Radar lane' };

export function consumerLine(pack: MillPack | null | undefined) {
  const consumers: MillConsumers = pack?.consumers || {};
  const projects: string[] = Array.isArray(consumers.projects) ? consumers.projects : [];
  const lanes: MillConsumerLane[] = Array.isArray(consumers.lanes) ? consumers.lanes : [];
  const parts: string[] = [];
  if (projects.length > 0) parts.push(`projects ${projects.join(', ')}`);
  for (const lane of lanes) parts.push(LANE_DISPLAY[lane?.kind ?? ''] || String(lane?.label ?? 'a lane'));
  if (parts.length === 0) return 'consumers: none';
  return `consumers: ${parts.join(', ')}`;
}

export function deliveryEmptyText(pack: MillPack | null | undefined) {
  if (pack?.hasConsumers === false) return 'no consumers';
  if (!pack?.built) return 'no build';
  if (pack.built.empty === true) return 'empty build, not delivered';
  return 'no live sessions';
}

export function openRateText(measurement: MillMeasurement | null | undefined): string {
  const openRate = measurement?.openRate;
  if (typeof openRate !== 'number' || !Number.isFinite(openRate)) return NO_VALUE;
  return formatPercent(openRate * 100);
}

export function measurementEmptyText(pack: MillPack | null | undefined): string {
  if (!pack?.measurement) return 'not yet measured';
  return '';
}

export function measurementLines(pack: MillPack | null | undefined): MillLine[] {
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

function meanCountText(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return NO_VALUE;
  return Number.isInteger(value) ? formatCount(value) : String(Number(value.toFixed(2)));
}

function outcomeAbortRateText(bucket: MillOutcomeBucket | null | undefined): string {
  const abortRate = bucket?.abortRate;
  if (!measured(abortRate)) return NO_VALUE;
  return formatPercent(abortRate * 100);
}

function outcomeValue(bucket: MillOutcomeBucket | null | undefined): string {
  return [
    `${formatCount(bucket?.sessions)} sessions`,
    `${meanCountText(bucket?.meanInterruptions)} mean interruptions`,
    `${outcomeAbortRateText(bucket)} abort rate`,
    `${measured(bucket?.meanTokens) ? formatTokens(bucket?.meanTokens) : NO_VALUE} mean tokens`,
  ].join(', ');
}

export function outcomeSplitLines(measurement: MillMeasurement | null | undefined): MillLine[] {
  if (!measurement) return [];
  return [
    { label: 'opened outcomes', value: outcomeValue(measurement.opened), tone: 'ok' },
    { label: 'unopened outcomes', value: outcomeValue(measurement.unopened), tone: 'ok' },
  ];
}

export function outputTokenLine(output: MillOutput | null | undefined) {
  return `${formatTokens(output?.tokenEstimate)} tokens`;
}

export function moreOutputsLine(count: unknown) {
  const numeric = Number(count);
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  return `${formatCount(numeric)} more files`;
}

export function totalsChips(report: MillReport | null | undefined): { label: string; value: string; tone?: string | null }[] {
  const totals: MillTotals = report?.totals || {};
  return [
    { label: 'packs', value: formatCount(totals.packCount ?? 0) },
    { label: 'built', value: formatCount(totals.builtCount ?? 0) },

    { label: 'no consumers', value: formatCount(totals.unconsumed ?? 0) },
    { label: 'invalid specs', value: formatCount(totals.invalidSpecs ?? 0), tone: Number(totals.invalidSpecs) > 0 ? 'crit' : null },
    { label: 'stale deliveries', value: formatCount(totals.staleDeliveries ?? 0), tone: Number(totals.staleDeliveries) > 0 ? 'warn' : null },
    { label: 'stale distills', value: formatCount(totals.staleDistills ?? 0), tone: Number(totals.staleDistills) > 0 ? 'warn' : null },
  ];
}

export function autoRebuildLine(report: MillReport | null | undefined) {
  if (!report) return '';
  if (report.autoRebuild !== true) return 'mill off: no builds, no packs delivered';
  const watchers = report.watcherCount;
  if (typeof watchers !== 'number' || !Number.isFinite(watchers)) return 'auto rebuild on';
  if (watchers > 0) return `auto rebuild on, ${formatCount(watchers)} watched roots`;

  if (nothingIsConsumed(report)) return 'auto rebuild on, no consumers';
  return `auto rebuild on, ${formatCount(watchers)} watched roots, fallback sweep only`;
}

function nothingIsConsumed(report: MillReport | null | undefined) {
  const packCount = Number(report?.totals?.packCount);
  const unconsumed = Number(report?.totals?.unconsumed);
  if (!Number.isFinite(packCount) || !Number.isFinite(unconsumed)) return false;
  return packCount > 0 && unconsumed === packCount;
}

export function distillerLine(report: MillReport | null | undefined) {
  if (report?.distillerEnabled === true) return 'distiller on';
  return 'distiller off, glissa pack distill regenerates';
}

export function isMillUnavailable(report: MillReport | null | undefined) {
  return typeof report?.error === 'string' && report.error !== '';
}

export function millErrorLine(report: MillReport | null | undefined) {
  if (!isMillUnavailable(report)) return '';
  return `mill unavailable: ${report?.error}`;
}

export function configWarningsOf(report: MillReport | null | undefined): string[] {
  return Array.isArray(report?.configWarnings) ? report.configWarnings : [];
}

export function millAttentionSignature(report: MillReport | null | undefined) {
  const parts: string[] = [];
  for (const warning of configWarningsOf(report)) parts.push(`config:${warning}`);
  for (const pack of packsOf(report)) {
    if (!pack.specValid) parts.push(`invalid:${pack.name}`);
    if (Number(pack.staleDeliveries) > 0) parts.push(`stale:${pack.name}:${pack.staleDeliveries}`);
    const distillRows: MillDistillRow[] = Array.isArray(pack.distill) ? pack.distill : [];
    for (const row of distillRows) {
      if (row.stale === true) parts.push(`distill:${row.output}`);
    }
  }
  return attentionSignature(parts);
}

export function shouldApplyMillReport(msg: unknown, latestRequestId: unknown) {
  if (!msg || typeof msg !== 'object') return false;
  const id = (msg as { requestId?: unknown }).requestId;

  if (id == null) return true;
  return id === latestRequestId;
}

export { NO_VALUE };
