import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { FileHandle } from 'node:fs/promises';

import {
  PLAN_HOOK_EVENT,
  PlanRevision as PlanRevisionSchema,
  parseExitPlanModeHookPayload,
} from '../shared/contracts/plan-review.ts';
import type { ExitPlanModeRequest, PlanReview, PlanRevisionBody } from '../shared/contracts/plan-review.ts';
import {
  agentIdsIn,
  agentKey,
  closedProgress,
  entriesForAgent,
  indexEntryFor,
  isPlanHookEvent,
  isPlanToolResult,
  newestEntry,
  nextReviewState,
  nextRevisionNumber,
  planChangedPayload,
  progressAfterPlanToolResult,
  progressAfterRevision,
  reviewFrom,
  revisionRecord,
  selectEntry,
} from './core/plan-review-core.ts';
import type { PlanChangedPayload, PlanReviewProgress, PlanRevisionIndexEntry } from './core/plan-review-core.ts';
import { isSafePathSegment } from './core/upload-core.ts';
import { appendJsonLine } from './json-file.ts';
import { configSiblingPath } from './pairings-store.ts';
import { pruneAgedFiles } from './prune-files.ts';

const PERMISSION_REQUEST_HOOK_EVENT = 'permissionrequest';
const PLAN_HOOK_BODY_CAP_BYTES = 512 * 1024;
const PLAN_SUFFIX = '.jsonl';
const PLAN_RETAIN_DAYS = 30;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FILE_MODE = 0o600;

interface PlanReviewWiringOptions {
  configPath?: string | null;
  logger?: Pick<Console, 'warn'> | null;
  nowFn?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn?: (handle: NodeJS.Timeout) => void;
}

interface PlanHookEvent {
  glissaId: string;
  event: string;
  payload: Record<string, unknown>;
  accepted: boolean;
}

interface PlanReadResult {
  reviews: PlanReview[];
  body: PlanRevisionBody | null;
}

interface SessionPlanState {
  entries: PlanRevisionIndexEntry[];
  progressByAgentKey: Map<string, PlanReviewProgress>;
  fileSize: number;
}

interface PlanSession {
  id: string;
  on(event: string, listener: (payload: Record<string, unknown>) => void): unknown;
}

function carriesPlanBody(event: string): boolean {
  const name = event.toLowerCase();
  return name === PLAN_HOOK_EVENT || name === PERMISSION_REQUEST_HOOK_EVENT;
}

