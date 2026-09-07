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
import { applyRead, createTailState } from './core/ingest-tail-core.ts';
import type { TailState } from './core/ingest-tail-core.ts';
import { traceRecordsFromTranscriptLine } from './core/trace-core.ts';
import {
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
} from './core/trace-tail-core.ts';
import { readSessionTracePage } from './core/session-trace-core.ts';
import { isSafePathSegment } from './core/upload-core.ts';
import { appendJsonLines, createJsonStateWriter } from './json-file.ts';
import type { JsonStateWriter } from './json-file.ts';
import { configSiblingPath } from './pairings-store.ts';

const TRACE_RETAIN_DAYS = 7;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;
const MAX_REMEMBERED_SUBAGENTS = 512;
const MAX_REMEMBERED_CLOSED_SESSIONS = 512;
const TRACE_SUFFIX = '.jsonl';
const CHECKPOINT_SUFFIX = '.checkpoint.json';

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
  skillToolUseIds: Set<string>;
  ingestedSubagentPaths: Set<string>;
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
  committedOffsetByTranscriptPath: Record<string, number>;
  ingestedSubagentPaths: string[];
}

interface LineContext {
  agentId?: string;
  agentType?: string;
}

interface OpenedFile {
  handle: FileHandle;
  realPath: string;
  stat: fs.Stats;
}

interface MissingContainedFile {
  realPath: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
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

async function containedPathForMissingFile(
  candidate: string,
  root: string,
): Promise<MissingContainedFile | null> {
  const transcriptName = path.basename(candidate);
  if (!isSafePathSegment(transcriptName)) return null;
  try {
    const realRoot = await fs.promises.realpath(root);
    const realDirectory = await fs.promises.realpath(path.dirname(candidate));
    if (!isPathInsideRoot(realRoot, realDirectory)) return null;
    return { realPath: path.join(realDirectory, transcriptName) };
  } catch {
    return null;
  }
}

function openContainedFile(candidate: string, root: string): Promise<OpenedFile | null>;
function openContainedFile(
  candidate: string,
  root: string,
  allowsMissingFile: true,
): Promise<OpenedFile | MissingContainedFile | null>;
async function openContainedFile(
  candidate: string,
  root: string,
  allowsMissingFile = false,
): Promise<OpenedFile | MissingContainedFile | null> {
  let handle: FileHandle | null = null;
  try {
    const realRoot = await fs.promises.realpath(root);
    const realCandidate = await fs.promises.realpath(candidate);
    if (!isPathInsideRoot(realRoot, realCandidate)) return null;
    handle = await fs.promises.open(realCandidate, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (stat.isFile()) return { handle, realPath: realCandidate, stat };
    await handle.close().catch(() => {});
    return null;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (!allowsMissingFile || !isMissingFileError(error)) return null;
  }
  return containedPathForMissingFile(candidate, root);
}

function traceSessionIdOf(entry: string): string | null {
  if (entry.endsWith(CHECKPOINT_SUFFIX)) return entry.slice(0, -CHECKPOINT_SUFFIX.length);
  if (entry.endsWith(TRACE_SUFFIX)) return entry.slice(0, -TRACE_SUFFIX.length);
  return null;
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
  let entries: string[];
  try {
    entries = await fs.promises.readdir(traceDirectory);
  } catch {
    return 0;
  }
  const cutoff = now - (TRACE_RETAIN_DAYS * 24 * 60 * 60 * 1000);
  let removed = 0;
  for (const entry of entries) {
    const glissaSessionId = traceSessionIdOf(entry);
    if (!glissaSessionId || isBoundSessionId(glissaSessionId)) continue;
    const filePath = path.join(traceDirectory, entry);
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.mtimeMs >= cutoff) continue;
      await fs.promises.unlink(filePath);
      removed += 1;
    } catch {
    }
  }
  return removed;
}

