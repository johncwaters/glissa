/*
 * M14 of docs/plan-visions-3.md: every decision the memory ingest consumer makes. Which mapped agent-log
 * events become which durable records, what a per-tick batch is, and where a resumed read starts.
 *
 * The trust field is stamped HERE, from the write path, and is never read off the event: a transcript is
 * third-party text whatever it claims about itself, so nothing that arrives this way exceeds `reported`.
 */

import { PROMPT_KIND } from './ingest-agent-core.ts';
import type { KnownProjects } from './memory-core.ts';
import { SOURCE_VENDORS, canonicalProjectPath, dropEchoedLines } from './memory-core.ts';

const AGENT_LOG_SOURCE = 'agentLogs';

// `prompt` is absent from PROJECTED_KINDS on purpose: raw operator text must never reach dist/.
// `agent-tool` is absent because a tool invocation is activity, not a remembered fact: admitting it made
// 53% of the canon verbatim `Bash` command lines, which the distill lane then paid prompt tokens to read
// (2026-08-27). Tool events still reach the live ingest ring; they just stop becoming records.
const RECORD_KIND_BY_EVENT_KIND: Readonly<Record<string, string>> = Object.freeze({
  'agent-turn': 'knowledge',
  [PROMPT_KIND]: 'prompt',
});

const DEFAULT_MAX_RECORDS_PER_TICK = 20;
const DEFAULT_MAX_QUEUED = 500;
const DEFAULT_MAX_TAIL_ENTRIES = 512;
const TAIL_STATE_VERSION = 1;

export interface MemoryIngestInput {
  kind: string;
  layer: string;
  project: string;
  ts: number | null;
  source: { kind: string; vendor: string; sessionId: string | null };
  text: string;
  fromUserPrompt: boolean;
  [key: string]: unknown;
}

export interface TailEntry {
  size: number;
  mtimeMs: number;
  offset: number;
  ts: number;
}

export interface TailState {
  version: number;
  files: Record<string, TailEntry>;
}

export interface IngestEventLike {
  source?: string;
  kind?: string;
  detail?: { vendor?: string } | null;
  scope?: { root?: unknown; sessionId?: unknown } | null;
  summary?: unknown;
  ts?: unknown;
}

function finiteOr(value: unknown, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return number;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// A rootless event is dropped for the ring's own reason: machine scope lands in every project's retrieval.
function memoryInputFromEvent(
  event: IngestEventLike | null | undefined,
  {
    deliveredHashes = null,
    knownProjects = [],
  }: { deliveredHashes?: unknown; knownProjects?: KnownProjects } = {},
): MemoryIngestInput | null {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  if (event.source !== AGENT_LOG_SOURCE) return null;
  if (typeof event.kind !== 'string') return null;
  const kind = RECORD_KIND_BY_EVENT_KIND[event.kind];
  if (!kind) return null;
  const eventVendor = event.detail?.vendor;
  const vendor = typeof eventVendor === 'string' && SOURCE_VENDORS.includes(eventVendor) ? eventVendor : null;
  if (!vendor) return null;
  const project = canonicalProjectPath(nonEmptyString(event.scope?.root), knownProjects);
  if (!project) return null;
  const summary = typeof event.summary === 'string' ? event.summary : '';
  // Echo suppression: a session quoting its own delivered memory back must not re-ingest it.
  const text = deliveredHashes ? dropEchoedLines(summary, deliveredHashes) : summary;
  if (!text.trim()) return null;
  const ts = finiteOr(event.ts, 0);
  return {
    kind,
    layer: 'episodic',
    project,
    ts: ts > 0 ? Math.floor(ts) : null,
    source: { kind: 'reported', vendor, sessionId: nonEmptyString(event.scope?.sessionId) },
    text,
    fromUserPrompt: event.kind === PROMPT_KIND,
  };
}

// Oldest-first eviction: a flood of new turns is worth more than the start of the flood it displaced.
function enqueueIngestInput<TInput>(
  queued: unknown,
  input: TInput | null | undefined,
  { maxQueued = DEFAULT_MAX_QUEUED }: { maxQueued?: number } = {},
): { queue: TInput[]; dropped: number } {
  const list = Array.isArray(queued) ? (queued as TInput[]) : [];
  if (!input) return { queue: list, dropped: 0 };
  const bound = Math.max(1, Math.floor(maxQueued));
  const next = [...list, input];
  if (next.length <= bound) return { queue: next, dropped: 0 };
  const overflow = next.length - bound;
  return { queue: next.slice(overflow), dropped: overflow };
}

// One tick writes at most this many records, and the caller yields between the batches.
function planIngestBatch<TInput>(
  queued: unknown,
  { maxPerTick = DEFAULT_MAX_RECORDS_PER_TICK }: { maxPerTick?: number } = {},
): { take: TInput[]; rest: TInput[] } {
  const list = Array.isArray(queued) ? (queued as TInput[]) : [];
  const bound = Math.max(1, Math.floor(maxPerTick));
  return { take: list.slice(0, bound), rest: list.slice(bound) };
}

// --- Durable offsets ------------------------------------------------------

function normalizeTailEntry(raw: unknown): TailEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const fields = raw as Record<string, unknown>;
  const size = finiteOr(fields.size, -1);
  const offset = finiteOr(fields.offset, -1);
  if (size < 0 || offset < 0) return null;
  return {
    size: Math.floor(size),
    mtimeMs: finiteOr(fields.mtimeMs, 0),
    offset: Math.floor(offset),
    ts: finiteOr(fields.ts, 0),
  };
}

