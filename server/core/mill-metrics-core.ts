import type {
  MillMetricDisposition,
  MillMetricPack,
  MillMetricPromptClass,
  MillMetricPromptCounts,
  MillMetricSession,
} from '../../shared/contracts/mill-metrics.ts';
import { MILL_METRICS_RETAIN_DAY_RANGE } from '../../shared/settings-ranges.ts';
import { STATES } from '../../shared/states.ts';
import { numberOrNull } from './usage-number-core.ts';
import { cutoffDayKey } from './usage-warehouse-core.ts';

type IntegerRange = { min: number; max: number };

const TITLE_RACE_MS = 1500;
const DEFAULT_MILL_METRICS_RETAIN_DAYS = 90;

type EndIntent = 'operator-abort' | 'close-out' | 'natural';

type MillPromptBoundary = {
  ts: number;
  wasAwaitingInput: boolean;
};

type MillTurnBoundaryState = {
  boundary: MillPromptBoundary | null;
  hasSeenTurnEnd: boolean;
  hasSeenPrompt: boolean;
};

type MillTurnBoundaryEvent =
  | { kind: 'hook-event'; event: string; state: string; ts: number }
  | { kind: 'state-change'; to: string; ts: number }
  | { kind: 'user-prompt' };

type MillTurnBoundaryStep = {
  state: MillTurnBoundaryState;
  boundary: MillPromptBoundary | null;
  hasSeenPriorPrompt: boolean;
};

type AccumulatorPack = {
  version: string;
  tokenEstimate: number | null;
};