function createTraceWiring({
  configPath = null,
  logger = console,
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

  function warn(message: string): void {
    if (!logger) return;
    logger.warn(`[trace] ${message}`);
  }

  function chain(step: () => Promise<void>, failure: string): void {
    operationChain = operationChain
      .then(step)
      .catch((error: unknown) => { warn(`${failure}: ${errorMessage(error)}`); });
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
      if (isMissingFileError(error)) return { records: [], start: 0, next: 0, reset: isRewoundCursor(request, 0), path: filePath };
      throw error;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  function queueRecord(glissaSessionId: string, record: TraceRecord): void {
    if (!traceFilePath(glissaSessionId)) return;
    const parsed = TraceRecordSchema.safeParse(record);
    if (!parsed.success) {
      warn(`record refused for ${glissaSessionId}`);
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
      warn(`append failed for ${glissaSessionId}: ${errorMessage(error)}`);
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
      ingestedSubagentPaths: [...binding.ingestedSubagentPaths],
      offsetByTranscriptPath: binding.committedOffsetByTranscriptPath,
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
  ): Promise<number> {
    const filePath = traceFilePath(glissaSessionId);
    if (!filePath) return 0;
    let handle: FileHandle | null = null;
    try {
      handle = await fs.promises.open(filePath, 'r');
      const stat = await handle.stat();
      const start = Math.max(0, stat.size - TRACE_TAIL_SCAN_BYTES);
      const buffer = Buffer.alloc(stat.size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      return committedOffsetFromTraceTail(buffer.subarray(0, bytesRead).toString('utf8'), {
        transcriptPath,
        pathBeforeWindow,
        isWholeFile: start === 0,
      });
    } catch {
      return 0;
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
    const alreadyTracedOffset = await tracedOffsetOf(
      glissaSessionId,
      transcriptPath,
      checkpoint ? checkpoint.transcriptPath : null,
    );
    const resume = resumeOffsetFrom(checkpoint, { transcriptPath, size, alreadyTracedOffset });
    return {
      offset: resume.offset,
      didReset: resume.didReset,
      committedOffsetByTranscriptPath: checkpoint ? checkpoint.offsetByTranscriptPath : {},
      ingestedSubagentPaths: checkpoint && checkpoint.transcriptPath === transcriptPath
        ? checkpoint.ingestedSubagentPaths
        : [],
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

  function mapAndAppend(rawLine: string, binding: TraceBinding, context: LineContext = {}): void {
    const records = traceRecordsFromTranscriptLine(rawLine, {
      vendorSessionId: binding.vendorSessionId,
      now: nowFn(),
      skillToolUseIds: binding.skillToolUseIds,
      ...context,
    });
    for (const record of records) {
      if (record.kind === 'tool_call' && record.name === 'Skill') binding.skillToolUseIds.add(record.toolUseId);
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

  async function commitPending(binding: TraceBinding): Promise<void> {
    stampCommittedOffset(binding.glissaSessionId, committedOffsetOf(binding));
    const didAppend = await flushSession(binding.glissaSessionId);
    if (!didAppend) return;
    await writeCheckpoint(binding);
  }

  async function drainBinding(binding: TraceBinding): Promise<void> {
    const opened = await openContainedFile(binding.transcriptPath, projectsRoot());
    if (!opened) {
      if (binding.bindingBeforeFirstOpen) await drainBinding(binding.bindingBeforeFirstOpen);
      if (!binding.hasOpenedTranscript) {
        try {
          await fs.promises.lstat(binding.transcriptPath);
        } catch (error) {
          if (isMissingFileError(error)) return;
        }
      }
      if (!binding.hasWarnedUnreadable) warn(`transcript unreadable for ${binding.glissaSessionId}`);
      binding.hasWarnedUnreadable = true;
      return;
    }
    binding.hasWarnedUnreadable = false;
    try {
      if (!binding.hasOpenedTranscript) {
        if (binding.bindingBeforeFirstOpen) await drainBinding(binding.bindingBeforeFirstOpen);
        binding.bindingBeforeFirstOpen = null;
        binding.transcriptPath = opened.realPath;
        const stat = await opened.handle.stat();
        const resumed = await resumeStateFor(binding.glissaSessionId, binding.transcriptPath, stat.size);
        binding.committedOffsetByTranscriptPath = resumed.committedOffsetByTranscriptPath;
        binding.ingestedSubagentPaths = new Set<string>(resumed.ingestedSubagentPaths);
        binding.tailState = createTailState(stat, { path: binding.transcriptPath });
        binding.tailState.offset = resumed.offset;
        binding.hasOpenedTranscript = true;
        queueSessionRecord(binding, resumed.didReset ? 'transcript smaller than the stored checkpoint' : null);
      }
      await readOnce(binding, opened.handle);
    } catch (error) {
      warn(`transcript read failed: ${errorMessage(error)}`);
    } finally {
      await opened.handle.close().catch(() => {});
    }
    await commitPending(binding);
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
    if (!containedTranscript) {
      warn('transcript refused: outside the Claude projects root or not a regular file');
      return;
    }
    const transcriptPath = containedTranscript.realPath;
    const transcriptStat = 'handle' in containedTranscript ? containedTranscript.stat : null;
    if ('handle' in containedTranscript) await containedTranscript.handle.close().catch(() => {});
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
      skillToolUseIds: new Set<string>(),
      ingestedSubagentPaths: new Set<string>(resumed ? resumed.ingestedSubagentPaths : []),
      committedOffsetByTranscriptPath: resumed ? resumed.committedOffsetByTranscriptPath : {},
      checkpointWriter: createJsonStateWriter({
        filePath: checkpointPath,
        warn: (error: unknown) => { warn(`checkpoint write failed: ${errorMessage(error)}`); },
      }),
      bindingBeforeFirstOpen: transcriptStat ? null : predecessorAwaitingDrain(previous),
      isSkippingOversizedLine: false,
      hasOpenedTranscript: transcriptStat !== null,
      hasWarnedUnreadable: false,
      isClosing: false,
    };
    if (resumed) {
      queueSessionRecord(binding, resumed.didReset ? 'transcript smaller than the stored checkpoint' : null);
    }
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
    if (binding.ingestedSubagentPaths.has(subagentPath)) return;
    const subagentRoot = path.dirname(binding.transcriptPath);
    if (!isPathInsideRoot(projectsRoot(), subagentRoot)) {
      warn('subagent transcript refused: the session transcript sits outside a Claude project directory');
      return;
    }
    const opened = await openContainedFile(subagentPath, subagentRoot);
    if (!opened) {
      warn('subagent transcript refused: outside the session transcript root');
      return;
    }
    try {
      await drainBinding(binding);
      if (!binding.hasOpenedTranscript) return;
      const stat = await opened.handle.stat();
      const end = Math.min(stat.size, MAX_SUBAGENT_READ_BYTES);
      const buffer = Buffer.alloc(end);
      const { bytesRead } = await opened.handle.read(buffer, 0, end, 0);
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
      sidechainState.offset = 0;
      const lines = applyRead(sidechainState, {
        text: buffer.subarray(0, bytesRead).toString('utf8'),
        end: bytesRead,
        stat,
      });
      for (const line of lines) mapAndAppend(line, binding, context);
      if (stat.size > end) noteSkippedBytes(binding, subagentPath, stat.size - end);
      binding.ingestedSubagentPaths.add(subagentPath);
      trimOldest(binding.ingestedSubagentPaths, MAX_REMEMBERED_SUBAGENTS);
    } catch (error) {
      warn(`subagent transcript read failed: ${errorMessage(error)}`);
      return;
    } finally {
      await opened.handle.close().catch(() => {});
    }
    await commitPending(binding);
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
        warn(`final drain failed: ${errorMessage(error)}`);
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