function hookBodyCapBytes(event: string): number {
  return carriesPlanBody(event) ? PLAN_HOOK_BODY_CAP_BYTES : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function agentIdOf(payload: Record<string, unknown>): string | null {
  const agentId = payload.agent_id;
  if (typeof agentId === 'string' && agentId.length > 0) return agentId;
  return null;
}

function approvedPlanOf(payload: Record<string, unknown>): string | null {
  const response = payload.tool_response;
  if (!response || typeof response !== 'object') return null;
  const plan = (response as { plan?: unknown }).plan;
  if (typeof plan === 'string' && plan.length > 0) return plan;
  return null;
}

function createPlanReviewWiring({
  configPath = null,
  logger = console,
  nowFn = Date.now,
  setIntervalFn = (fn: () => void, ms: number) => setInterval(fn, ms),
  clearIntervalFn = clearInterval,
}: PlanReviewWiringOptions = {}) {
  const plansDirectory = configSiblingPath(configPath, 'plans');
  const emitter = new EventEmitter();
  const stateBySessionId = new Map<string, SessionPlanState>();
  const sessionIdsWithPlans = new Set<string>();
  const attachedSessions = new WeakSet<object>();
  const attachedSessionIds = new Set<string>();
  let pruneTimer: NodeJS.Timeout | null = null;
  let hasStarted = false;
  let hasStopped = false;
  let hasEnsuredDirectory = false;
  let operationChain: Promise<unknown> = Promise.resolve();

  for (const entry of readPlanDirectorySync()) {
    if (entry.endsWith(PLAN_SUFFIX)) sessionIdsWithPlans.add(entry.slice(0, -PLAN_SUFFIX.length));
  }

  function readPlanDirectorySync(): string[] {
    try {
      return fs.readdirSync(plansDirectory);
    } catch {
      return [];
    }
  }

  function warn(message: string): void {
    if (!logger) return;
    logger.warn(`[plan-review] ${message}`);
  }

  function exclusive<T>(step: () => Promise<T>): Promise<T> {
    const next = operationChain.then(step, step);
    operationChain = next.then(() => {}, () => {});
    return next;
  }

  function planFilePath(sessionId: string): string | null {
    if (!isSafePathSegment(sessionId)) return null;
    return path.join(plansDirectory, `${sessionId}${PLAN_SUFFIX}`);
  }

  function indexEntryFromLine(line: string, offset: number, length: number): PlanRevisionIndexEntry | null {
    try {
      const parsed = PlanRevisionSchema.safeParse(JSON.parse(line));
      if (!parsed.success) return null;
      return indexEntryFor(parsed.data, { offset, length });
    } catch {
      return null;
    }
  }

  async function buildState(sessionId: string): Promise<SessionPlanState> {
    const state: SessionPlanState = { entries: [], progressByAgentKey: new Map(), fileSize: 0 };
    const filePath = planFilePath(sessionId);
    if (!filePath) return state;
    let raw: Buffer;
    try {
      raw = await fs.promises.readFile(filePath);
    } catch {
      return state;
    }
    state.fileSize = raw.length;
    let offset = 0;
    while (offset < raw.length) {
      const newlineIndex = raw.indexOf(0x0a, offset);
      const end = newlineIndex === -1 ? raw.length : newlineIndex;
      const entry = indexEntryFromLine(raw.subarray(offset, end).toString('utf8'), offset, end - offset);
      if (entry) state.entries.push(entry);
      offset = end + 1;
    }
    for (const entry of state.entries) {
      state.progressByAgentKey.set(agentKey(entry.agentId), closedProgress());
    }
    return state;
  }

  async function stateFor(sessionId: string): Promise<SessionPlanState> {
    const known = stateBySessionId.get(sessionId);
    if (known) return known;
    const built = await buildState(sessionId);
    const raced = stateBySessionId.get(sessionId);
    if (raced) return raced;
    stateBySessionId.set(sessionId, built);
    return built;
  }

  async function stateForRead(sessionId: string): Promise<SessionPlanState> {
    if (attachedSessionIds.has(sessionId)) return stateFor(sessionId);
    const known = stateBySessionId.get(sessionId);
    if (known) return known;
    return buildState(sessionId);
  }

  function setProgress(state: SessionPlanState, agentId: string | null, progress: PlanReviewProgress): void {
    state.progressByAgentKey.set(agentKey(agentId), progress);
  }

  function progressFor(state: SessionPlanState, agentId: string | null): PlanReviewProgress {
    const key = agentKey(agentId);
    const known = state.progressByAgentKey.get(key);
    if (known) return known;
    const fresh = closedProgress();
    state.progressByAgentKey.set(key, fresh);
    return fresh;
  }

  function emitChanged(sessionId: string, state: SessionPlanState, agentId: string | null): void {
    const entry = newestEntry(entriesForAgent(state.entries, agentId));
    if (!entry) return;
    emitter.emit('plan-changed', planChangedPayload(
      sessionId,
      entry,
      progressFor(state, agentId),
      sessionIdsWithPlans.has(sessionId),
    ));
  }

  function latestPlanTitle(sessionId: string): string | null {
    const entry = stateBySessionId.get(sessionId)?.entries.at(-1);
    return entry ? entry.title : null;
  }

  function moveReview(sessionId: string, agentId: string | null, event: 'release' | 'decide' | 'close'): void {
    const state = stateBySessionId.get(sessionId);
    if (!state) return;
    const progress = progressFor(state, agentId);
    const next = nextReviewState(progress.state, event);
    if (next === progress.state) return;
    progress.state = next;
    progress.openRevision = null;
    emitChanged(sessionId, state, agentId);
  }

  async function appendRevision(
    sessionId: string,
    request: ExitPlanModeRequest,
  ): Promise<PlanRevisionIndexEntry | null> {
    const filePath = planFilePath(sessionId);
    if (!filePath) {
      warn(`refused a plan for an unsafe session id: ${sessionId}`);
      return null;
    }
    const state = await stateFor(sessionId);
    const revision = nextRevisionNumber(entriesForAgent(state.entries, request.agentId));
    const record = revisionRecord(sessionId, request, { revision, receivedAt: nowFn() });
    const lineBytes = Buffer.byteLength(`${JSON.stringify(record)}\n`, 'utf8');
    try {
      await appendJsonLine(filePath, record, { mkdir: !hasEnsuredDirectory, mode: FILE_MODE });
    } catch (error) {
      warn(`append failed for ${sessionId}: ${errorMessage(error)}`);
      return null;
    }
    hasEnsuredDirectory = true;
    const entry = indexEntryFor(record, { offset: state.fileSize, length: lineBytes - 1 });
    state.fileSize += lineBytes;
    state.entries.push(entry);
    sessionIdsWithPlans.add(sessionId);
    return entry;
  }

  async function handlePlanRequest(
    sessionId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const request = parseExitPlanModeHookPayload(payload);
    if (!request) {
      warn(`plan request refused by the schema for ${sessionId}`);
      return null;
    }
    const entry = await appendRevision(sessionId, request);
    if (!entry) return null;
    const state = await stateFor(sessionId);
    setProgress(state, request.agentId, progressAfterRevision(progressFor(state, request.agentId)));
    emitChanged(sessionId, state, request.agentId);
    return null;
  }

  function notePostToolUse(sessionId: string, payload: Record<string, unknown>): void {
    if (!isPlanToolResult(payload)) return;
    const state = stateBySessionId.get(sessionId);
    if (!state) return;
    const agentId = agentIdOf(payload);
    const entry = newestEntry(entriesForAgent(state.entries, agentId));
    if (!entry) return;
    const progress = progressFor(state, agentId);
    setProgress(state, agentId, progressAfterPlanToolResult(progress, entry, approvedPlanOf(payload)));
    emitChanged(sessionId, state, agentId);
  }

  function closeEveryReview(sessionId: string): void {
    const state = stateBySessionId.get(sessionId);
    if (!state) return;
    for (const [key] of state.progressByAgentKey) {
      moveReview(sessionId, key.length === 0 ? null : key, 'close');
    }
  }

  function noteLifecycleEvent(sessionId: string, event: string, payload: Record<string, unknown>): void {
    const name = event.toLowerCase();
    if (name === 'posttooluse') {
      notePostToolUse(sessionId, payload);
      return;
    }
    if (name === 'stop') {
      moveReview(sessionId, null, 'close');
      return;
    }
    if (name === 'subagentstop') {
      moveReview(sessionId, agentIdOf(payload), 'close');
      return;
    }
    if (name !== 'sessionend') return;
    closeEveryReview(sessionId);
    stateBySessionId.delete(sessionId);
  }

  function onHookEvent({ glissaId, event, payload, accepted }: PlanHookEvent): Promise<Record<string, unknown> | null> | null {
    if (hasStopped || !accepted) return null;
    if (isPlanHookEvent(event)) return exclusive(() => handlePlanRequest(glissaId, payload));
    noteLifecycleEvent(glissaId, event, payload);
    return null;
  }

  async function readRevisionLine(
    sessionId: string,
    entry: PlanRevisionIndexEntry,
  ): Promise<{ plan: string; planFilePath: string; receivedAt: number } | null> {
    const filePath = planFilePath(sessionId);
    if (!filePath) return null;
    let handle: FileHandle | null = null;
    try {
      handle = await fs.promises.open(filePath, 'r');
      const buffer = Buffer.alloc(entry.length);
      const { bytesRead } = await handle.read(buffer, 0, entry.length, entry.offset);
      const parsed = PlanRevisionSchema.safeParse(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
      if (!parsed.success) return null;
      return { plan: parsed.data.plan, planFilePath: parsed.data.planFilePath, receivedAt: parsed.data.receivedAt };
    } catch (error) {
      warn(`revision read failed for ${sessionId}: ${errorMessage(error)}`);
      return null;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  async function loadPlanRevision(
    sessionId: string,
    { agentId = null, revision = null }: { agentId?: string | null; revision?: number | null },
  ): Promise<PlanReadResult | null> {
    const state = await stateForRead(sessionId);
    if (state.entries.length === 0) return null;
    const reviews = agentIdsIn(state.entries)
      .map((reviewAgentId) => reviewFrom(state.entries, reviewAgentId, progressFor(state, reviewAgentId)));
    const entry = selectEntry(entriesForAgent(state.entries, agentId), revision);
    if (!entry) {
      if (revision !== null) return null;
      return { reviews, body: null };
    }
    const body = await readRevisionLine(sessionId, entry);
    if (!body) return { reviews, body: null };
    return { reviews, body: { agentId: entry.agentId, revision: entry.revision, ...body } };
  }

  function readPlanRevision(
    sessionId: string,
    request: { agentId?: string | null; revision?: number | null } = {},
  ): Promise<PlanReadResult | null> {
    return exclusive(() => loadPlanRevision(sessionId, request));
  }

  function attachSession(session: PlanSession): void {
    if (attachedSessions.has(session)) return;
    attachedSessions.add(session);
    attachedSessionIds.add(session.id);
    session.on('teardown', () => {
      closeEveryReview(session.id);
      stateBySessionId.delete(session.id);
      attachedSessionIds.delete(session.id);
    });
  }

  async function prune(): Promise<void> {
    const removed = await pruneAgedFiles({
      directory: plansDirectory,
      suffixes: [PLAN_SUFFIX],
      retainDays: PLAN_RETAIN_DAYS,
      now: nowFn(),
      isRetainedId: (sessionId) => attachedSessionIds.has(sessionId),
    });
    for (const sessionId of removed) sessionIdsWithPlans.delete(sessionId);
  }

  async function start(): Promise<void> {
    if (hasStarted || hasStopped) return;
    hasStarted = true;
    await exclusive(prune);
    pruneTimer = setIntervalFn(() => {
      exclusive(prune).catch((error: unknown) => { warn(`prune failed: ${errorMessage(error)}`); });
    }, PRUNE_INTERVAL_MS);
    if (typeof pruneTimer.unref === 'function') pruneTimer.unref();
  }

  async function whenIdle(): Promise<void> {
    await operationChain;
  }

  async function stop(): Promise<void> {
    hasStopped = true;
    if (pruneTimer) clearIntervalFn(pruneTimer);
    pruneTimer = null;
    await operationChain;
  }

  return {
    attachSession,
    hookBodyCapBytes,
    latestPlanTitle,
    on: emitter.on.bind(emitter),
    onHookEvent,
    port: { hasPlan: (sessionId: string): boolean => sessionIdsWithPlans.has(sessionId) },
    readPlanRevision,
    start,
    stop,
    whenIdle,
  };
}

export { PLAN_HOOK_BODY_CAP_BYTES, PLAN_RETAIN_DAYS, PLAN_SUFFIX, carriesPlanBody, createPlanReviewWiring };
export type { PlanChangedPayload, PlanHookEvent, PlanReadResult, PlanReviewWiringOptions };
