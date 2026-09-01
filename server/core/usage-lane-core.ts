import { safeNumber, stringOrNull } from './usage-number-core.ts';

export interface LaneLedgerEntry {
  vendor: string;
  sessionId: string;
  lane: string;
  ts: number;
}

type RawLedgerEntries = (RawLaneLedgerEntry | null | undefined)[] | null | undefined;

interface RawLaneLedgerEntry {
  vendor?: unknown;
  sessionId?: unknown;
  claudeSessionId?: unknown;
  lane?: unknown;
  ts?: unknown;
}

interface LaneUsageEntry {
  vendor?: unknown;
  sessionId?: unknown;
  input?: number;
  output?: number;
  cacheCreate?: number;
  cacheRead?: number;
  costUSD?: number | null;
}

export interface LaneRollupRow {
  lane: string;
  tokens: number;
  costUSD: number;
  sessions: number;
}

const INTERACTIVE_LANE = 'interactive';
const OTHER_LANE = 'other';

function vendorOf(value: unknown): string {
  const vendor = stringOrNull(value);
  return vendor === null ? 'claude' : vendor;
}

function laneKey(vendor: unknown, sessionId: string): string {
  return `${vendorOf(vendor)}:${sessionId}`;
}

function normalizeLedgerEntry(entry: RawLaneLedgerEntry | null | undefined): LaneLedgerEntry | null {
  const sessionId = stringOrNull(entry?.sessionId) || stringOrNull(entry?.claudeSessionId);
  const lane = stringOrNull(entry?.lane);
  if (!sessionId || !lane) return null;
  const vendor = vendorOf(entry?.vendor);
  const ts = safeNumber(entry?.ts);
  return { vendor, sessionId, lane, ts: ts > 0 ? ts : 0 };
}

function normalizeLedger(entries: RawLedgerEntries): LaneLedgerEntry[] {
  const byKey = new Map<string, LaneLedgerEntry>();
  for (const raw of entries || []) {
    const entry = normalizeLedgerEntry(raw);
    if (!entry) continue;

    const key = laneKey(entry.vendor, entry.sessionId);
    const existing = byKey.get(key);
    if (existing && existing.ts > entry.ts) continue;
    byKey.set(key, entry);
  }
  return Array.from(byKey.values()).sort(compareEntries);
}

function pruneLedger(
  entries: RawLedgerEntries,
  { now, retainDays }: { now?: unknown; retainDays?: unknown } = {},
): LaneLedgerEntry[] {
  const normalized = normalizeLedger(entries);
  const days = typeof retainDays === 'number' && Number.isInteger(retainDays) && retainDays > 0 ? retainDays : null;
  const nowMs = safeNumber(now);
  if (days === null || nowMs <= 0) return normalized;
  const cutoff = nowMs - days * 24 * 60 * 60 * 1000;

  return normalized.filter((entry) => entry.ts === 0 || entry.ts >= cutoff);
}

function laneMapFromLedger(entries: RawLedgerEntries): Map<string, string> {
  const laneByKey = new Map<string, string>();
  for (const entry of normalizeLedger(entries)) laneByKey.set(laneKey(entry.vendor, entry.sessionId), entry.lane);
  return laneByKey;
}

function laneRollup(
  entries: LaneUsageEntry[] | null | undefined,
  laneById: Map<string, string> | null | undefined,
): LaneRollupRow[] {
  const map = laneById instanceof Map ? laneById : new Map<string, string>();
  const byLane = new Map<string, { lane: string; tokens: number; costUSD: number; sessionKeys: Set<string> }>();
  for (const entry of entries || []) {
    const sessionId = stringOrNull(entry.sessionId);
    const key = sessionId ? laneKey(entry.vendor, sessionId) : null;
    const lane = (key && map.get(key)) || OTHER_LANE;
    const bucket = byLane.get(lane) || { lane, tokens: 0, costUSD: 0, sessionKeys: new Set() };
    bucket.tokens += totalTokensOf(entry);
    bucket.costUSD += safeNumber(entry.costUSD);
    if (key) bucket.sessionKeys.add(key);
    byLane.set(lane, bucket);
  }
  return Array.from(byLane.values())
    .map((bucket) => ({ lane: bucket.lane, tokens: bucket.tokens, costUSD: bucket.costUSD, sessions: bucket.sessionKeys.size }))
    .sort((a, b) => b.costUSD - a.costUSD || b.tokens - a.tokens || a.lane.localeCompare(b.lane));
}

function totalTokensOf(entry: LaneUsageEntry | null | undefined): number {
  return safeNumber(entry?.input) + safeNumber(entry?.output) + safeNumber(entry?.cacheCreate) + safeNumber(entry?.cacheRead);
}

function compareEntries(a: LaneLedgerEntry, b: LaneLedgerEntry): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  return laneKey(a.vendor, a.sessionId).localeCompare(laneKey(b.vendor, b.sessionId));
}

export { INTERACTIVE_LANE, OTHER_LANE, laneKey, laneMapFromLedger, laneRollup, normalizeLedger, pruneLedger };
