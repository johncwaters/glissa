const path: typeof import('node:path') = require('node:path');

const { numberOrNull }: { numberOrNull: UsageNumberOrNull } = require('./usage-number-core');
const { cutoffDayKey }: { cutoffDayKey: UsageCutoffDayKey } = require('./usage-warehouse-core');
const { MILL_METRICS_RETAIN_DAY_RANGE }: { MILL_METRICS_RETAIN_DAY_RANGE: IntegerRange } = require('../../shared/settings-ranges');
const { MAX_PACK_FILES_PER_SESSION }: MillMetricsContracts = require('../../shared/contracts/mill-metrics.ts');

const TITLE_RACE_MS = 1500;
const DEFAULT_MILL_METRICS_RETAIN_DAYS = 90;

// What ended the run, as known by the caller that ended it. Only an operator abandoning live work is an
// abort; a close-out ("Merge & finish"), a sleep-kill and a restart all reach the same user_kill
// transition, so the transition name alone cannot tell them apart.
type EndIntent = 'operator-abort' | 'close-out' | 'natural';

type DeliveredPackDirectory = {
  name: string;
  dir: string;
};

type AccumulatorPack = {
  version: string;
  tokenEstimate: number | null;
  dir: string;
  files: Set<string>;
  filesDropped: number;
};

type MillMetricAccumulator = {
  sessionId: string;
  startedAt: number;
  agent: string;
  readDetection: MillMetricReadDetection;
  packs: Map<string, AccumulatorPack>;
  prompts: MillMetricPromptCounts;
};

type RecordOptions = {
  endedAt?: number | null;
  disposition?: MillMetricDisposition | null;
  finalState?: string | null;
  tokens?: number | null;
  costUSD?: number | null;
  resumeSessionId?: string | null;
};

type OutcomeBucket = {
  sessions: number;
  meanInterruptions: number | null;
  abortRate: number | null;
  meanTokens: number | null;
};

type PackScorecard = {
  deliveries: number;
  measurableDeliveries: number;
  unmeasurableDeliveries: number;
  openedSessions: number;
  openRate: number | null;
  distinctFilesRead: number;
  medianFilesRead: number | null;
  opened: OutcomeBucket;
  unopened: OutcomeBucket;
  liveSessions: number;
  ambiguousPrompts: number;
  firstDay: string | null;
  lastDay: string | null;
};

type OutcomeTotals = {
  sessions: number;
  interruptions: number;
  dispositions: number;
  aborts: number;
  tokenSessions: number;
  tokens: number;
};

type ScorecardTotals = {
  deliveries: number;
  measurableDeliveries: number;
  unmeasurableDeliveries: number;
  openedSessions: number;
  liveSessions: number;
  ambiguousPrompts: number;
  firstDay: string | null;
  lastDay: string | null;
  filesRead: number[];
  distinctFiles: Set<string>;
  opened: OutcomeTotals;
  unopened: OutcomeTotals;
};

function nonnegativeInteger(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0) return 0;
  return Number(value);
}

function nonnegativeFigure(value: unknown): number | null {
  const figure = numberOrNull(value);
  if (figure === null) return null;
  return Math.max(0, figure);
}

function integerWithin(value: unknown, { min, max }: IntegerRange, fallback: number): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) return fallback;
  return Number(value);
}

function resolveMillMetricsConfig(raw: MillMetricsRawConfig): MillMetricsConfig {
  return {
    enabled: raw?.enabled === true,
    retainDays: integerWithin(raw?.retainDays, MILL_METRICS_RETAIN_DAY_RANGE, DEFAULT_MILL_METRICS_RETAIN_DAYS),
  };
}

