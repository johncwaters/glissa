import { decideFileRead, splitLines } from './usage-scan-core.ts';

const MAX_CATCH_UP_BYTES = 256 * 1024;
const DEFAULT_MAX_TRACKED = 256;

const HEAD_SAMPLE_BYTES = 512;

const LISTING_SETTLE_MS = 2000;

export interface TailStat {
  size?: number;
  mtimeMs?: number;
  ino?: number;
  birthtimeMs?: number;
}

export interface TailState {
  path: string | null;
  identity: string;
  size: number;
  mtimeMs: number;
  offset: number;
  carry: string;
  head: string | null;
  vendorState: Record<string, string> | null;
}

export interface TailReadPlan {
  action: 'seed' | 'skip' | 'reset' | 'read';
  start: number;
  end: number;
  reset: boolean;
  dropPartial: boolean;
  sampleHead: boolean;
}

function finiteOr(value: unknown, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return number;
}

function fileIdentity(stat: TailStat | null | undefined): string {
  return `${Math.floor(finiteOr(stat?.ino, 0))}:${Math.floor(finiteOr(stat?.birthtimeMs, 0))}`;
}

function headSample(bytes: unknown): string | null {
  if (!Buffer.isBuffer(bytes)) return null;
  return bytes.subarray(0, HEAD_SAMPLE_BYTES).toString('latin1');
}

function headChanged(state: { head?: string | null } | null | undefined, head: unknown): boolean {
  const recorded = state?.head;
  if (typeof recorded !== 'string' || recorded.length === 0) return false;
  if (typeof head !== 'string') return false;
  return !head.startsWith(recorded);
}

function createTailState(
  stat: TailStat | null | undefined,
  { path: filePath = null, head = null }: { path?: string | null; head?: string | null } = {},
): TailState {
  const size = Math.max(0, Math.floor(finiteOr(stat?.size, 0)));
  return {
    path: filePath,
    identity: fileIdentity(stat),
    size,
    mtimeMs: finiteOr(stat?.mtimeMs, 0),
    offset: size,
    carry: '',
    head: typeof head === 'string' ? head : null,
    vendorState: null,
  };
}

function skipPlan(state: TailState): TailReadPlan {
  return {
    action: 'skip', start: state.offset, end: state.offset, reset: false, dropPartial: false, sampleHead: false,
  };
}

function planRead(
  state: TailState | null | undefined,
  stat: TailStat | null | undefined,
  { maxCatchUpBytes = MAX_CATCH_UP_BYTES }: { maxCatchUpBytes?: number } = {},
): TailReadPlan {
  if (!state) {
    return {
      action: 'seed', start: 0, end: 0, reset: true, dropPartial: false, sampleHead: false,
    };
  }
  if (!stat || typeof stat.size !== 'number') return skipPlan(state);
  const rotated = fileIdentity(stat) !== state.identity;
  const decision = decideFileRead({ size: state.size, mtimeMs: state.mtimeMs, offset: state.offset }, stat);
  if (!rotated && decision.action === 'skip') return skipPlan(state);
  const reset = rotated || decision.action === 'restart';
  const end = Math.max(0, Math.floor(stat.size));
  let start = Math.min(Math.max(0, decision.readFrom), end);
  if (reset) start = 0;
  let dropPartial = false;
  const bound = Math.max(1, Math.floor(maxCatchUpBytes));
  if (end - start > bound) {
    start = end - bound;
    dropPartial = true;
  }
  if (end <= start) {
    return {
      action: 'reset', start, end, reset, dropPartial: false, sampleHead: false,
    };
  }
  return {
    action: 'read', start, end, reset, dropPartial, sampleHead: !reset,
  };
}

function splitKeepingEmpty(carry: string, chunkText: string): { lines: string[]; carry: string } {
  const text = `${carry || ''}${chunkText || ''}`;
  const lines = text.split(/\r?\n/);

  const nextCarry = lines.pop();
  return { lines, carry: nextCarry || '' };
}

function afterFirstBreak(text: string): string {
  const firstBreak = text.indexOf('\n');
  if (firstBreak === -1) return '';
  return text.slice(firstBreak + 1);
}

function applyRead(state: TailState, {
  text = '', end = 0, stat = null, head = null, reset = false, dropPartial = false, keepEmptyLines = false,
}: {
  text?: string;
  end?: number;
  stat?: TailStat | null;
  head?: string | null;
  reset?: boolean;
  dropPartial?: boolean;
  keepEmptyLines?: boolean;
} = {}): string[] {
  if (reset || dropPartial) state.carry = '';
  if (reset) {
    state.vendorState = null;
    state.head = null;
  }
  if (typeof head === 'string' && head.length > 0) state.head = head;
  const body = dropPartial ? afterFirstBreak(text) : text;
  const split = keepEmptyLines ? splitKeepingEmpty(state.carry, body) : splitLines(state.carry, body);
  state.carry = split.carry;
  state.offset = Math.max(0, Math.floor(finiteOr(end, state.offset)));
  state.size = Math.max(state.offset, Math.floor(finiteOr(stat?.size, state.offset)));
  state.mtimeMs = finiteOr(stat?.mtimeMs, state.mtimeMs);
  if (stat) state.identity = fileIdentity(stat);
  return split.lines;
}

function isActiveMtime(mtimeMs: unknown, { now, withinMs }: { now?: unknown; withinMs?: unknown }): boolean {
  return finiteOr(mtimeMs, 0) >= finiteOr(now, 0) - Math.max(0, finiteOr(withinMs, 0));
}

function canTrustCachedListing({ mtimeMs, listedAtMs }: { mtimeMs?: unknown; listedAtMs?: unknown } = {}): boolean {
  return finiteOr(listedAtMs, 0) - finiteOr(mtimeMs, 0) >= LISTING_SETTLE_MS;
}

function pickStaleByMtime<TKey>(
  entriesByKey: Map<TKey, { mtimeMs?: number } | null | undefined>,
  { maxTracked = DEFAULT_MAX_TRACKED }: { maxTracked?: number } = {},
): TKey[] {
  const entries = [...entriesByKey.entries()];
  const bound = Math.max(1, Math.floor(maxTracked));
  if (entries.length <= bound) return [];
  entries.sort((left, right) => finiteOr(left[1]?.mtimeMs, 0) - finiteOr(right[1]?.mtimeMs, 0));
  return entries.slice(0, entries.length - bound).map(([key]) => key);
}

export {
  DEFAULT_MAX_TRACKED,
  HEAD_SAMPLE_BYTES,
  LISTING_SETTLE_MS,
  MAX_CATCH_UP_BYTES,
  applyRead,
  canTrustCachedListing,
  createTailState,
  fileIdentity,
  headChanged,
  headSample,
  isActiveMtime,
  pickStaleByMtime,
  planRead,
};
