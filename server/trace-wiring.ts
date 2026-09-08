import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { FileHandle } from 'node:fs/promises';

import type { TraceCheckpoint, TraceRecord } from '../shared/contracts/trace.ts';
import {
  TraceCheckpoint as TraceCheckpointSchema,
  TraceRecord as TraceRecordSchema,
} from '../shared/contracts/trace.ts';
import { claudeProjectsDir } from '../session/core/conversation-history.ts';
import { openContainedFile } from './contained-file.ts';
import { applyRead, createTailState } from './core/ingest-tail-core.ts';
import type { TailState } from './core/ingest-tail-core.ts';
import { traceRecordsFromTranscriptLine } from './core/trace-core.ts';
import {
  LINE_BREAK,
  MAX_REMEMBERED_SUBAGENTS,
  MAX_SUBAGENT_CHUNKS_PER_STOP,
  MAX_TRANSCRIPT_READ_BYTES,
  TRACE_TAIL_SCAN_BYTES,
  committedOffsetFromTraceTailOrNull,
  completeLineBytes,
  containmentRefusalReason,
  isOversizedPartialLine,
  isPathInsideRoot,
  planContiguousRead,
  resumeOffsetFrom,
  withCommittedOffset,
} from './core/trace-tail-core.ts';
import type { ContainmentRefusal } from './core/trace-tail-core.ts';
import { readSessionTracePage } from './core/session-trace-core.ts';
import { isSafePathSegment } from './core/upload-core.ts';
import { appendJsonLines, createJsonStateWriter } from './json-file.ts';
import type { JsonStateWriter } from './json-file.ts';
import { createLaneLog } from './lane-log.ts';
import { configSiblingPath } from './pairings-store.ts';
import { pruneAgedFiles } from './prune-files.ts';

const TRACE_RETAIN_DAYS = 7;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;
const MAX_REMEMBERED_FILE_REFUSALS = 64;
const MAX_REMEMBERED_CLOSED_SESSIONS = 512;
const TRACE_SUFFIX = '.jsonl';
const CHECKPOINT_SUFFIX = '.checkpoint.json';
const NO_BYTES = Buffer.alloc(0);

export interface TracePageRequest {
  after: number;
  endingAt?: number | 'tail';
}

export interface TracePage {
  records: TraceRecord[];
  start: number;
  next: number;
  reset: boolean;
  path: string;
}

function isRewoundCursor(request: TracePageRequest, next: number): boolean {
  if (request.endingAt !== undefined) return false;
  return next < request.after;
}

interface TraceSession {
  id: string;
  on(event: string, listener: (payload: Record<string, unknown>) => void): unknown;
}

interface TraceWiringOptions {
  configPath?: string | null;
  logger?: Pick<Console, 'log' | 'warn'> | null;
  debug?: boolean | (() => boolean);
  nowFn?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn?: (handle: NodeJS.Timeout) => void;
}

interface TraceBinding {
  glissaSessionId: string;
  vendorSessionId: string;
  vendor: string;
  transcriptPath: string;
  requestedTranscriptPath: string;
  tailState: TailState;
  subagentPathsWithoutOffset: Set<string>;
  subagentOffsetByPath: Record<string, number>;
  notedFileRefusals: Set<string>;
  committedOffsetByTranscriptPath: Record<string, number>;
  checkpointWriter: JsonStateWriter;
  bindingBeforeFirstOpen: TraceBinding | null;
  isSkippingOversizedLine: boolean;
  hasOpenedTranscript: boolean;
  hasWarnedUnreadable: boolean;
  isClosing: boolean;
}

interface TraceResumeState {
  offset: number;
  didReset: boolean;
  didFallbackToTranscriptEnd: boolean;
  scannedBytes: number;
  committedOffsetByTranscriptPath: Record<string, number>;
  subagentPathsWithoutOffset: string[];
  subagentOffsetByPath: Record<string, number>;
}

interface LineContext {
  agentId?: string;
  agentType?: string;
}

interface PendingCommit {
  didAppend: boolean;
  appendedRecordCount: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function isResumePointMidLine(handle: FileHandle, offset: number): Promise<boolean> {
  if (offset <= 0) return false;
  const byteBeforeOffset = Buffer.alloc(1);
  const { bytesRead } = await handle.read(byteBeforeOffset, 0, 1, offset - 1);
  if (bytesRead <= 0) return false;
  return byteBeforeOffset[0] !== LINE_BREAK;
}

function trimOldest(entries: Set<string>, limit: number): void {
  while (entries.size > limit) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) return;
    entries.delete(oldest);
  }
}

