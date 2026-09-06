import path from 'node:path';

import { parseJson } from './ingest-agent-core.ts';

const MAX_TRANSCRIPT_READ_BYTES = 1024 * 1024;
const MAX_PARTIAL_LINE_BYTES = 8 * 1024 * 1024;
const MAX_SUBAGENT_READ_BYTES = 8 * 1024 * 1024;
const TRACE_TAIL_SCAN_BYTES = 64 * 1024;
const MAX_REMEMBERED_TRANSCRIPTS = 16;
const LINE_BREAK = 0x0a;

interface TraceReadPlan {
  action: 'read' | 'skip';
  start: number;
  end: number;
  reset: boolean;
}

interface TraceResumePoint {
  offset: number;
  didReset: boolean;
}

function wholeNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function planContiguousRead(
  state: { offset?: unknown } | null | undefined,
  stat: { size?: unknown } | null | undefined,
  { maxReadBytes = MAX_TRANSCRIPT_READ_BYTES }: { maxReadBytes?: number } = {},
): TraceReadPlan {
  const committedOffset = wholeNumber(state?.offset, 0);
  if (!state || !stat || !Number.isFinite(Number(stat.size))) {
    return { action: 'skip', start: committedOffset, end: committedOffset, reset: false };
  }
  const size = wholeNumber(stat.size, 0);
  const reset = size < committedOffset;
  const start = reset ? 0 : committedOffset;
  const end = Math.min(size, start + Math.max(1, Math.floor(maxReadBytes)));
  if (end <= start) return { action: 'skip', start, end: start, reset };
  return { action: 'read', start, end, reset };
}

function completeLineBytes(chunk: Buffer): number {
  return chunk.lastIndexOf(LINE_BREAK) + 1;
}

function committedOffsetFor(offsets: unknown, transcriptPath: string): number {
  if (!offsets || typeof offsets !== 'object' || Array.isArray(offsets)) return 0;
  return wholeNumber((offsets as Record<string, unknown>)[transcriptPath], 0);
}

function withCommittedOffset(
  offsets: Record<string, number>,
  transcriptPath: string,
  offset: number,
): Record<string, number> {
  const remembered: Record<string, number> = {};
  for (const [knownPath, knownOffset] of Object.entries(offsets)) {
    if (knownPath === transcriptPath) continue;
    remembered[knownPath] = knownOffset;
  }
  remembered[transcriptPath] = wholeNumber(offset, 0);
  const rememberedPaths = Object.keys(remembered);
  const overflow = rememberedPaths.length - MAX_REMEMBERED_TRANSCRIPTS;
  if (overflow <= 0) return remembered;
  for (const stalePath of rememberedPaths.slice(0, overflow)) delete remembered[stalePath];
  return remembered;
}

function committedOffsetFromTraceTail(tailText: string, {
  transcriptPath,
  pathBeforeWindow = null,
  isWholeFile = false,
}: { transcriptPath: string; pathBeforeWindow?: string | null; isWholeFile?: boolean }): number {
  const lines = tailText.split('\n');
  if (!isWholeFile) lines.shift();
  const records: Record<string, unknown>[] = [];
  for (const line of lines) {
    const record = parseJson(line);
    if (record) records.push(record);
  }
  const startsANewRun = records.some((record) => record.kind === 'session');
  let pathOfCurrentRun = startsANewRun ? null : pathBeforeWindow;
  let tracedOffset = 0;
  for (const record of records) {
    if (record.kind === 'session') {
      pathOfCurrentRun = typeof record.transcriptPath === 'string' ? record.transcriptPath : null;
    }
    if (pathOfCurrentRun !== transcriptPath) continue;
    tracedOffset = Math.max(tracedOffset, wholeNumber(record.transcriptOffset, 0));
  }
  return tracedOffset;
}

function resumeOffsetFrom(
  checkpoint: { transcriptPath?: unknown; offset?: unknown; offsetByTranscriptPath?: unknown } | null | undefined,
  { transcriptPath, size, alreadyTracedOffset = 0 }:
    { transcriptPath: string; size: number; alreadyTracedOffset?: number },
): TraceResumePoint {
  const fromLatestPath = checkpoint && checkpoint.transcriptPath === transcriptPath
    ? wholeNumber(checkpoint.offset, 0)
    : 0;
  const committed = Math.max(
    fromLatestPath,
    committedOffsetFor(checkpoint?.offsetByTranscriptPath, transcriptPath),
    wholeNumber(alreadyTracedOffset, 0),
  );
  if (committed === 0) return { offset: 0, didReset: false };
  if (committed > wholeNumber(size, 0)) return { offset: 0, didReset: true };
  return { offset: committed, didReset: false };
}

function isPathInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isOversizedPartialLine(carry: string, { maxPartialLineBytes = MAX_PARTIAL_LINE_BYTES } = {}): boolean {
  return Buffer.byteLength(carry, 'utf8') > Math.max(1, Math.floor(maxPartialLineBytes));
}

export {
  MAX_REMEMBERED_TRANSCRIPTS,
  MAX_SUBAGENT_READ_BYTES,
  MAX_TRANSCRIPT_READ_BYTES,
  TRACE_TAIL_SCAN_BYTES,
  committedOffsetFromTraceTail,
  completeLineBytes,
  isOversizedPartialLine,
  isPathInsideRoot,
  planContiguousRead,
  resumeOffsetFrom,
  withCommittedOffset,
};