function utcDay(timestamp: number): string | null {
  if (!Number.isFinite(timestamp)) return null;
  try {
    return new Date(timestamp).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

function classifyReadPath(
  filePath: unknown,
  deliveredPacks: DeliveredPackDirectory[],
  { caseInsensitive = false }: { caseInsensitive?: boolean } = {},
): { pack: string; relPath: string } | null {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return null;
  const resolvedCandidate = path.resolve(filePath);
  const comparableCandidate = caseInsensitive ? resolvedCandidate.toLowerCase() : resolvedCandidate;
  let bestMatch: { pack: string; relPath: string; directoryLength: number } | null = null;
  for (const deliveredPack of Array.isArray(deliveredPacks) ? deliveredPacks : []) {
    if (typeof deliveredPack?.name !== 'string' || !deliveredPack.name) continue;
    if (typeof deliveredPack.dir !== 'string' || !path.isAbsolute(deliveredPack.dir)) continue;
    const resolvedDirectory = path.resolve(deliveredPack.dir);
    const comparableDirectory = caseInsensitive ? resolvedDirectory.toLowerCase() : resolvedDirectory;
    const comparableRelativePath = path.relative(comparableDirectory, comparableCandidate);
    if (!comparableRelativePath || path.isAbsolute(comparableRelativePath) || comparableRelativePath.startsWith('..')) continue;
    const relPath = caseInsensitive
      ? resolvedCandidate.slice(resolvedDirectory.length).replace(/^[/\\]+/, '')
      : comparableRelativePath;
    if (bestMatch && bestMatch.directoryLength >= resolvedDirectory.length) continue;
    bestMatch = { pack: deliveredPack.name, relPath, directoryLength: resolvedDirectory.length };
  }
  if (!bestMatch) return null;
  return { pack: bestMatch.pack, relPath: bestMatch.relPath };
}

function classifyPrompt({
  state,
  stateSince,
  ts,
}: {
  state: string;
  stateSince: number;
  ts: number;
}): MillMetricPromptClass {
  if (state === 'WAITING') return 'answer';
  if (state !== 'RUNNING') return 'followup';
  // The OSC-0 title spinner can enter RUNNING just before the prompt hook arrives (session/sessions.js).
  if (ts - stateSince < TITLE_RACE_MS) return 'ambiguous';
  return 'interruption';
}

function dispositionFor(intent: unknown): MillMetricDisposition {
  if (intent === 'operator-abort') return 'user-kill';
  return 'natural';
}

function recordFromAccumulator(
  accumulator: MillMetricAccumulator,
  {
    endedAt = null,
    disposition = null,
    finalState = null,
    tokens = null,
    costUSD = null,
    resumeSessionId = null,
  }: RecordOptions = {},
): MillMetricSession | null {
  if (!accumulator || typeof accumulator.sessionId !== 'string' || !accumulator.sessionId) return null;
  if (typeof accumulator.agent !== 'string' || !accumulator.agent) return null;
  if (accumulator.readDetection !== 'available' && accumulator.readDetection !== 'unavailable') return null;
  const day = utcDay(accumulator.startedAt);
  if (!day) return null;
  const packs: MillMetricPack[] = [];
  for (const [packName, pack] of accumulator.packs instanceof Map ? accumulator.packs : []) {
    if (typeof packName !== 'string' || !packName) continue;
    const files = Array.from(pack.files instanceof Set ? pack.files : []).sort();
    packs.push({
      name: packName,
      version: typeof pack.version === 'string' ? pack.version : '',
      tokenEstimate: numberOrNull(pack.tokenEstimate),
      filesRead: files.length,
      files,
      filesDropped: nonnegativeInteger(pack.filesDropped),
      opened: files.length > 0,
      measurable: accumulator.readDetection === 'available',
    });
  }
  return {
    sessionId: accumulator.sessionId,
    day,
    startedAt: accumulator.startedAt,
    endedAt: numberOrNull(endedAt),
    agent: accumulator.agent,
    readDetection: accumulator.readDetection,
    disposition,
    finalState: typeof finalState === 'string' ? finalState : null,
    tokens: nonnegativeFigure(tokens),
    costUSD: nonnegativeFigure(costUSD),
    resumeSessionId: typeof resumeSessionId === 'string' ? resumeSessionId : null,
    prompts: {
      interruption: nonnegativeInteger(accumulator.prompts?.interruption),
      answer: nonnegativeInteger(accumulator.prompts?.answer),
      followup: nonnegativeInteger(accumulator.prompts?.followup),
      ambiguous: nonnegativeInteger(accumulator.prompts?.ambiguous),
    },
    packs,
  };
}

function compareRecords(left: MillMetricSession, right: MillMetricSession): number {
  const dayOrder = String(left.day).localeCompare(String(right.day));
  if (dayOrder !== 0) return dayOrder;
  return String(left.sessionId).localeCompare(String(right.sessionId));
}

function addNumbers(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return left + right;
}

function packWasMeasurable(record: MillMetricSession, pack: MillMetricPack): boolean {
  if (typeof pack.measurable === 'boolean') return pack.measurable;
  return record.readDetection === 'available';
}

// A run whose reads could not be observed knows nothing about what was opened, so it contributes its
// delivery and its drop count and no file: otherwise folding it with a measurable run would let the
// fold claim reads for a stretch that was never measurable. Measurability rides on the PACK, because a
// pack delivered only during a blind run is not measurable just because another run of that session was.
function measurablePacks(record: MillMetricSession): MillMetricPack[] {
  const packs = Array.isArray(record.packs) ? record.packs : [];
  return packs.map((pack) => {
    const measurable = packWasMeasurable(record, pack);
    if (measurable) return { ...pack, measurable };
    return { ...pack, measurable, filesRead: 0, files: [], opened: false };
  });
}

function mergePacks(earlier: MillMetricPack[], later: MillMetricPack[]): MillMetricPack[] {
  const packsByName = new Map<string, MillMetricPack>();
  for (const pack of [...(earlier || []), ...(later || [])]) {
    if (!pack || typeof pack.name !== 'string' || !pack.name) continue;
    const current = packsByName.get(pack.name);
    if (!current) {
      packsByName.set(pack.name, pack);
      continue;
    }
    const union = Array.from(new Set([
      ...(Array.isArray(current.files) ? current.files : []),
      ...(Array.isArray(pack.files) ? pack.files : []),
    ])).sort();
    // The union of two capped runs can exceed the cap the persisted shape allows, and a record the
    // shape rejects would take the whole store file down with it on the next load.
    const files = union.slice(0, MAX_PACK_FILES_PER_SESSION);
    const filesRead = Math.max(files.length, nonnegativeInteger(current.filesRead), nonnegativeInteger(pack.filesRead));
    packsByName.set(pack.name, {
      name: pack.name,
      version: pack.version,
      tokenEstimate: pack.tokenEstimate,
      filesRead,
      files,
      filesDropped: nonnegativeInteger(current.filesDropped)
        + nonnegativeInteger(pack.filesDropped)
        + (union.length - files.length),
      opened: filesRead > 0,
      measurable: current.measurable === true || pack.measurable === true,
    });
  }
  return Array.from(packsByName.values());
}

/*
 * Two runs of ONE session (a sleep-kill plus its wake auto-restart, a restart, a crash and resume) each
 * produce a record under the same stable session id, and the id is what a pack scorecard counts as one
 * delivery. Keeping the newest record therefore ERASED the earlier run's file union and prompt counts,
 * so a session that read the pack before a restart scored as never having opened it. The runs are folded
 * instead: the union of what was read, the sum of what was counted, the span of when it ran.
 */
function mergeSessionRecords(first: MillMetricSession, second: MillMetricSession): MillMetricSession {
  const earlier = first.startedAt <= second.startedAt ? first : second;
  const later = earlier === first ? second : first;
  return {
    sessionId: later.sessionId,
    // `day` is the LATEST run's day so retention and the last-seen day key on activity: keying the fold
    // on the first run expired a session the moment its restart merged with an aged original. The span
    // start stays readable from startedAt, which is what the scorecard reports as its first day.
    day: later.day,
    startedAt: earlier.startedAt,
    endedAt: later.endedAt,
    agent: later.agent,
    readDetection: earlier.readDetection === 'available' || later.readDetection === 'available'
      ? 'available'
      : 'unavailable',
    disposition: later.disposition,
    finalState: later.finalState,
    tokens: addNumbers(earlier.tokens, later.tokens),
    costUSD: addNumbers(earlier.costUSD, later.costUSD),
    resumeSessionId: later.resumeSessionId ?? earlier.resumeSessionId,
    prompts: {
      interruption: nonnegativeInteger(earlier.prompts?.interruption) + nonnegativeInteger(later.prompts?.interruption),
      answer: nonnegativeInteger(earlier.prompts?.answer) + nonnegativeInteger(later.prompts?.answer),
      followup: nonnegativeInteger(earlier.prompts?.followup) + nonnegativeInteger(later.prompts?.followup),
      ambiguous: nonnegativeInteger(earlier.prompts?.ambiguous) + nonnegativeInteger(later.prompts?.ambiguous),
    },
    packs: mergePacks(measurablePacks(earlier), measurablePacks(later)),
  };
}

function mergeRecords(
  existingRecords: MillMetricSession[],
  freshRecords: MillMetricSession[],
): MillMetricSession[] {
  const recordsBySessionId = new Map<string, MillMetricSession>();
  for (const record of [...(existingRecords || []), ...(freshRecords || [])]) {
    if (!record || typeof record.sessionId !== 'string' || !record.sessionId) continue;
    const current = recordsBySessionId.get(record.sessionId);
    recordsBySessionId.set(record.sessionId, current ? mergeSessionRecords(current, record) : record);
  }
  return Array.from(recordsBySessionId.values()).sort(compareRecords);
}

function firstDay(record: MillMetricSession): string | null {
  return utcDay(record.startedAt) || (typeof record?.day === 'string' ? record.day : null);
}

function pruneRecords(
  records: MillMetricSession[],
  { retainDays, todayKey }: { retainDays?: number; todayKey?: string } = {},
): MillMetricSession[] {
  const cutoffDay = cutoffDayKey(todayKey, retainDays);
  if (!cutoffDay) return [...(records || [])].sort(compareRecords);
  return (records || []).filter((record) => typeof record?.day === 'string' && record.day >= cutoffDay).sort(compareRecords);
}

function emptyOutcomeTotals(): OutcomeTotals {
  return { sessions: 0, interruptions: 0, dispositions: 0, aborts: 0, tokenSessions: 0, tokens: 0 };
}

function emptyScorecardTotals(): ScorecardTotals {
  return {
    deliveries: 0,
    measurableDeliveries: 0,
    unmeasurableDeliveries: 0,
    openedSessions: 0,
    liveSessions: 0,
    ambiguousPrompts: 0,
    firstDay: null,
    lastDay: null,
    filesRead: [],
    distinctFiles: new Set(),
    opened: emptyOutcomeTotals(),
    unopened: emptyOutcomeTotals(),
  };
}

function mean(total: number, count: number): number | null {
  if (count === 0) return null;
  return total / count;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[midpoint];
  return (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

function outcomeBucket(totals: OutcomeTotals): OutcomeBucket {
  return {
    sessions: totals.sessions,
    meanInterruptions: mean(totals.interruptions, totals.sessions),
    abortRate: mean(totals.aborts, totals.dispositions),
    meanTokens: mean(totals.tokens, totals.tokenSessions),
  };
}

function updateDays(scorecard: ScorecardTotals, record: MillMetricSession): void {
  const started = firstDay(record);
  const lastActive = typeof record.day === 'string' ? record.day : null;
  if (started !== null && (scorecard.firstDay === null || started < scorecard.firstDay)) scorecard.firstDay = started;
  if (lastActive !== null && (scorecard.lastDay === null || lastActive > scorecard.lastDay)) scorecard.lastDay = lastActive;
}

function addOutcome(totals: OutcomeTotals, record: MillMetricSession): void {
  totals.sessions += 1;
  totals.interruptions += nonnegativeInteger(record.prompts?.interruption);
  if (record.disposition !== null) totals.dispositions += 1;
  if (record.disposition === 'user-kill') totals.aborts += 1;
  const tokens = numberOrNull(record.tokens);
  if (tokens === null) return;
  totals.tokenSessions += 1;
  totals.tokens += tokens;
}

function buildScorecards(
  records: MillMetricSession[],
  liveRecords: MillMetricSession[] = [],
): Record<string, PackScorecard> {
  const totalsByPack = new Map<string, ScorecardTotals>();
  // A session live NOW can also have a persisted record from an earlier run of the same id, so the two
  // sides are folded through the same merge before counting: otherwise it is two deliveries, not one.
  for (const record of mergeRecords(records, liveRecords)) {
    if (!Array.isArray(record.packs)) continue;
    const packsByName = new Map(record.packs.map((pack) => [pack.name, pack]));
    for (const [packName, pack] of packsByName) {
      if (typeof packName !== 'string' || !packName) continue;
      const scorecard = totalsByPack.get(packName) || emptyScorecardTotals();
      scorecard.deliveries += 1;
      if (!packWasMeasurable(record, pack)) {
        scorecard.unmeasurableDeliveries += 1;
        totalsByPack.set(packName, scorecard);
        continue;
      }
      scorecard.measurableDeliveries += 1;
      if (record.endedAt === null) scorecard.liveSessions += 1;
      scorecard.ambiguousPrompts += nonnegativeInteger(record.prompts?.ambiguous);
      updateDays(scorecard, record);
      const filesRead = nonnegativeInteger(pack.filesRead);
      scorecard.filesRead.push(filesRead);
      for (const relPath of Array.isArray(pack.files) ? pack.files : []) {
        if (typeof relPath === 'string' && relPath) scorecard.distinctFiles.add(relPath);
      }
      const wasOpened = filesRead > 0;
      if (wasOpened) scorecard.openedSessions += 1;
      addOutcome(wasOpened ? scorecard.opened : scorecard.unopened, record);
      totalsByPack.set(packName, scorecard);
    }
  }
  const scorecards: Record<string, PackScorecard> = {};
  for (const [packName, totals] of totalsByPack) {
    scorecards[packName] = {
      deliveries: totals.deliveries,
      measurableDeliveries: totals.measurableDeliveries,
      unmeasurableDeliveries: totals.unmeasurableDeliveries,
      openedSessions: totals.openedSessions,
      openRate: mean(totals.openedSessions, totals.measurableDeliveries),
      distinctFilesRead: totals.distinctFiles.size,
      medianFilesRead: median(totals.filesRead),
      opened: outcomeBucket(totals.opened),
      unopened: outcomeBucket(totals.unopened),
      liveSessions: totals.liveSessions,
      ambiguousPrompts: totals.ambiguousPrompts,
      firstDay: totals.firstDay,
      lastDay: totals.lastDay,
    };
  }
  return scorecards;
}

declare global {
  type MillMetricEndIntent = EndIntent;
  type MillMetricPackAccumulator = AccumulatorPack;
  type MillMetricAccumulatorShape = MillMetricAccumulator;
  type MillMetricsConfig = { enabled: boolean; retainDays: number };
  type MillMetricsRawConfig = { enabled?: unknown; retainDays?: unknown } | null | undefined;

  // One declared signature per JS helper these modules require, annotated at every binding, so two
  // hand-written copies of the same shape cannot drift apart in silence.
  type UsageNumberOrNull = (value: unknown) => number | null;
  type UsageCutoffDayKey = (todayKey: unknown, retainDays: unknown) => string | null;
  type IntegerRange = { min: number; max: number };

  type MillMetricsCore = {
    DEFAULT_MILL_METRICS_RETAIN_DAYS: typeof DEFAULT_MILL_METRICS_RETAIN_DAYS;
    TITLE_RACE_MS: typeof TITLE_RACE_MS;
    buildScorecards: typeof buildScorecards;
    classifyPrompt: typeof classifyPrompt;
    classifyReadPath: typeof classifyReadPath;
    dispositionFor: typeof dispositionFor;
    mergeRecords: typeof mergeRecords;
    pruneRecords: typeof pruneRecords;
    recordFromAccumulator: typeof recordFromAccumulator;
    resolveMillMetricsConfig: typeof resolveMillMetricsConfig;
    utcDay: typeof utcDay;
  };
}

module.exports = {
  DEFAULT_MILL_METRICS_RETAIN_DAYS,
  TITLE_RACE_MS,
  buildScorecards,
  classifyPrompt,
  classifyReadPath,
  dispositionFor,
  mergeRecords,
  pruneRecords,
  recordFromAccumulator,
  resolveMillMetricsConfig,
  utcDay,
} satisfies MillMetricsCore;