type MillMetricAccumulator = {
  sessionId: string;
  startedAt: number;
  agent: string;
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
  outcomes: OutcomeBucket;
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
  liveSessions: number;
  ambiguousPrompts: number;
  firstDay: string | null;
  lastDay: string | null;
  outcomes: OutcomeTotals;
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

function promptBoundaryOrNull(value: unknown): MillPromptBoundary | null {
  if (!value || typeof value !== 'object') return null;
  if (!('ts' in value) || !('wasAwaitingInput' in value)) return null;
  const { ts, wasAwaitingInput } = value;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
  if (typeof wasAwaitingInput !== 'boolean') return null;
  return { ts, wasAwaitingInput };
}

function initialTurnBoundaryState(): MillTurnBoundaryState {
  return { boundary: null, hasSeenTurnEnd: false, hasSeenPrompt: false };
}

function endedTurnState(ts: number, wasAwaitingInput: boolean, hasSeenPrompt: boolean): MillTurnBoundaryState {
  return { boundary: { ts, wasAwaitingInput }, hasSeenTurnEnd: true, hasSeenPrompt };
}

function reduceTurnBoundary(
  state: MillTurnBoundaryState,
  event: MillTurnBoundaryEvent,
): MillTurnBoundaryStep {
  const hasSeenPriorPrompt = state.hasSeenPrompt;
  if (event.kind === 'user-prompt') {
    return {
      state: { boundary: null, hasSeenTurnEnd: state.hasSeenTurnEnd, hasSeenPrompt: true },
      boundary: state.boundary,
      hasSeenPriorPrompt,
    };
  }
  if (event.kind === 'hook-event') {
    if (event.event.toLowerCase() !== 'stop') return { state, boundary: null, hasSeenPriorPrompt };
    return {
      state: endedTurnState(event.ts, event.state === STATES.WAITING, state.hasSeenPrompt),
      boundary: null,
      hasSeenPriorPrompt,
    };
  }
  if (event.to === STATES.RUNNING) {
    return {
      state: { boundary: null, hasSeenTurnEnd: state.hasSeenTurnEnd, hasSeenPrompt: state.hasSeenPrompt },
      boundary: null,
      hasSeenPriorPrompt,
    };
  }
  if (event.to !== STATES.WAITING && event.to !== STATES.COMPLETE) return { state, boundary: null, hasSeenPriorPrompt };
  return {
    state: endedTurnState(event.ts, event.to === STATES.WAITING, state.hasSeenPrompt),
    boundary: null,
    hasSeenPriorPrompt,
  };
}

function classifyPrompt({
  boundary,
  hasSeenTurnEnd,
  hasSeenPriorPrompt,
  ts,
}: {
  boundary: MillPromptBoundary | null;
  hasSeenTurnEnd: boolean;
  hasSeenPriorPrompt: boolean;
  ts: number;
}): MillMetricPromptClass {
  if (!boundary) {
    if (hasSeenTurnEnd || hasSeenPriorPrompt) return 'interruption';
    return 'followup';
  }
  if (boundary.wasAwaitingInput) return 'answer';
  const elapsedSinceBoundaryMs = ts - boundary.ts;
  if (!Number.isFinite(elapsedSinceBoundaryMs) || elapsedSinceBoundaryMs < TITLE_RACE_MS) return 'ambiguous';
  return 'followup';
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
  const day = utcDay(accumulator.startedAt);
  if (!day) return null;
  const packs: MillMetricPack[] = [];
  for (const [packName, pack] of accumulator.packs instanceof Map ? accumulator.packs : []) {
    if (typeof packName !== 'string' || !packName) continue;
    packs.push({
      name: packName,
      version: typeof pack.version === 'string' ? pack.version : '',
      tokenEstimate: numberOrNull(pack.tokenEstimate),
    });
  }
  return {
    sessionId: accumulator.sessionId,
    day,
    startedAt: accumulator.startedAt,
    endedAt: numberOrNull(endedAt),
    agent: accumulator.agent,
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

function mergePacks(earlier: MillMetricPack[], later: MillMetricPack[]): MillMetricPack[] {
  const packsByName = new Map<string, MillMetricPack>();
  for (const pack of [...(earlier || []), ...(later || [])]) {
    if (!pack || typeof pack.name !== 'string' || !pack.name) continue;
    const current = packsByName.get(pack.name);
    if (!current) {
      packsByName.set(pack.name, pack);
      continue;
    }
    packsByName.set(pack.name, {
      name: pack.name,
      version: pack.version,
      tokenEstimate: pack.tokenEstimate,
    });
  }
  return Array.from(packsByName.values());
}

function mergeSessionRecords(first: MillMetricSession, second: MillMetricSession): MillMetricSession {
  const earlier = first.startedAt <= second.startedAt ? first : second;
  const later = earlier === first ? second : first;
  return {
    sessionId: later.sessionId,

    day: later.day,
    startedAt: earlier.startedAt,
    endedAt: later.endedAt,
    agent: later.agent,
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
    packs: mergePacks(earlier.packs, later.packs),
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
    liveSessions: 0,
    ambiguousPrompts: 0,
    firstDay: null,
    lastDay: null,
    outcomes: emptyOutcomeTotals(),
  };
}

function mean(total: number, count: number): number | null {
  if (count === 0) return null;
  return total / count;
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

  for (const record of mergeRecords(records, liveRecords)) {
    if (!Array.isArray(record.packs)) continue;
    const packsByName = new Map(record.packs.map((pack) => [pack.name, pack]));
    for (const packName of packsByName.keys()) {
      if (typeof packName !== 'string' || !packName) continue;
      const scorecard = totalsByPack.get(packName) || emptyScorecardTotals();
      scorecard.deliveries += 1;
      if (record.endedAt === null) scorecard.liveSessions += 1;
      scorecard.ambiguousPrompts += nonnegativeInteger(record.prompts?.ambiguous);
      updateDays(scorecard, record);
      addOutcome(scorecard.outcomes, record);
      totalsByPack.set(packName, scorecard);
    }
  }
  const scorecards: Record<string, PackScorecard> = {};
  for (const [packName, totals] of totalsByPack) {
    scorecards[packName] = {
      deliveries: totals.deliveries,
      outcomes: outcomeBucket(totals.outcomes),
      liveSessions: totals.liveSessions,
      ambiguousPrompts: totals.ambiguousPrompts,
      firstDay: totals.firstDay,
      lastDay: totals.lastDay,
    };
  }
  return scorecards;
}

export type MillMetricEndIntent = EndIntent;
export type { MillPromptBoundary, MillTurnBoundaryEvent, MillTurnBoundaryState, MillTurnBoundaryStep };
export type MillMetricPackAccumulator = AccumulatorPack;
export type MillMetricAccumulatorShape = MillMetricAccumulator;
export type MillMetricsConfig = { retainDays: number };
export type MillMetricsRawConfig = { retainDays?: unknown } | null | undefined;
export type MillPackScorecard = PackScorecard;

export {
  DEFAULT_MILL_METRICS_RETAIN_DAYS,
  TITLE_RACE_MS,
  buildScorecards,
  classifyPrompt,
  dispositionFor,
  initialTurnBoundaryState,
  mergeRecords,
  promptBoundaryOrNull,
  pruneRecords,
  recordFromAccumulator,
  reduceTurnBoundary,
  resolveMillMetricsConfig,
  utcDay,
};