function projectsRoot(): string {
  return claudeProjectsDir(process.env, os.homedir());
}

async function pruneTraceFiles({
  traceDirectory,
  now = Date.now(),
  isBoundSessionId = () => false,
}: {
  traceDirectory: string;
  now?: number;
  isBoundSessionId?: (glissaSessionId: string) => boolean;
}): Promise<number> {
  const removed = await pruneAgedFiles({
    directory: traceDirectory,
    suffixes: [CHECKPOINT_SUFFIX, TRACE_SUFFIX],
    retainDays: TRACE_RETAIN_DAYS,
    now,
    isRetainedId: isBoundSessionId,
  });
  return removed.length;
}

function createTraceWiring({
  configPath = null,
  logger = console,
  debug = false,
  nowFn = Date.now,
  setIntervalFn = (fn: () => void, ms: number) => setInterval(fn, ms),
  clearIntervalFn = clearInterval,
}: TraceWiringOptions = {}) {
  const traceDirectory = configSiblingPath(configPath, 'traces');
  const emitter = new EventEmitter();
  const bindingByGlissaSessionId = new Map<string, TraceBinding>();
  const pendingRecordsBySessionId = new Map<string, TraceRecord[]>();
  const closedSessionIds = new Set<string>();
  const attachedSessions = new WeakSet<object>();
  let pruneTimer: NodeJS.Timeout | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let hasStarted = false;
  let hasStopped = false;
  let hasEnsuredDirectory = false;
  let stopPromise: Promise<void> | null = null;
  let operationChain: Promise<void> = Promise.resolve();
  const laneLog = createLaneLog({ prefix: '[trace]', logger, debugFlag: debug });

  function chain(step: () => Promise<void>, failure: string): void {
    operationChain = operationChain
      .then(step)
      .catch((error: unknown) => { laneLog.warn(failure, { error: errorMessage(error) }); });
  }

  function traceFilePath(glissaSessionId: string): string | null {
    if (!isSafePathSegment(glissaSessionId)) return null;
    return path.join(traceDirectory, `${glissaSessionId}${TRACE_SUFFIX}`);
  }

  async function readTracePage(glissaSessionId: string, request: TracePageRequest): Promise<TracePage> {
    const filePath = traceFilePath(glissaSessionId);
    if (!filePath) return { records: [], start: 0, next: 0, reset: isRewoundCursor(request, 0), path: '' };
    let handle: FileHandle | null = null;
    try {
      handle = await fs.promises.open(filePath, 'r');
      const openHandle = handle;
      const stat = await openHandle.stat();
      const page = await readSessionTracePage({
        after: request.after,
        ...(request.endingAt !== undefined ? { endingAt: request.endingAt } : {}),
        size: stat.size,
        now: nowFn(),
        vendorSessionId: bindingByGlissaSessionId.get(glissaSessionId)?.vendorSessionId ?? 'unknown',
        readBytes: async (offset: number, byteCount: number) => {
          const buffer = Buffer.alloc(byteCount);
          const { bytesRead } = await openHandle.read(buffer, 0, byteCount, offset);
          return buffer.subarray(0, bytesRead);
        },
      });
      return { ...page, reset: isRewoundCursor(request, page.next), path: filePath };
    } catch (error) {
      if (containmentRefusalReason(error) !== 'missing') throw error;
      return { records: [], start: 0, next: 0, reset: isRewoundCursor(request, 0), path: filePath };
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  function queueRecord(glissaSessionId: string, record: TraceRecord): void {
    if (!traceFilePath(glissaSessionId)) return;
    const parsed = TraceRecordSchema.safeParse(record);
    if (!parsed.success) {
      laneLog.warn('record refused', { session: glissaSessionId });
      return;
    }
    const existing = pendingRecordsBySessionId.get(glissaSessionId);
    if (existing) {
      existing.push(parsed.data);
      return;
    }
    pendingRecordsBySessionId.set(glissaSessionId, [parsed.data]);
  }

  function requeueAtHead(glissaSessionId: string, records: TraceRecord[]): void {
    const queuedSince = pendingRecordsBySessionId.get(glissaSessionId) || [];
    pendingRecordsBySessionId.set(glissaSessionId, [...records, ...queuedSince]);
  }

  async function flushSession(glissaSessionId: string): Promise<boolean> {
    const records = pendingRecordsBySessionId.get(glissaSessionId);
    pendingRecordsBySessionId.delete(glissaSessionId);
    const filePath = traceFilePath(glissaSessionId);
    if (!filePath || !records || records.length === 0) return true;
    try {
      await appendJsonLines(filePath, records, { mkdir: !hasEnsuredDirectory, mode: 0o600 });
      hasEnsuredDirectory = true;
      emitter.emit('trace-appended', { id: glissaSessionId });
      return true;
    } catch (error) {
      laneLog.warn('append failed', { session: glissaSessionId, error: errorMessage(error) });
      requeueAtHead(glissaSessionId, records);
      return false;
    }
  }

  async function flushEverySession(): Promise<void> {
    for (const glissaSessionId of [...pendingRecordsBySessionId.keys()]) await flushSession(glissaSessionId);
  }

  function committedOffsetOf(binding: TraceBinding): number {
    return Math.max(0, binding.tailState.offset - Buffer.byteLength(binding.tailState.carry, 'utf8'));
  }

  function stampCommittedOffset(glissaSessionId: string, transcriptOffset: number): void {
    const records = pendingRecordsBySessionId.get(glissaSessionId);
    if (!records || records.length === 0) return;
    const last = records[records.length - 1];
    if (!last) return;
    records[records.length - 1] = { ...last, transcriptOffset };
  }

  async function writeCheckpoint(binding: TraceBinding): Promise<void> {
    const offset = committedOffsetOf(binding);
    binding.committedOffsetByTranscriptPath = withCommittedOffset(
      binding.committedOffsetByTranscriptPath,
      binding.transcriptPath,
      offset,
    );
    const checkpoint: TraceCheckpoint = {
      transcriptPath: binding.transcriptPath,
      vendorSessionId: binding.vendorSessionId,
      offset,
      ingestedSubagentPaths: [
        ...Object.keys(binding.subagentOffsetByPath),
        ...binding.subagentPathsWithoutOffset,
      ],
      offsetByTranscriptPath: binding.committedOffsetByTranscriptPath,
      subagentOffsetByPath: binding.subagentOffsetByPath,
    };
    await binding.checkpointWriter.write(checkpoint, () => JSON.stringify(checkpoint));
  }

  function checkpointFilePath(glissaSessionId: string): string | null {
    if (!isSafePathSegment(glissaSessionId)) return null;
    return path.join(traceDirectory, `${glissaSessionId}${CHECKPOINT_SUFFIX}`);
  }

  async function readCheckpoint(glissaSessionId: string): Promise<TraceCheckpoint | null> {
    const filePath = checkpointFilePath(glissaSessionId);
    if (!filePath) return null;
    try {
      const raw: unknown = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
      const parsed = TraceCheckpointSchema.safeParse(raw);
      if (!parsed.success) return null;
      return parsed.data;
    } catch {
      return null;
    }
  }

  async function tracedOffsetOf(
    glissaSessionId: string,
    transcriptPath: string,
    pathBeforeWindow: string | null,
  ): Promise<{ offset: number | null; scannedBytes: number; traceSize: number }> {
    const filePath = traceFilePath(glissaSessionId);
    if (!filePath) return { offset: 0, scannedBytes: 0, traceSize: 0 };
    let handle: FileHandle | null = null;
    try {
      handle = await fs.promises.open(filePath, 'r');
      const stat = await handle.stat();
      const start = Math.max(0, stat.size - TRACE_TAIL_SCAN_BYTES);
      const buffer = Buffer.alloc(stat.size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      return {
        offset: committedOffsetFromTraceTailOrNull(buffer.subarray(0, bytesRead).toString('utf8'), {
        transcriptPath,
        pathBeforeWindow,
        isWholeFile: start === 0,
        }),
        scannedBytes: bytesRead,
        traceSize: stat.size,
      };
    } catch {
      return { offset: 0, scannedBytes: 0, traceSize: 0 };
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  async function resumeStateFor(
    glissaSessionId: string,
    transcriptPath: string,
    size: number,
  ): Promise<TraceResumeState> {
    const checkpoint = await readCheckpoint(glissaSessionId);
    const traceTail = await tracedOffsetOf(
      glissaSessionId,
      transcriptPath,
      checkpoint ? checkpoint.transcriptPath : null,
    );
    const resume = resumeOffsetFrom(checkpoint, {
      transcriptPath,
      size,
      alreadyTracedOffset: traceTail.offset,
      traceSize: traceTail.traceSize,
    });
    const subagentOffsetByPath = checkpoint ? checkpoint.subagentOffsetByPath : {};
    const subagentPathsWithoutOffset = checkpoint
      ? checkpoint.ingestedSubagentPaths.filter((subagentPath) => !(subagentPath in subagentOffsetByPath))
      : [];
    return {
      offset: resume.offset,
      didReset: resume.didReset,
      didFallbackToTranscriptEnd: resume.didFallbackToTranscriptEnd,
      scannedBytes: traceTail.scannedBytes,
      committedOffsetByTranscriptPath: checkpoint ? checkpoint.offsetByTranscriptPath : {},
      subagentPathsWithoutOffset: subagentPathsWithoutOffset.slice(-MAX_REMEMBERED_SUBAGENTS),
      subagentOffsetByPath,
    };
  }

  function queueSessionRecord(binding: TraceBinding, reason: string | null): void {
    queueRecord(binding.glissaSessionId, {
      ts: nowFn(),
      uuid: null,
      parentUuid: null,
      vendorSessionId: binding.vendorSessionId,
      kind: 'session',
      vendor: binding.vendor,
      transcriptPath: binding.transcriptPath,
      ...(reason ? { reason } : {}),
    });
  }

  function noteSkippedBytes(binding: TraceBinding, filePath: string, skippedBytes: number): void {
    queueRecord(binding.glissaSessionId, {
      ts: nowFn(),
      uuid: null,
      parentUuid: null,
      vendorSessionId: binding.vendorSessionId,
      kind: 'notice',
      text: `skipped ${skippedBytes} bytes of ${path.basename(filePath)}`,
    });
  }

  function noteRefusedFile(binding: TraceBinding, filePath: string, reason: ContainmentRefusal): void {
    const refusalKey = `${filePath}:${reason}`;
    if (binding.notedFileRefusals.has(refusalKey)) return;
    binding.notedFileRefusals.add(refusalKey);
    trimOldest(binding.notedFileRefusals, MAX_REMEMBERED_FILE_REFUSALS);
    queueRecord(binding.glissaSessionId, {
      ts: nowFn(),
      uuid: null,
      parentUuid: null,
      vendorSessionId: binding.vendorSessionId,
      kind: 'notice',
      text: `refused ${path.basename(filePath)}: ${reason}`,
    });
  }

  function noteRecoveryFallback(binding: TraceBinding): void {
    queueRecord(binding.glissaSessionId, {
      ts: nowFn(),
      uuid: null,
      parentUuid: null,
      vendorSessionId: binding.vendorSessionId,
      kind: 'notice',
      text: 'recovery could not establish the run, resuming at the transcript end',
    });
  }

  function noteResumeOutcome(binding: TraceBinding, resumed: TraceResumeState): void {
    queueSessionRecord(binding, resumed.didReset ? 'transcript smaller than the stored checkpoint' : null);
    if (!resumed.didFallbackToTranscriptEnd) return;
    noteRecoveryFallback(binding);
    laneLog.warn('trace recovery fell back to the transcript end', {
      session: binding.glissaSessionId,
      path: binding.transcriptPath,
      scannedBytes: resumed.scannedBytes,
    });
  }

  function mapAndAppend(rawLine: string, binding: TraceBinding, context: LineContext = {}): void {
    const records = traceRecordsFromTranscriptLine(rawLine, {
      vendorSessionId: binding.vendorSessionId,
      now: nowFn(),
      ...context,
    });
    for (const record of records) {
      queueRecord(binding.glissaSessionId, record);
    }
  }

  async function readOnce(binding: TraceBinding, handle: FileHandle): Promise<void> {
    const stat = await handle.stat();
    const plan = planContiguousRead(binding.tailState, stat, { maxReadBytes: MAX_TRANSCRIPT_READ_BYTES });
    if (plan.reset) {
      binding.tailState.offset = 0;
      binding.tailState.carry = '';
      binding.isSkippingOversizedLine = false;
      queueSessionRecord(binding, 'transcript reset below the recorded offset');
    }
    if (plan.action === 'skip') return;
    const buffer = Buffer.alloc(plan.end - plan.start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, plan.start);
    if (bytesRead <= 0) return;
    const chunk = buffer.subarray(0, bytesRead);
    const wholeLineBytes = completeLineBytes(chunk);
    const usableBytes = wholeLineBytes > 0 ? wholeLineBytes : bytesRead;
    const lines = applyRead(binding.tailState, {
      text: chunk.subarray(0, usableBytes).toString('utf8'),
      end: plan.start + usableBytes,
      stat,
      dropPartial: binding.isSkippingOversizedLine,
    });
    binding.isSkippingOversizedLine = false;
    for (const line of lines) mapAndAppend(line, binding);
    if (!isOversizedPartialLine(binding.tailState.carry)) return;
    noteSkippedBytes(binding, binding.transcriptPath, Buffer.byteLength(binding.tailState.carry, 'utf8'));
    binding.tailState.carry = '';
    binding.isSkippingOversizedLine = true;
  }

  async function commitPending(binding: TraceBinding): Promise<PendingCommit> {
    stampCommittedOffset(binding.glissaSessionId, committedOffsetOf(binding));
    const recordCount = pendingRecordsBySessionId.get(binding.glissaSessionId)?.length ?? 0;
    const didAppend = await flushSession(binding.glissaSessionId);
    if (!didAppend) return { didAppend, appendedRecordCount: 0 };
    await writeCheckpoint(binding);
    return { didAppend, appendedRecordCount: recordCount };
  }

  async function drainBinding(binding: TraceBinding): Promise<void> {
    const opened = await openContainedFile(binding.transcriptPath, projectsRoot());
    if (!opened.ok) {
      if (binding.bindingBeforeFirstOpen) await drainBinding(binding.bindingBeforeFirstOpen);
      if (!binding.hasOpenedTranscript) {
        try {
          await fs.promises.lstat(binding.transcriptPath);
        } catch (error) {
          if (containmentRefusalReason(error) === 'missing') return;
        }
      }
      if (!binding.hasWarnedUnreadable) laneLog.warn('transcript unreadable', { session: binding.glissaSessionId });
      binding.hasWarnedUnreadable = true;
      return;
    }
    binding.hasWarnedUnreadable = false;
    let committedOffsetBeforeRead = committedOffsetOf(binding);
    try {
      if (!binding.hasOpenedTranscript) {
        if (binding.bindingBeforeFirstOpen) await drainBinding(binding.bindingBeforeFirstOpen);
        binding.bindingBeforeFirstOpen = null;
        binding.transcriptPath = opened.file.realPath;
        const stat = await opened.file.handle.stat();
        const resumed = await resumeStateFor(binding.glissaSessionId, binding.transcriptPath, stat.size);
        binding.committedOffsetByTranscriptPath = resumed.committedOffsetByTranscriptPath;
        binding.subagentPathsWithoutOffset = new Set<string>(resumed.subagentPathsWithoutOffset);
        binding.subagentOffsetByPath = resumed.subagentOffsetByPath;
        binding.tailState = createTailState(stat, { path: binding.transcriptPath });
        binding.tailState.offset = resumed.offset;
        binding.hasOpenedTranscript = true;
        noteResumeOutcome(binding, resumed);
        committedOffsetBeforeRead = committedOffsetOf(binding);
      }
      await readOnce(binding, opened.file.handle);
    } catch (error) {
      laneLog.warn('transcript read failed', { error: errorMessage(error) });
    } finally {
      await opened.file.handle.close().catch(() => {});
    }
    const commit = await commitPending(binding);
    if (!commit.didAppend) return;
    const committedOffsetAfterRead = committedOffsetOf(binding);
    if (committedOffsetAfterRead <= committedOffsetBeforeRead) return;
    laneLog.debugNote(
      () => 'drained',
      () => ({
        session: binding.glissaSessionId,
        records: commit.appendedRecordCount,
        bytes: committedOffsetAfterRead - committedOffsetBeforeRead,
        offset: committedOffsetAfterRead,
      }),
    );
  }

  function predecessorAwaitingDrain(previous: TraceBinding | undefined): TraceBinding | null {
    if (!previous) return null;
    if (previous.hasOpenedTranscript) return previous;
    const inherited = previous.bindingBeforeFirstOpen;
    previous.bindingBeforeFirstOpen = null;
    return inherited;
  }

  async function bindSession(
    glissaSessionId: string,
    vendorSessionId: string,
    vendor: string,
    requestedTranscriptPath: string,
  ): Promise<void> {
    if (hasStopped || closedSessionIds.has(glissaSessionId)) return;
    const checkpointPath = checkpointFilePath(glissaSessionId);
    if (!checkpointPath) return;
    const containedTranscript = await openContainedFile(requestedTranscriptPath, projectsRoot(), true);
    if (!containedTranscript.ok) {
      laneLog.warnOnce(`bind:${glissaSessionId}:${containedTranscript.reason}`, 'transcript refused', {
        session: glissaSessionId,
        path: requestedTranscriptPath,
        root: projectsRoot(),
        reason: containedTranscript.reason,
      });
      return;
    }
    const transcriptPath = containedTranscript.file.realPath;
    const transcriptStat = 'handle' in containedTranscript.file ? containedTranscript.file.stat : null;
    if ('handle' in containedTranscript.file) await containedTranscript.file.handle.close().catch(() => {});
    const previous = bindingByGlissaSessionId.get(glissaSessionId);
    if (previous) {
      bindingByGlissaSessionId.delete(glissaSessionId);
      await drainBinding(previous);
    }
    const resumed = transcriptStat
      ? await resumeStateFor(glissaSessionId, transcriptPath, transcriptStat.size)
      : null;
    const tailState = createTailState(transcriptStat, { path: transcriptPath });
    tailState.offset = resumed ? resumed.offset : 0;
    const binding: TraceBinding = {
      glissaSessionId,
      vendorSessionId,
      vendor,
      transcriptPath,
      requestedTranscriptPath,
      tailState,
      subagentPathsWithoutOffset: new Set<string>(resumed ? resumed.subagentPathsWithoutOffset : []),
      subagentOffsetByPath: resumed ? resumed.subagentOffsetByPath : {},
      notedFileRefusals: new Set<string>(),
      committedOffsetByTranscriptPath: resumed ? resumed.committedOffsetByTranscriptPath : {},
      checkpointWriter: createJsonStateWriter({
        filePath: checkpointPath,
        warn: (error: unknown) => { laneLog.warn('checkpoint write failed', { error: errorMessage(error) }); },
      }),
      bindingBeforeFirstOpen: transcriptStat ? null : predecessorAwaitingDrain(previous),
      isSkippingOversizedLine: false,
      hasOpenedTranscript: transcriptStat !== null,
      hasWarnedUnreadable: false,
      isClosing: false,
    };
    if (resumed) noteResumeOutcome(binding, resumed);
    bindingByGlissaSessionId.set(glissaSessionId, binding);
    await drainBinding(binding);
  }

  function noteVendorSession(glissaSessionId: string, eventPayload: Record<string, unknown>): void {
    if (hasStopped || closedSessionIds.has(glissaSessionId)) return;
    const vendorSessionId = typeof eventPayload.id === 'string' ? eventPayload.id : '';
    const vendor = typeof eventPayload.vendor === 'string' ? eventPayload.vendor : 'claude';
    if (!vendorSessionId || vendor !== 'claude') return;
    if (!traceFilePath(glissaSessionId)) return;
    const rawPath = typeof eventPayload.transcriptPath === 'string' ? eventPayload.transcriptPath : '';
    if (!rawPath) return;
    const requestedTranscriptPath = path.resolve(rawPath);
    const bound = bindingByGlissaSessionId.get(glissaSessionId);
    if (bound
      && bound.vendorSessionId === vendorSessionId
      && bound.requestedTranscriptPath === requestedTranscriptPath) return;
    chain(() => bindSession(glissaSessionId, vendorSessionId, vendor, requestedTranscriptPath), 'binding failed');
  }

  async function readSubagentTranscript(
    glissaSessionId: string,
    eventPayload: Record<string, unknown>,
  ): Promise<void> {
    const binding = bindingByGlissaSessionId.get(glissaSessionId);
    if (!binding) return;
    const rawPath = typeof eventPayload.agent_transcript_path === 'string'
      ? eventPayload.agent_transcript_path
      : '';
    if (!rawPath) return;
    const subagentPath = path.resolve(rawPath);
    const subagentRoot = path.dirname(binding.transcriptPath);
    if (!isPathInsideRoot(projectsRoot(), subagentRoot)) {
      laneLog.warnOnce(`subagent:${binding.glissaSessionId}:outside-root`, 'subagent transcript refused', {
        session: binding.glissaSessionId,
        path: subagentPath,
        root: subagentRoot,
        reason: 'outside-root',
      });
      return;
    }
    const opened = await openContainedFile(subagentPath, subagentRoot);
    if (!opened.ok) {
      laneLog.warnOnce(`subagent:${binding.glissaSessionId}:${opened.reason}`, 'subagent transcript refused', {
        session: binding.glissaSessionId,
        path: subagentPath,
        root: subagentRoot,
        reason: opened.reason,
      });
      if (!binding.hasOpenedTranscript) return;
      noteRefusedFile(binding, subagentPath, opened.reason);
      await commitPending(binding);
      return;
    }
    let mappedLineCount = 0;
    let bytesRead = 0;
    try {
      await drainBinding(binding);
      if (!binding.hasOpenedTranscript) return;
      const stat = await opened.file.handle.stat();
      const agentId = typeof eventPayload.agent_id === 'string' && eventPayload.agent_id
        ? eventPayload.agent_id
        : undefined;
      const agentType = typeof eventPayload.agent_type === 'string' && eventPayload.agent_type
        ? eventPayload.agent_type
        : undefined;
      const context: LineContext = {
        ...(agentId ? { agentId } : {}),
        ...(agentType ? { agentType } : {}),
      };
      const sidechainState = createTailState(stat, { path: subagentPath });
      const rememberedOffset = binding.subagentOffsetByPath[subagentPath];
      sidechainState.offset = rememberedOffset
        ?? (binding.subagentPathsWithoutOffset.has(subagentPath) ? stat.size : 0);
      let isSkippingOversizedLine = await isResumePointMidLine(opened.file.handle, sidechainState.offset);
      let partialLineBytes = NO_BYTES;
      let committedOffset = sidechainState.offset;
      for (let chunkIndex = 0; chunkIndex < MAX_SUBAGENT_CHUNKS_PER_STOP; chunkIndex += 1) {
        const plan = planContiguousRead(sidechainState, stat, { maxReadBytes: MAX_TRANSCRIPT_READ_BYTES });
        if (plan.reset) {
          sidechainState.offset = 0;
          sidechainState.carry = '';
          partialLineBytes = NO_BYTES;
          isSkippingOversizedLine = false;
          committedOffset = 0;
        }
        if (plan.action === 'skip') break;
        const buffer = Buffer.alloc(plan.end - plan.start);
        const read = await opened.file.handle.read(buffer, 0, buffer.length, plan.start);
        if (read.bytesRead <= 0) break;
        bytesRead += read.bytesRead;
        const carriedBytes = plan.reset ? NO_BYTES : partialLineBytes;
        const readBytes = buffer.subarray(0, read.bytesRead);
        const chunk = carriedBytes.length > 0 ? Buffer.concat([carriedBytes, readBytes]) : readBytes;
        const wholeLineBytes = completeLineBytes(chunk);
        const readEnd = plan.start + read.bytesRead;
        const lines = applyRead(sidechainState, {
          text: chunk.subarray(0, wholeLineBytes).toString('utf8'),
          end: readEnd,
          stat,
          reset: plan.reset,
          dropPartial: isSkippingOversizedLine,
        });
        isSkippingOversizedLine = isSkippingOversizedLine && wholeLineBytes === 0;
        partialLineBytes = isSkippingOversizedLine ? NO_BYTES : chunk.subarray(wholeLineBytes);
        committedOffset = readEnd - partialLineBytes.length;
        mappedLineCount += lines.length;
        for (const line of lines) mapAndAppend(line, binding, context);
        if (!isOversizedPartialLine(partialLineBytes)) continue;
        noteSkippedBytes(binding, subagentPath, partialLineBytes.length);
        partialLineBytes = NO_BYTES;
        committedOffset = readEnd;
        isSkippingOversizedLine = true;
      }
      binding.subagentOffsetByPath = withCommittedOffset(
        binding.subagentOffsetByPath,
        subagentPath,
        committedOffset,
        { maxRemembered: MAX_REMEMBERED_SUBAGENTS },
      );
      binding.subagentPathsWithoutOffset.delete(subagentPath);
    } catch (error) {
      laneLog.warn('subagent transcript read failed', { error: errorMessage(error) });
      return;
    } finally {
      await opened.file.handle.close().catch(() => {});
    }
    await commitPending(binding);
    laneLog.debugNote(
      () => 'subagent captured',
      () => ({ session: glissaSessionId, records: mappedLineCount, bytes: bytesRead }),
    );
  }

  function noteHookEvent(glissaSessionId: string, eventRecord: Record<string, unknown>): void {
    if (hasStopped || closedSessionIds.has(glissaSessionId)) return;
    const hookEvent = typeof eventRecord.event === 'string' ? eventRecord.event.toLowerCase() : '';
    if (hookEvent !== 'subagentstop') return;
    const payload = eventRecord.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    chain(
      () => readSubagentTranscript(glissaSessionId, payload as Record<string, unknown>),
      'subagent capture failed',
    );
  }

  function detachSession(glissaSessionId: string): void {
    chain(async () => {
      const binding = bindingByGlissaSessionId.get(glissaSessionId);
      if (!binding) return;
      bindingByGlissaSessionId.delete(glissaSessionId);
      await drainBinding(binding);
    }, 'final drain failed');
  }

  function closeSession(glissaSessionId: string): void {
    closedSessionIds.add(glissaSessionId);
    trimOldest(closedSessionIds, MAX_REMEMBERED_CLOSED_SESSIONS);
    chain(async () => {
      const binding = bindingByGlissaSessionId.get(glissaSessionId);
      if (!binding) return;
      binding.isClosing = true;
      await drainBinding(binding);
    }, 'final drain failed');
  }

  function attachSession(session: TraceSession): void {
    if (attachedSessions.has(session)) return;
    attachedSessions.add(session);
    session.on('claude-session-id', (payload) => { noteVendorSession(session.id, payload); });
    session.on('hook-event', (record) => { noteHookEvent(session.id, record); });
    session.on('exit', () => { detachSession(session.id); });
    session.on('teardown', () => { closeSession(session.id); });
  }

  async function pollBoundTranscripts(): Promise<void> {
    if (hasStopped) return;
    for (const binding of [...bindingByGlissaSessionId.values()]) {
      if (binding.isClosing) continue;
      await drainBinding(binding);
    }
  }

  async function prune(): Promise<void> {
    await pruneTraceFiles({
      traceDirectory,
      now: nowFn(),
      isBoundSessionId: (glissaSessionId) => bindingByGlissaSessionId.has(glissaSessionId),
    });
  }

  async function start(): Promise<void> {
    if (hasStarted || hasStopped) return;
    hasStarted = true;
    await prune();
    pruneTimer = setIntervalFn(() => { chain(prune, 'prune failed'); }, PRUNE_INTERVAL_MS);
    if (typeof pruneTimer.unref === 'function') pruneTimer.unref();
    pollTimer = setIntervalFn(() => {
      if (bindingByGlissaSessionId.size === 0) return;
      chain(pollBoundTranscripts, 'poll failed');
    }, POLL_INTERVAL_MS);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
  }

  async function whenIdle(): Promise<void> {
    await operationChain;
    await flushEverySession();
    for (const binding of [...bindingByGlissaSessionId.values()]) await binding.checkpointWriter.idle();
  }

  async function stopOnce(): Promise<void> {
    if (pruneTimer) clearIntervalFn(pruneTimer);
    if (pollTimer) clearIntervalFn(pollTimer);
    pruneTimer = null;
    pollTimer = null;
    await operationChain;
    for (const binding of [...bindingByGlissaSessionId.values()]) {
      bindingByGlissaSessionId.delete(binding.glissaSessionId);
      try {
        await drainBinding(binding);
      } catch (error) {
        laneLog.warn('final drain failed', { error: errorMessage(error) });
      }
      await binding.checkpointWriter.idle();
    }
    hasStopped = true;
    await flushEverySession();
  }

  function stop(): Promise<void> {
    if (!stopPromise) stopPromise = stopOnce();
    return stopPromise;
  }

  return {
    attachSession,
    on: emitter.on.bind(emitter),
    readTracePage,
    start,
    stop,
    whenIdle,
  };
}

export { createTraceWiring, pruneTraceFiles };
