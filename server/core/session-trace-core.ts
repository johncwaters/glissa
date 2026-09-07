import type { TraceRecord } from '../../shared/contracts/trace.ts';
import { TraceRecord as TraceRecordSchema } from '../../shared/contracts/trace.ts';

export const MAX_SESSION_TRACE_READ_BYTES = 512 * 1024;

export interface SessionTracePage {
  records: TraceRecord[];
  start: number;
  next: number;
}

export interface SessionTracePageRequest {
  after: number;
  endingAt?: number | 'tail';
  size: number;
  now: number;
  vendorSessionId: string;
  readBytes: (offset: number, byteCount: number) => Promise<Uint8Array>;
}

function parseTraceLine(line: string): TraceRecord | null {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(line);
  } catch {
    return null;
  }
  const parsedRecord = TraceRecordSchema.safeParse(parsedJson);
  return parsedRecord.success ? parsedRecord.data : null;
}

export function sessionTracePageFromBytes(after: number, bytes: Uint8Array): SessionTracePage {
  let completeByteLength = bytes.length;
  while (completeByteLength > 0 && bytes[completeByteLength - 1] !== 0x0a) completeByteLength -= 1;
  if (completeByteLength === 0) return { records: [], start: after, next: after };

  const completeText = new TextDecoder().decode(bytes.subarray(0, completeByteLength));
  const records: TraceRecord[] = [];
  for (const line of completeText.split('\n')) {
    if (!line.trim()) continue;
    const record = parseTraceLine(line);
    if (record) records.push(record);
  }
  return { records, start: after, next: after + completeByteLength };
}

function skippedRecordNotice(request: SessionTracePageRequest, skippedBytes: number): TraceRecord {
  return {
    ts: request.now,
    uuid: null,
    parentUuid: null,
    vendorSessionId: request.vendorSessionId,
    kind: 'notice',
    text: `skipped one ${skippedBytes} byte record, larger than the ${MAX_SESSION_TRACE_READ_BYTES} byte page`,
  };
}

async function offsetAfterNextLine(request: SessionTracePageRequest, from: number): Promise<number | null> {
  let offset = from;
  while (offset < request.size) {
    const bytes = await request.readBytes(offset, Math.min(MAX_SESSION_TRACE_READ_BYTES, request.size - offset));
    if (bytes.length === 0) return null;
    const newlineIndex = bytes.indexOf(0x0a);
    if (newlineIndex >= 0) return offset + newlineIndex + 1;
    offset += bytes.length;
  }
  return null;
}

async function readPageAfter(request: SessionTracePageRequest): Promise<SessionTracePage> {
  const startOffset = Math.min(request.after, request.size);
  const windowByteCount = Math.min(MAX_SESSION_TRACE_READ_BYTES, request.size - startOffset);
  if (windowByteCount <= 0) return { records: [], start: startOffset, next: startOffset };

  const windowBytes = await request.readBytes(startOffset, windowByteCount);
  const page = sessionTracePageFromBytes(startOffset, windowBytes);
  if (page.next > startOffset) return page;

  const offsetPastRecord = await offsetAfterNextLine(request, startOffset + windowBytes.length);
  if (offsetPastRecord === null) return { records: [], start: startOffset, next: startOffset };
  return {
    records: [skippedRecordNotice(request, offsetPastRecord - startOffset)],
    start: startOffset,
    next: offsetPastRecord,
  };
}

function firstWholeLineOffset(windowStart: number, bytes: Uint8Array): number | null {
  if (windowStart === 0) return 0;
  const newlineIndex = bytes.indexOf(0x0a);
  if (newlineIndex < 0) return null;
  return windowStart + newlineIndex + 1;
}

async function previousLineStart(request: SessionTracePageRequest, beforeOffset: number): Promise<number> {
  let scanEnd = beforeOffset;
  while (scanEnd > 0) {
    const scanStart = Math.max(0, scanEnd - MAX_SESSION_TRACE_READ_BYTES);
    const bytes = await request.readBytes(scanStart, scanEnd - scanStart);
    const newlineIndex = bytes.lastIndexOf(0x0a);
    if (newlineIndex >= 0) return scanStart + newlineIndex + 1;
    scanEnd = scanStart;
  }
  return 0;
}

async function readPageEndingAt(request: SessionTracePageRequest, endingAt: number | 'tail'): Promise<SessionTracePage> {
  const endOffset = endingAt === 'tail' ? request.size : Math.min(endingAt, request.size);
  if (endOffset <= 0) return { records: [], start: 0, next: 0 };

  const windowStart = Math.max(0, endOffset - MAX_SESSION_TRACE_READ_BYTES);
  const windowBytes = await request.readBytes(windowStart, endOffset - windowStart);
  const lineStart = firstWholeLineOffset(windowStart, windowBytes);
  if (lineStart !== null) {
    const page = sessionTracePageFromBytes(lineStart, windowBytes.subarray(lineStart - windowStart));
    if (page.next > lineStart || windowStart === 0) return page;
  }
  const skippedRecordStart = await previousLineStart(request, windowStart);
  const endsOnLineBoundary = windowBytes[windowBytes.length - 1] === 0x0a;
  return {
    records: [skippedRecordNotice(request, endOffset - skippedRecordStart)],
    start: skippedRecordStart,
    next: endsOnLineBoundary ? endOffset : skippedRecordStart,
  };
}

export async function readSessionTracePage(request: SessionTracePageRequest): Promise<SessionTracePage> {
  if (request.endingAt !== undefined) return readPageEndingAt(request, request.endingAt);
  return readPageAfter(request);
}
