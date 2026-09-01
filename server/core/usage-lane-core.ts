/*
 * Pure rules for LANE ATTRIBUTION: which of Glissa's own automation lanes a supervised session belonged to.
 *
 * This is the one thing a usage tool that only reads transcripts cannot do. Glissa SPAWNS its sessions, so
 * it knows that a given session id was the PR-review lane rather than someone typing, and can answer "what
 * did the review lane cost this week".
 *
 * The join is exact, never inferred: a session id is attributed only because Glissa recorded spawning it.
 * Anything not in the ledger is `other` (a terminal session, a direct CLI run, a session from before the
 * ledger existed). Guessing from a cwd or a project directory would silently mis-bill a lane.
 *
 * Identity is a VENDOR-NAMESPACED COMPOSITE key `<vendor>:<sessionId>`, the same shape the scanner's dedup
 * keys already use (usage-codex-core / usage-grok-core put the vendor in the first segment). Without it a
 * codex session id could collide with a claude one now that Glissa supervises both. Old ledger files
 * (written before the vendor field, keyed `claudeSessionId`) round-trip as vendor `claude`.
 */

import { safeNumber, stringOrNull } from './usage-number-core.ts';

export interface LaneLedgerEntry {
  vendor: string;
  sessionId: string;
  lane: string;
  ts: number;
}

// The ledger is read back off disk, where an array can hold a null the writer never put there.
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

// The lane ids are the names the lanes already call themselves (registerEphemeralSession's logPrefix), so
// there is no mapping table here to drift out of step with the code that spawns them.
const INTERACTIVE_LANE = 'interactive';
const OTHER_LANE = 'other';

// An absent vendor means claude: the field was added in M5, and every ledger entry and usage entry that
// predates it is a claude one.
function vendorOf(value: unknown): string {
  const vendor = stringOrNull(value);
  return vendor === null ? 'claude' : vendor;
}

// The composite key both halves of the join build the same way, so a ledger entry and a usage entry for
// the same session land on the same key regardless of which wrote first.
function laneKey(vendor: unknown, sessionId: string): string {
  return `${vendorOf(vendor)}:${sessionId}`;
}

function normalizeLedgerEntry(entry: RawLaneLedgerEntry | null | undefined): LaneLedgerEntry | null {
  // sessionId is the M5 field name; claudeSessionId is the pre-M5 spelling, read for round-trip.
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
    // Last write wins per composite key: a session id belongs to exactly one lane, and the newest record
    // is the one that observed the spawn.
    const key = laneKey(entry.vendor, entry.sessionId);
    const existing = byKey.get(key);
    if (existing && existing.ts > entry.ts) continue;
    byKey.set(key, entry);
  }
  return Array.from(byKey.values()).sort(compareEntries);
}

// Retention matches the warehouse's, so a lane row can still be explained for as long as the day it came
// from is still on the daily series.
function pruneLedger(
  entries: RawLedgerEntries,
  { now, retainDays }: { now?: unknown; retainDays?: unknown } = {},
): LaneLedgerEntry[] {
  const normalized = normalizeLedger(entries);
  const days = typeof retainDays === 'number' && Number.isInteger(retainDays) && retainDays > 0 ? retainDays : null;
  const nowMs = safeNumber(now);
  if (days === null || nowMs <= 0) return normalized;
  const cutoff = nowMs - days * 24 * 60 * 60 * 1000;
  // A ts of 0 means an entry from a writer that did not stamp one; keep it rather than drop history on a
  // technicality, since losing an attribution is worse than keeping a stale one.
  return normalized.filter((entry) => entry.ts === 0 || entry.ts >= cutoff);
}

function laneMapFromLedger(entries: RawLedgerEntries): Map<string, string> {
  const laneByKey = new Map<string, string>();
  for (const entry of normalizeLedger(entries)) laneByKey.set(laneKey(entry.vendor, entry.sessionId), entry.lane);
  return laneByKey;
}

/*
 * Rows for the report, biggest spend first. Every vendor participates now that Glissa supervises codex/grok
 * cards: an entry whose composite key was recorded gets that lane, and everything else is `other` (a
 * terminal run of any CLI, or usage from before the ledger). `sessions` counts DISTINCT session ids, which
 * is what makes a lane row comparable over time (one long review costs more than three short ones, and the
 * count says which shape it was).
 */
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

// Local rather than imported from usage-entry-core: that module owns transcript parsing, and this one only
// needs the sum, so importing it would couple lane attribution to the parser.
function totalTokensOf(entry: LaneUsageEntry | null | undefined): number {
  return safeNumber(entry?.input) + safeNumber(entry?.output) + safeNumber(entry?.cacheCreate) + safeNumber(entry?.cacheRead);
}

function compareEntries(a: LaneLedgerEntry, b: LaneLedgerEntry): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  return laneKey(a.vendor, a.sessionId).localeCompare(laneKey(b.vendor, b.sessionId));
}

export { INTERACTIVE_LANE, OTHER_LANE, laneKey, laneMapFromLedger, laneRollup, normalizeLedger, pruneLedger };