function normalizeTailState(raw: unknown): TailState {
  const source: Record<string, unknown> = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  const rawFilesValue = source.files;
  const rawFiles: Record<string, unknown> = rawFilesValue && typeof rawFilesValue === 'object' && !Array.isArray(rawFilesValue)
    ? (rawFilesValue as Record<string, unknown>)
    : {};
  const files: Record<string, TailEntry> = {};
  for (const [filePath, entry] of Object.entries(rawFiles)) {
    const normalized = normalizeTailEntry(entry);
    if (!filePath || !normalized) continue;
    files[filePath] = normalized;
  }
  return { version: TAIL_STATE_VERSION, files };
}

// Newest-first by the moment each offset was recorded, so a bounded state forgets what stopped moving.
function recordTailOffset(
  state: unknown,
  entry: unknown,
  { maxEntries = DEFAULT_MAX_TAIL_ENTRIES }: { maxEntries?: number } = {},
): TailState {
  const current = normalizeTailState(state);
  const filePath = nonEmptyString((entry as { path?: unknown } | null | undefined)?.path);
  const normalized = normalizeTailEntry(entry);
  if (!filePath || !normalized) return current;
  const files = { ...current.files, [filePath]: normalized };
  const bound = Math.max(1, Math.floor(maxEntries));
  const paths = Object.keys(files);
  if (paths.length <= bound) return { version: TAIL_STATE_VERSION, files };
  paths.sort((left, right) => files[right].ts - files[left].ts);
  const kept: Record<string, TailEntry> = {};
  for (const key of paths.slice(0, bound)) kept[key] = files[key];
  return { version: TAIL_STATE_VERSION, files: kept };
}

function tailStateForget(state: unknown, filePaths: unknown): TailState {
  const current = normalizeTailState(state);
  const drop = new Set(Array.isArray(filePaths) ? filePaths : []);
  const files: Record<string, TailEntry> = {};
  for (const [filePath, entry] of Object.entries(current.files)) {
    if (drop.has(filePath)) continue;
    files[filePath] = entry;
  }
  return { version: TAIL_STATE_VERSION, files };
}

// Unknown is a cold start from the top; a mismatch restarts at EOF, since the offset indexes a file that is gone.
function decideResumeRead(
  recorded: unknown,
  stat: { size?: unknown; mtimeMs?: unknown } | null | undefined,
): { action: string; start: number; reason: string | null } {
  const size = Math.max(0, Math.floor(finiteOr(stat?.size, 0)));
  const entry = normalizeTailEntry(recorded);
  if (!entry) return { action: 'cold', start: 0, reason: 'unknown' };
  if (size < entry.size || size < entry.offset) return { action: 'restart', start: size, reason: 'shrank' };
  const mtimeMs = finiteOr(stat?.mtimeMs, 0);
  if (mtimeMs < entry.mtimeMs) return { action: 'restart', start: size, reason: 'rewound' };
  if (size === entry.offset) return { action: 'current', start: size, reason: null };
  return { action: 'resume', start: entry.offset, reason: null };
}

// `partial` means the budget ran out before EOF, which is what the recorded offset makes resumable.
function planBackfillRead({
  start = 0,
  size = 0,
  budgetBytes = 0,
  maxChunkBytes = 0,
}: { start?: number; size?: number; budgetBytes?: number; maxChunkBytes?: number } = {}): {
  action: string;
  start: number;
  end: number;
  partial: boolean;
} {
  const from = Math.max(0, Math.floor(finiteOr(start, 0)));
  const end = Math.max(from, Math.floor(finiteOr(size, 0)));
  const budget = Math.max(0, Math.floor(finiteOr(budgetBytes, 0)));
  const chunk = Math.max(1, Math.floor(finiteOr(maxChunkBytes, 1)));
  if (end === from) return { action: 'skip', start: from, end: from, partial: false };
  if (budget <= 0) return { action: 'skip', start: from, end: from, partial: true };
  const length = Math.min(end - from, budget, chunk);
  return { action: 'read', start: from, end: from + length, partial: from + length < end };
}

export {
  AGENT_LOG_SOURCE,
  DEFAULT_MAX_QUEUED,
  DEFAULT_MAX_RECORDS_PER_TICK,
  DEFAULT_MAX_TAIL_ENTRIES,
  RECORD_KIND_BY_EVENT_KIND,
  TAIL_STATE_VERSION,
  decideResumeRead,
  enqueueIngestInput,
  memoryInputFromEvent,
  normalizeTailState,
  planBackfillRead,
  planIngestBatch,
  recordTailOffset,
  tailStateForget,
};
