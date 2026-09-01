
import fs from 'node:fs';
import fsPromisesDefault from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';

import type { ControlBroadcast } from './backend-websockets.ts';
import { ACTIVITY_METHOD } from './core/ingest-editor-core.ts';
import {
  applyDidChange, applyDidClose, applyDidOpen, createDocStore, detectBlankLineBoundary, formatRange, getDoc, listDocs, uriOfParams,
} from './core/visions-buffer-core.ts';
import type { StoredDoc } from './core/visions-buffer-core.ts';
import {
  ERROR_BACKOFF_THRESHOLD,
  ORIENTATION_REASON,
  buildVisionsPrompt,
  commentsToLsp,
  createDispatchState,
  decideDispatch,
  decideDocumentSize,
  decidePromptSize,
  filterComments,
  forgetUri,
  formatDroppedComments,
  handToLsp,
  hashText,
  mergeDiagnostics,
  noteDispatchOutcome,
  recordDispatch,
  resolveDispatchConfig,
  sanitizeModelDiagnostics,
} from './core/visions-dispatch-core.ts';
import type { DispatchTrigger, LineDiagnostic, VisionsComment } from './core/visions-dispatch-core.ts';
import {
  DEFAULT_FIX_LOG_MAX,
  appendFixLog,
  autoSafeFixes,
  buildApplyEditParams,
  buildCodeActions,
  filterFixesByRange,
  fixLogEntry,
  fixPayload,
  isFixSetFresh,
  readSweepResult,
} from './core/visions-fix-core.ts';
import type { FixLogEntry } from './core/visions-fix-core.ts';
import {
  DEFAULT_THREAD_TTL_MS,
  applyModelIntent as mergeModelIntent,
  createIntentState,
  intentPayload,
  intentProjectPayload,
  isEmptyIntent,
  liveThreadsFor,
  pruneIntentProjects,
  retireStaleThreads,
  reviveIntentState,
} from './core/visions-intent-core.ts';
import type { IntentState, IntentThread } from './core/visions-intent-core.ts';
import {
  MAX_DELIVERED_RECORDS,
  createBoundedKeySet,
  dismissFeedbackInput,
  dispatchMemoryInputs,
  fixFeedbackInput,
  intentHeadKey,
  intentMemoryInput,
  latestIntentHeads,
  memoryDeliveryLines,
  projectTagFor,
  readDismissParams,
  servedFeedbackInput,
  servedFindingOf,
  servedKey,
} from './core/visions-memory-core.ts';
import { sweepMarkdownWithFixes } from './core/visions-rules-core.ts';
import type { SweepDiagnostic, SweepFix } from './core/visions-rules-core.ts';
import { isUriInProjects, projectForUri, scopePathsOf } from './core/visions-scope-core.ts';
import {
  createTouchState, formatTouchedRanges, recordChanges, resetUri as resetTouchedUri, touchedRangesFor,
} from './core/visions-touch-core.ts';
import type { TouchedRange } from './core/visions-touch-core.ts';
import { createJsonStateWriter } from './json-file.ts';
import { createLaneLog } from './lane-log.ts';
import type { LaneLogger } from './lane-log.ts';

const VISIONS_DEBOUNCE_MS = 300;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MARKDOWN_EXTENSIONS = ['.md', '.markdown'];
const DIGEST_BUDGET_CHARS = 2000;
const CODE_ACTION_METHOD = 'textDocument/codeAction';
const APPLY_EDIT_METHOD = 'workspace/applyEdit';
const APPLY_EDIT_TIMEOUT_MS = 2000;
const FRAME_TYPES = new Set(['lsp', 'lsp-request', 'lsp-response']);

type DocLike = { uri?: unknown; languageId?: unknown; text?: string } | null | undefined;

type LaneFrame =
  | { ok: false; reason: string }
  | { ok: true; type: string; id?: unknown; result?: unknown; method?: string; params?: Record<string, unknown> };

interface DispatchOutcome {
  verdict: string;
  errorSource?: string | null;
  reason?: string | null;
  diagnostics?: unknown;
  comments?: unknown;
  hand?: unknown;
  intent?: unknown;
}

interface MemorySection {
  text: string;
  count: number;
  version: string | null;
}

interface VisionsMemoryStore {
  append: (input: object) => Promise<{ id: string } | null>;
  records?: () => object[];
  retrieve?: (options: { query: string; project: string | null; limit: number }) => object[];
  noteDelivered?: (text: string) => void;
  readPublishedManifest?: () => Promise<{ version?: string } | null>;
}

interface ScopeProject {
  id: string;
  path: string;
}

interface PendingApplyEdit {
  uri: string;
  fixes: SweepFix[];
  timer: NodeJS.Timeout;
}

interface VisionsConnection {
  handleFrame(raw: string): void;
  close(): void;
  noteActivity(): void;
  readonly docCount: number;
  readonly pendingSweepCount: number;
  readonly pendingDispatchCount: number;
  readonly isClosed: boolean;
}

interface VisionsWiringOptions {
  debounceMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutFn?: (handle: NodeJS.Timeout) => void;
  nowFn?: () => number;
  sweep?: (text: string) => { diagnostics: SweepDiagnostic[]; fixes: SweepFix[] };
  maxPayload?: number;
  autoFix?: boolean;
  fixLogMax?: number;
  applyEditTimeoutMs?: number;
  logger?: LaneLogger;
  broadcast?: ControlBroadcast | null;
  dispatchConfig?: unknown;
  dispatch?: ((options: {
    uri: string;
    text: string;
    findings?: unknown[];
    intent?: string;
    digest?: string;
    memory?: MemorySection | null;
    prompt?: string | null;
  }) => Promise<DispatchOutcome>) | null;
  contextDigest?: ((options: { scopes: null; budgetChars: number; now: number }) => unknown) | null;
  contextSeq?: (() => number | null) | null;
  scopeProjects?: ScopeProject[] | null;
  knownProjectIds?: string[] | null;
  getMemoryStore?: (() => VisionsMemoryStore | null) | null;
  onEditorEvent?: ((event: { method: string; uri: string }) => void) | null;
  memoryDeliveryLimit?: number;
  intentStatePath?: string | null;
  intentThreadTtlMs?: number;
  fsFns?: IntentStateReader;
  fsPromises?: Parameters<typeof createJsonStateWriter>[0]['fsPromises'];
  digestBudgetChars?: number;
  hashFn?: (text: string) => string;
  buildPrompt?: typeof buildVisionsPrompt;
  debug?: boolean | (() => boolean);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMarkdownDoc(doc: DocLike): boolean {
  if (!doc) return false;
  if (doc.languageId === 'markdown') return true;
  const uri = typeof doc.uri === 'string' ? doc.uri.toLowerCase() : '';
  return MARKDOWN_EXTENSIONS.some((extension) => uri.endsWith(extension));
}

function hasId(parsed: { id?: unknown }): boolean {
  return parsed.id !== null && parsed.id !== undefined;
}

function readFrame(raw: string): LaneFrame {
  let parsed: { type?: unknown; id?: unknown; result?: unknown; method?: unknown; params?: unknown } | null = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'unparsable JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'not an object' };
  if (typeof parsed.type !== 'string' || !FRAME_TYPES.has(parsed.type)) return { ok: false, reason: `unsupported frame type ${JSON.stringify(parsed.type)}` };
  if (parsed.type === 'lsp-response') {
    if (!hasId(parsed)) return { ok: false, reason: 'missing id' };
    return { ok: true, type: parsed.type, id: parsed.id, result: parsed.result };
  }
  if (typeof parsed.method !== 'string') return { ok: false, reason: 'missing method' };
  const params = (parsed.params && typeof parsed.params === 'object' ? parsed.params : {}) as Record<string, unknown>;
  if (parsed.type === 'lsp-request' && !hasId(parsed)) return { ok: false, reason: 'missing id' };
  return {
    ok: true, type: parsed.type, id: parsed.id, method: parsed.method, params,
  };
}

function isPersistedEmptyIntentFile(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const fields = raw as { text?: unknown; source?: unknown; ts?: unknown; byProject?: unknown; unowned?: unknown; global?: unknown };
  if (fields.text === '' && fields.source === null && fields.ts === 0) return true;
  const byProject = fields.byProject;
  const hasEmptyMap = byProject && typeof byProject === 'object' && !Array.isArray(byProject)
    && Object.keys(byProject).length === 0;
  if (!hasEmptyMap) return false;
  if (Array.isArray(fields.unowned)) return fields.unowned.length === 0;
  return fields.global === null;
}

function shouldWarnForInvalidIntentFile(raw: unknown, revived: IntentState): boolean {
  if (!isEmptyIntent(revived)) return false;
  return !isPersistedEmptyIntentFile(raw);
}

interface IntentStateReader {
  readFileSync: (filePath: string, encoding: 'utf8') => string;
}

function loadIntentState({ intentStatePath, fsFns, warn, knownProjectIds }: {
  intentStatePath: string | null;
  fsFns: IntentStateReader;
  warn: (message: string) => void;
  knownProjectIds: string[] | null;
}): IntentState {
  if (!intentStatePath) return createIntentState();
  let rawText = '';
  try {
    rawText = fsFns.readFileSync(intentStatePath, 'utf8');
  } catch (error) {
    if (error && (error as { code?: unknown }).code === 'ENOENT') return createIntentState();
    warn(`intent state unreadable, starting empty: ${errorMessage(error)}`);
    return createIntentState();
  }
  try {
    const parsed: unknown = JSON.parse(rawText);
    const revived = reviveIntentState(parsed);
    if (shouldWarnForInvalidIntentFile(parsed, revived)) warn('intent state invalid, starting empty');
    return pruneIntentProjects(revived, knownProjectIds);
  } catch (error) {
    warn(`intent state unreadable, starting empty: ${errorMessage(error)}`);
    return createIntentState();
  }
}

function changeFailureReason(
  uri: string | null,
  version: unknown,
  result: { reason?: string; index?: number; range?: unknown; version?: unknown; currentVersion?: unknown },
): string {
  if (result.reason === 'invalid-range' || result.reason === 'invalid-text') {
    return `${result.reason} (uri=${uri} version=${version} change=${result.index} range=${formatRange(result.range as Parameters<typeof formatRange>[0])})`;
  }
  if (result.reason === 'stale-version') {
    return `stale-version (uri=${uri} incoming=${result.version} current=${result.currentVersion})`;
  }
  return `${result.reason} (uri=${uri} version=${version})`;
}

function createVisionsWiring({
  debounceMs = VISIONS_DEBOUNCE_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  nowFn = Date.now,
  sweep = sweepMarkdownWithFixes,
  maxPayload = MAX_FRAME_BYTES,
  autoFix = false,
  fixLogMax = DEFAULT_FIX_LOG_MAX,
  applyEditTimeoutMs = APPLY_EDIT_TIMEOUT_MS,
  logger = console,
  broadcast = null,
  dispatchConfig = null,
  dispatch = null,
  contextDigest = null,
  contextSeq = null,
  scopeProjects = null,
  knownProjectIds = null,
  getMemoryStore = null,
  onEditorEvent = null,
  memoryDeliveryLimit = MAX_DELIVERED_RECORDS,
  intentStatePath = null,
  intentThreadTtlMs = DEFAULT_THREAD_TTL_MS,
  fsFns = fs,
  fsPromises = fsPromisesDefault,
  digestBudgetChars = DIGEST_BUDGET_CHARS,
  hashFn = hashText,
  buildPrompt = buildVisionsPrompt,
  debug = false,
}: VisionsWiringOptions = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload });
  const connections = new Set<VisionsConnection>();
  const { debugNote, note, warn } = createLaneLog({ prefix: '[visions]', logger, debugFlag: debug });
  const findingsByUri = new Map<string, LineDiagnostic[]>();
  const ruleFindingsByUri = new Map<string, SweepDiagnostic[]>();
  const modelDiagnosticsByUri = new Map<string, LineDiagnostic[]>();
  const commentsByUri = new Map<string, VisionsComment[]>();
  const commentDiagnosticsByUri = new Map<string, LineDiagnostic[]>();
  const handsByUri = new Map<string, string>();
  const handDiagnosticsByUri = new Map<string, LineDiagnostic[]>();
  const openOwnersByUri = new Map<string, Set<VisionsConnection>>();
  const fixesByUri = new Map<string, { fixes: SweepFix[]; textHash: string }>();
  let fixLog: FixLogEntry[] = [];
  let nextApplyEditId = 1;
  const scopePaths = scopePathsOf(scopeProjects);
  let intentState = loadIntentState({
    intentStatePath, fsFns, warn, knownProjectIds,
  });
  const intentStateWriter = intentStatePath
    ? createJsonStateWriter({
      filePath: intentStatePath,
      fsPromises,
      warn: (error: unknown) => warn(`intent state write failed: ${errorMessage(error)}`),
    })
    : null;
  const dispatchSettings = resolveDispatchConfig(dispatchConfig);
  const dispatchEnabled = dispatchSettings.enabled === true && typeof dispatch === 'function';
  const dispatchState = createDispatchState();
  const lastGateByUri = new Map<string, string>();
  let dispatchInFlight = false;

  function noteGate(uri: string, { gate, trigger }: { gate: string | null; trigger: DispatchTrigger | null }): void {
    const key = `${trigger}:${gate}`;
    if (lastGateByUri.get(uri) === key) return;
    lastGateByUri.set(uri, key);
    note(`no dispatch for ${uri}: ${gate}${trigger ? ` (${trigger})` : ''}`);
  }

  function isUriInScope(uri: string | null): boolean {
    return isUriInProjects(uri, scopePaths);
  }

  const memoryStoreOf = typeof getMemoryStore === 'function' ? getMemoryStore : () => null;

  function reportEditorEvent(method: string, uri: string | null): void {
    if (typeof onEditorEvent !== 'function' || !uri) return;
    try {
      onEditorEvent({ method, uri });
    } catch (error) {
      warn(`editor ingest report failed: ${errorMessage(error)}`);
    }
  }
  const servedFindingKeys = createBoundedKeySet();
  const intentHeadByKey = new Map<string, string | null>();
  let intentHeadsSeeded = false;
  let memoryChain: Promise<void> = Promise.resolve();

  function queueMemoryWrite(work: (store: VisionsMemoryStore) => Promise<void>): void {
    const store = memoryStoreOf();
    if (!store) return;
    memoryChain = memoryChain.then(() => work(store)).catch((error: unknown) => warn(`memory write failed: ${errorMessage(error)}`));
  }

  function projectTagForUri(uri: string): string | null {
    return projectTagFor(projectForUri(uri, scopeProjects), scopeProjects);
  }

  function rememberRecords(inputs: unknown[]): void {
    const list = (Array.isArray(inputs) ? inputs : []).filter((input) => input !== null);
    if (list.length === 0) return;
    queueMemoryWrite(async (store) => {
      let written = 0;
      for (const input of list) {
        const record = await store.append(input as object);
        if (record) written += 1;
      }
      debugNote(() => `memory: ${written}/${list.length} record(s) written`);
    });
  }

  function seedIntentHeads(store: VisionsMemoryStore): void {
    if (intentHeadsSeeded) return;
    intentHeadsSeeded = true;
    if (typeof store.records !== 'function') return;
    for (const [key, id] of latestIntentHeads(store.records())) intentHeadByKey.set(key, id);
  }

  function readIntentHead(projectTag: string | null, threadId: string | null): { key: string; head: string | null; legacyKey: string | null } {
    const own = intentHeadKey(projectTag, threadId);
    if (intentHeadByKey.has(own)) return { key: own, head: intentHeadByKey.get(own) ?? null, legacyKey: null };
    const legacyKey = intentHeadKey(projectTag, null);
    return { key: own, head: intentHeadByKey.get(legacyKey) || null, legacyKey };
  }

  function rememberIntent(thread: IntentThread | null, projectTag: string | null): void {
    if (!thread) return;
    queueMemoryWrite(async (store) => {
      seedIntentHeads(store);
      const { key, head, legacyKey } = readIntentHead(projectTag, thread.id);
      const input = intentMemoryInput({
        text: thread.text, project: projectTag, supersedes: head, threadId: thread.id,
      });
      if (!input) return;
      const record = await store.append(input);
      if (!record) {
        intentHeadByKey.delete(key);
        return;
      }
      intentHeadByKey.set(key, record.id);
      if (legacyKey) intentHeadByKey.delete(legacyKey);
    });
  }

  function rememberServedFindings(uri: string, fixes: SweepFix[], version: number): void {
    if (!memoryStoreOf()) return;
    const project = projectTagForUri(uri);
    const inputs: unknown[] = [];
    for (const fix of fixes) {
      const { id, line } = servedFindingOf(fix);
      if (!servedFindingKeys.add(servedKey({ uri, version, id }))) continue;
      inputs.push(servedFeedbackInput({
        uri, project, id, line,
      }));
    }
    rememberRecords(inputs);
  }

  function broadcastFindings(uri: string, diagnostics: LineDiagnostic[]): void {
    if (typeof broadcast !== 'function') return;
    broadcast({ type: 'visions-findings', uri, diagnostics, ts: nowFn() });
  }

  function recordFindings(uri: string, diagnostics: LineDiagnostic[]): void {
    const findings = Array.isArray(diagnostics) ? diagnostics : [];
    if (findings.length === 0) findingsByUri.delete(uri);
    if (findings.length > 0) findingsByUri.set(uri, findings);
    broadcastFindings(uri, findings);
  }

  function unionDiagnosticsFor(uri: string): LineDiagnostic[] {
    return mergeDiagnostics(
      ruleFindingsByUri.get(uri) || [],
      modelDiagnosticsByUri.get(uri) || [],
      commentDiagnosticsByUri.get(uri) || [],
      handDiagnosticsByUri.get(uri) || [],
    );
  }

  function standingFindingsFor(uri: string): SweepDiagnostic[] {
    return ruleFindingsByUri.get(uri) || [];
  }

  function recordRuleFindings(uri: string, diagnostics: SweepDiagnostic[]): void {
    const findings = Array.isArray(diagnostics) ? diagnostics : [];
    if (findings.length === 0) ruleFindingsByUri.delete(uri);
    if (findings.length > 0) ruleFindingsByUri.set(uri, findings);
  }

  function clearFindings(uri: string): void {
    ruleFindingsByUri.delete(uri);
    if (!findingsByUri.delete(uri)) return;
    broadcastFindings(uri, []);
  }

  function publishDiagnosticsFrame(send: (message: unknown) => void, uri: string, diagnostics: LineDiagnostic[]): void {
    try {
      send({ type: 'publishDiagnostics', params: { uri, diagnostics } });
    } catch (error) {
      warn(`could not publish diagnostics for ${uri}: ${errorMessage(error)}`);
    }
  }

  function recordModelDiagnostics(
    uri: string,
    result: { diagnostics?: unknown } | null,
    doc: { text?: string } | null,
    touchedRanges: TouchedRange[],
  ): { changed: boolean; diagnostics: LineDiagnostic[] } {
    const { diagnostics, lintDomainDropped, outOfTouchDropped } = sanitizeModelDiagnostics(result?.diagnostics, {
      text: doc?.text || '', touchedRanges,
    });
    if (lintDomainDropped > 0) debugNote(() => `dropped ${lintDomainDropped} model diagnostics in the toolchain domain`);
    if (outOfTouchDropped > 0) note(`dropped ${outOfTouchDropped} model diagnostic(s) for ${uri} outside the edited lines`);
    const hadDiagnostics = modelDiagnosticsByUri.has(uri);
    if (diagnostics.length === 0) modelDiagnosticsByUri.delete(uri);
    if (diagnostics.length > 0) modelDiagnosticsByUri.set(uri, diagnostics);
    return { changed: hadDiagnostics || diagnostics.length > 0, diagnostics: unionDiagnosticsFor(uri) };
  }

  function dropDispatchDiagnostics(uri: string | null): void {
    if (!uri) return;
    modelDiagnosticsByUri.delete(uri);
    commentDiagnosticsByUri.delete(uri);
    handDiagnosticsByUri.delete(uri);
  }

  function broadcastComments(uri: string, comments: VisionsComment[]): void {
    if (typeof broadcast !== 'function') return;
    broadcast({ type: 'visions-comments', uri, comments, ts: nowFn() });
  }

  function recordComments(uri: string, comments: VisionsComment[], doc: { text?: string } | null = null): { changed: boolean } {
    const list = Array.isArray(comments) ? comments : [];
    if (list.length === 0) commentsByUri.delete(uri);
    if (list.length > 0) commentsByUri.set(uri, list);
    const diagnostics = commentsToLsp(list, { text: doc?.text || '' });
    const hadDiagnostics = commentDiagnosticsByUri.has(uri);
    if (diagnostics.length === 0) commentDiagnosticsByUri.delete(uri);
    if (diagnostics.length > 0) commentDiagnosticsByUri.set(uri, diagnostics);
    broadcastComments(uri, list);
    return { changed: hadDiagnostics || diagnostics.length > 0 };
  }

  function clearComments(uri: string): void {
    commentDiagnosticsByUri.delete(uri);
    if (!commentsByUri.delete(uri)) return;
    broadcastComments(uri, []);
  }

  function handFromResult(result: { hand?: unknown } | null): string | null {
    const hand = typeof result?.hand === 'string' ? result.hand.trim() : '';
    return hand || null;
  }

  function broadcastHand(uri: string, hand: string | null): void {
    if (typeof broadcast !== 'function') return;
    broadcast({
      type: 'visions-hand', uri, hand, ts: nowFn(),
    });
  }

  function recordHand(uri: string, hand: string | null, doc: { text?: string } | null = null): { changed: boolean } {
    const next = typeof hand === 'string' && hand ? hand : null;
    const previous = handsByUri.get(uri) || null;
    if (!next) handsByUri.delete(uri);
    if (next) handsByUri.set(uri, next);
    const diagnostics = handToLsp(next, { text: doc?.text || '' });
    const hadDiagnostics = handDiagnosticsByUri.has(uri);
    if (diagnostics.length === 0) handDiagnosticsByUri.delete(uri);
    if (diagnostics.length > 0) handDiagnosticsByUri.set(uri, diagnostics);
    if (previous !== next) broadcastHand(uri, next);
    return { changed: hadDiagnostics !== (diagnostics.length > 0) || previous !== next };
  }

  function clearHand(uri: string): void {
    recordHand(uri, null);
  }

  function recordFixes(uri: string, fixes: SweepFix[], textHash: string): void {
    if (fixes.length === 0) {
      fixesByUri.delete(uri);
      return;
    }
    fixesByUri.set(uri, { fixes, textHash });
  }

  function claimUri(uri: string | null, connection: VisionsConnection): void {
    if (!uri) return;
    const owners = openOwnersByUri.get(uri) || new Set<VisionsConnection>();
    owners.add(connection);
    openOwnersByUri.set(uri, owners);
  }

  function releaseUri(uri: string | null, connection: VisionsConnection): boolean {
    const owners = uri ? openOwnersByUri.get(uri) : null;
    if (!owners) return true;
    owners.delete(connection);
    if (owners.size > 0) return false;
    if (uri) openOwnersByUri.delete(uri);
    return true;
  }

  function clearUriState(uri: string): void {
    dropDispatchDiagnostics(uri);
    clearFindings(uri);
    clearComments(uri);
    clearHand(uri);
    fixesByUri.delete(uri);
    forgetUri(dispatchState, uri);
    lastGateByUri.delete(uri);
  }

  function logFix(uri: string, fix: SweepFix, applied: boolean): void {
    const entry = fixLogEntry({
      uri, fix, applied, ts: nowFn(),
    });
    fixLog = appendFixLog(fixLog, entry, fixLogMax);
    if (applied) rememberRecords([fixFeedbackInput({ uri, project: projectTagForUri(uri), fix })]);
    if (typeof broadcast !== 'function') return;
    broadcast({
      type: 'visions-fix', uri, fix: fixPayload(entry), ts: entry.ts,
    });
  }

  function documentsSnapshot() {
    const uris = new Set([...findingsByUri.keys(), ...commentsByUri.keys(), ...handsByUri.keys()]);
    return [...uris].map((uri) => ({
      uri,
      diagnostics: findingsByUri.get(uri) || [],
      comments: commentsByUri.get(uri) || [],
      hand: handsByUri.get(uri) || null,
    }));
  }

  function broadcastIntent(projectId: string | null, uri: string | null = null): void {
    if (typeof broadcast !== 'function') return;
    broadcast({
      type: 'visions-intent',
      projectId: projectId || null,
      intent: intentProjectPayload(intentState, projectId, uri),
      ts: nowFn(),
    });
  }

  function persistIntent(): void {
    if (!intentStateWriter) return;
    const payload = intentPayload(intentState);
    intentStateWriter.write(payload, () => JSON.stringify(payload, null, 2));
  }

  function commitIntent(
    merged: { changed: boolean; state: IntentState; thread: IntentThread | null },
    projectId: string | null,
    uri: string | null = null,
  ): boolean {
    if (!merged.changed) return false;
    intentState = merged.state;
    persistIntent();
    broadcastIntent(projectId, uri);
    rememberIntent(merged.thread, projectTagFor(projectId, scopeProjects));
    return true;
  }

  function retireIntentThreads(): void {
    const retired = retireStaleThreads(intentState, { now: nowFn(), ttlMs: intentThreadTtlMs });
    if (!retired.changed) return;
    intentState = retired.state;
    persistIntent();
    for (const projectId of retired.projects) broadcastIntent(projectId);
    note('intent threads retired on read');
  }

  function currentIntentState(): IntentState {
    retireIntentThreads();
    return intentState;
  }

  function applyModelIntent(intent: unknown, projectId: string | null = null, uri: string | null = null): boolean {
    const merged = mergeModelIntent(currentIntentState(), {
      intent, now: nowFn(), projectId, uri,
    });
    if (merged.refused) note(`intent proposal refused for ${projectId || 'unowned'}: ${merged.refused}`);
    const changed = commitIntent(merged, projectId, uri);
    const { thread } = merged;
    if (!changed || !thread) return false;
    note(`intent model-set for ${projectId || 'unowned'} (thread ${thread.id}, ${thread.text.length} chars)`);
    return true;
  }

  function applyOrientationResult(
    uri: string,
    result: DispatchOutcome,
    doc: StoredDoc | null,
    send: (message: unknown) => void,
  ): boolean {
    const discarded = result.verdict === 'COMMENTS' && Array.isArray(result.comments) ? result.comments.length : 0;
    if (discarded > 0) note(`refused comments for ${uri}: orientation=${discarded}`);
    const hand = handFromResult(result);
    rememberRecords(dispatchMemoryInputs({ uri, project: projectTagForUri(uri), comments: [], hand }));
    if (!hand) return true;
    const handUpdate = recordHand(uri, hand, doc);
    if (!handUpdate.changed) return true;
    const merged = unionDiagnosticsFor(uri);
    publishDiagnosticsFrame(send, uri, merged);
    recordFindings(uri, merged);
    return true;
  }

  function applyDispatchResult(
    uri: string,
    result: DispatchOutcome,
    doc: StoredDoc | null,
    send: (message: unknown) => void,
    focus: { touchedRanges: TouchedRange[]; orientation: boolean; activeThread: IntentThread | null },
  ): boolean {
    if (result.verdict === 'ERROR') {
      warn(`dispatch for ${uri} failed: ${result.reason || 'no reason given'}`);
      return false;
    }
    if (result.reason) note(`dispatch for ${uri}: ${result.reason}`);
    if (focus.orientation) return applyOrientationResult(uri, result, doc, send);
    const modelUpdate = recordModelDiagnostics(uri, result, doc, focus.touchedRanges);
    const filtered = filterComments({
      comments: result.verdict === 'COMMENTS' ? result.comments : [],
      hand: handFromResult(result),
      touchedRanges: focus.touchedRanges,
      activeThread: focus.activeThread,
    });
    const refusedCounts = formatDroppedComments(filtered.dropped);
    if (refusedCounts) note(`refused comments for ${uri}: ${refusedCounts}`);
    const { comments, hand } = filtered;
    const commentUpdate = recordComments(uri, comments, doc);
    const handUpdate = recordHand(uri, hand, doc);
    if (modelUpdate.changed || commentUpdate.changed || handUpdate.changed) {
      const merged = unionDiagnosticsFor(uri);
      publishDiagnosticsFrame(send, uri, merged);
      recordFindings(uri, merged);
    }
    rememberRecords(dispatchMemoryInputs({
      uri, project: projectTagForUri(uri), comments, hand,
    }));
    return true;
  }

  function readContextDigest(): string {
    if (typeof contextDigest !== 'function') return '';
    try {
      const digest = contextDigest({ scopes: null, budgetChars: digestBudgetChars, now: nowFn() });
      return typeof digest === 'string' ? digest : '';
    } catch (error) {
      warn(`context digest failed: ${errorMessage(error)}`);
      return '';
    }
  }

  async function readMemorySection(uri: string, text: string): Promise<MemorySection | null> {
    const store = memoryStoreOf();
    if (!store || typeof store.retrieve !== 'function') return null;
    try {
      const records = store.retrieve({
        query: text, project: projectTagForUri(uri), limit: memoryDeliveryLimit,
      });
      const lines = memoryDeliveryLines(records, { maxRecords: memoryDeliveryLimit });
      if (lines.length === 0) return null;
      const body = lines.join('\n');
      if (typeof store.noteDelivered === 'function') store.noteDelivered(body);
      debugNote(() => `memory: ${lines.length} record(s) delivered for ${uri}`);
      return { text: body, count: lines.length, version: await readProjectionVersion(store) };
    } catch (error) {
      warn(`memory retrieval failed: ${errorMessage(error)}`);
      return null;
    }
  }

  async function readProjectionVersion(store: VisionsMemoryStore): Promise<string | null> {
    if (typeof store.readPublishedManifest !== 'function') return null;
    const manifest = await store.readPublishedManifest();
    return typeof manifest?.version === 'string' ? manifest.version : null;
  }

  function readContextSeq(): number | null {
    if (typeof contextSeq !== 'function') return null;
    try {
      const seq = contextSeq();
      return Number.isFinite(seq) ? seq : null;
    } catch (error) {
      warn(`context seq failed: ${errorMessage(error)}`);
      return null;
    }
  }

  let dispatchSettled: Promise<unknown> = Promise.resolve();

  function snapshotMessage() {
    const documents = documentsSnapshot();
    note(`snapshot served: ${documents.length} documents`);
    return {
      type: 'visions-snapshot', documents, intent: intentPayload(currentIntentState()), fixes: fixLog, ts: nowFn(),
    };
  }

  function openConnection({ send }: { send: (message: unknown) => void }): VisionsConnection {
    const store = createDocStore();
    const sweepTimersByUri = new Map<string, NodeJS.Timeout>();
    const dispatchTimersByUri = new Map<string, NodeJS.Timeout>();
    const touchState = createTouchState();
    const orientedUris = new Set<string>();
    const pendingApplyEditById = new Map<string, PendingApplyEdit>();
    let closed = false;

    function cancelSweep(uri: string): void {
      const timer = sweepTimersByUri.get(uri);
      if (!timer) return;
      clearTimeoutFn(timer);
      sweepTimersByUri.delete(uri);
    }

    function cancelDispatch(uri: string): void {
      const timer = dispatchTimersByUri.get(uri);
      if (!timer) return;
      clearTimeoutFn(timer);
      dispatchTimersByUri.delete(uri);
    }

    async function runDispatch(uri: string, armedBy: DispatchTrigger = 'edit'): Promise<void> {
      if (!dispatchEnabled || closed) return;
      const doc = getDoc(store, uri);
      if (!doc || !isMarkdownDoc(doc)) return;
      const text = typeof doc.text === 'string' ? doc.text : '';
      const textHash = hashFn(text);
      const projectId = projectForUri(uri, scopeProjects);
      const seq = readContextSeq();
      const touchedRanges = touchedRangesFor(touchState, uri);
      const decision = decideDispatch({
        state: dispatchState,
        uri,
        text,
        textHash,
        now: nowFn(),
        config: dispatchSettings,
        inFlight: dispatchInFlight,
        contextSeq: seq,
        armedBy,
        inScope: isUriInScope(uri),
        editedSinceOpen: touchedRanges.length > 0,
        oriented: orientedUris.has(uri),
      });
      if (!decision.dispatch) {
        noteGate(uri, decision);
        return;
      }
      const documentSizeDecision = decideDocumentSize(text, decision.trigger);
      if (!documentSizeDecision.dispatch) {
        noteGate(uri, documentSizeDecision);
        return;
      }
      const orientation = decision.reason === ORIENTATION_REASON;
      const [activeThread = null, ...rest] = liveThreadsFor(currentIntentState(), projectId, uri);
      const otherThreads = rest.filter((thread) => !thread.uris.includes(uri));
      const focus = { touchedRanges, orientation, activeThread };
      dispatchInFlight = true;
      let result: DispatchOutcome | null = null;
      try {
        const memory = memoryStoreOf() ? await readMemorySection(uri, text) : null;
        const digest = readContextDigest();
        const prompt = buildPrompt({
          uri,
          text,
          findings: standingFindingsFor(uri),
          intent: { active: activeThread, others: otherThreads },
          digest,
          memory,
          touchedRanges,
          orientation,
        });
        const sizeDecision = decidePromptSize(prompt, decision.trigger);
        if (!sizeDecision.dispatch) {
          noteGate(uri, sizeDecision);
          return;
        }
        lastGateByUri.delete(uri);
        recordDispatch(dispatchState, {
          uri, textHash, now: nowFn(), contextSeq: seq, trigger: decision.trigger, reason: decision.reason,
        });
        if (orientation) orientedUris.add(uri);
        note(`dispatching ${uri}: ${orientation ? 'orientation' : `edited lines ${formatTouchedRanges(touchedRanges)}`}`);
        result = await dispatch?.({
          uri,
          text,
          findings: standingFindingsFor(uri),
          intent: activeThread ? activeThread.text : '',
          digest,
          memory,
          prompt,
        });
      } catch (error) {
        warn(`dispatch for ${uri} threw: ${errorMessage(error)}`);
      } finally {
        dispatchInFlight = false;
      }
      if (!result) return;
      const outcome = noteDispatchOutcome(dispatchState, {
        verdict: result.verdict, errorSource: result.errorSource, now: nowFn(),
      });
      if (outcome.backingOff) {
        warn(`${ERROR_BACKOFF_THRESHOLD} dispatches failed in a row; no dispatch until ${new Date(outcome.backoffUntil).toISOString()}`);
      }
      const currentDoc = getDoc(store, uri);
      if (closed || !currentDoc) {
        note(`dropped a dispatch result for ${uri}: the buffer is gone`);
        return;
      }
      if (hashFn(currentDoc.text) !== textHash) {
        note(`dropped a dispatch result for ${uri}: the buffer moved`);
        return;
      }
      const recorded = applyDispatchResult(uri, result, currentDoc, send, focus);
      if (!recorded) return;
      const intentMoved = applyModelIntent(result.intent, projectId, uri);
      note(`dispatch for ${uri} applied: ${result.verdict}, ${(commentsByUri.get(uri) || []).length} comments, hand=${handsByUri.has(uri) ? 'yes' : 'no'}, intent-moved=${intentMoved ? 'yes' : 'no'}`);
    }

    function armDispatch(uri: string, armedBy: DispatchTrigger): void {
      if (!dispatchEnabled || closed || !uri) return;
      cancelDispatch(uri);
      const timer = setTimeoutFn(() => {
        dispatchTimersByUri.delete(uri);
        if (closed) return;
        dispatchSettled = runDispatch(uri, armedBy).catch((error: unknown) => warn(`dispatch loop failed: ${errorMessage(error)}`));
      }, dispatchSettings.quietMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
      dispatchTimersByUri.set(uri, timer);
      debugNote(() => `dispatch armed for ${uri} by ${armedBy} in ${dispatchSettings.quietMs}ms`);
    }

    function rearmDispatch(uri: string): void {
      if (!dispatchTimersByUri.has(uri)) return;
      armDispatch(uri, 'edit');
    }

    function noteActivity(): void {
      if (!dispatchEnabled || closed) return;
      for (const doc of listDocs(store)) {
        if (!doc || !isMarkdownDoc(doc)) continue;
        if (dispatchTimersByUri.has(doc.uri)) continue;
        armDispatch(doc.uri, 'activity');
      }
    }

    function sendResponse(id: unknown, result: unknown): void {
      try {
        send({ type: 'lsp-response', id, result });
      } catch (error) {
        warn(`could not answer request ${id}: ${errorMessage(error)}`);
      }
    }

    function codeActionsFor(params: Record<string, unknown> | undefined) {
      const target = params?.textDocument as { uri?: unknown } | undefined;
      const uri = target?.uri;
      if (typeof uri !== 'string' || !uri) return [];
      const doc = getDoc(store, uri);
      if (!doc) return [];
      const entry = fixesByUri.get(uri);
      if (!entry || !isFixSetFresh(entry, hashFn(doc.text))) return [];
      const offered = filterFixesByRange(entry.fixes, params?.range as Parameters<typeof filterFixesByRange>[1]);
      rememberServedFindings(uri, offered, doc.version);
      return buildCodeActions(offered, { uri, version: doc.version });
    }

    function handleRequestFrame(frame: { id?: unknown; method?: string; params?: Record<string, unknown> }): void {
      if (frame.method !== CODE_ACTION_METHOD) {
        sendResponse(frame.id, null);
        return;
      }
      sendResponse(frame.id, codeActionsFor(frame.params));
    }

    function settleApplyEdit(id: string, result: { applied?: unknown } | null | undefined, reason: string): void {
      const pending = pendingApplyEditById.get(id);
      if (!pending) return;
      pendingApplyEditById.delete(id);
      if (pending.timer) clearTimeoutFn(pending.timer);
      const applied = !!result && result.applied === true;
      for (const fix of pending.fixes) logFix(pending.uri, fix, applied);
      if (applied) note(`auto-fixed ${pending.uri}: ${pending.fixes.length} edits applied`);
      if (!applied) note(`auto-fix refused for ${pending.uri}: ${reason}`);
    }

    function handleResponseFrame(frame: { id?: unknown; result?: unknown }): void {
      settleApplyEdit(String(frame.id), frame.result as { applied?: unknown } | null, 'the editor refused the edit');
    }

    function failPendingApplyEdits(reason: string, uri: string | null = null): void {
      for (const id of [...pendingApplyEditById.keys()]) {
        const pending = pendingApplyEditById.get(id);
        if (uri && pending?.uri !== uri) continue;
        settleApplyEdit(id, { applied: false }, reason);
      }
    }

    function requestAutoFix(uri: string, doc: StoredDoc): void {
      if (!autoFix) return;
      const entry = fixesByUri.get(uri);
      const safe = autoSafeFixes(entry ? entry.fixes : []);
      if (safe.length === 0) return;
      const id = `visions-fix-${nextApplyEditId}`;
      nextApplyEditId += 1;
      const timer = setTimeoutFn(() => settleApplyEdit(id, { applied: false }, 'no answer from the editor'), applyEditTimeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
      pendingApplyEditById.set(id, { uri, fixes: safe, timer });
      try {
        send({
          type: 'lsp-request', id, method: APPLY_EDIT_METHOD, params: buildApplyEditParams(safe, { uri, version: doc.version }),
        });
      } catch (error) {
        settleApplyEdit(id, { applied: false }, `the frame could not be sent (${errorMessage(error)})`);
      }
    }

    function publishDiagnostics(uri: string, armedBy = 'edit'): void {
      const doc = getDoc(store, uri);
      if (!doc || !isMarkdownDoc(doc)) return;
      if (!isUriInScope(uri)) return;
      const { diagnostics, fixes } = readSweepResult(sweep(doc.text));
      recordRuleFindings(uri, diagnostics);
      const mergedDiagnostics = unionDiagnosticsFor(uri);
      publishDiagnosticsFrame(send, uri, mergedDiagnostics);
      recordFindings(uri, mergedDiagnostics);
      recordFixes(uri, fixes, hashFn(doc.text));
      requestAutoFix(uri, doc);
      if (armedBy === 'save') note(`swept ${uri} on save: ${diagnostics.length} findings`);
      if (armedBy !== 'save') debugNote(() => `swept ${uri}: ${diagnostics.length} findings`);
      armDispatch(uri, 'edit');
    }

    function scheduleSweep(uri: string | null): void {
      if (closed || !uri) return;
      if (!isMarkdownDoc(getDoc(store, uri))) return;
      if (!isUriInScope(uri)) return;
      rearmDispatch(uri);
      cancelSweep(uri);
      const timer = setTimeoutFn(() => {
        sweepTimersByUri.delete(uri);
        if (closed) return;
        publishDiagnostics(uri);
      }, debounceMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
      sweepTimersByUri.set(uri, timer);
    }

    const handlersByMethod: Record<string, ((params: Record<string, unknown> | undefined) => string | null) | undefined> = {
      'textDocument/didOpen': (params) => {
        const result = applyDidOpen(store, params);
        if (!result.applied) return result.reason ?? null;
        const uri = uriOfParams(params);
        reportEditorEvent('textDocument/didOpen', uri);
        claimUri(uri, connection);
        resetTouchedUri(touchState, uri);
        if (uri) orientedUris.delete(uri);
        const doc = uri ? getDoc(store, uri) : null;
        if (doc) note(`didOpen ${uri} (${doc.text.length} chars, ${listDocs(store).length} open)`);
        scheduleSweep(uri);
        return null;
      },
      'textDocument/didChange': (params) => {
        const uri = uriOfParams(params);
        const version = (params?.textDocument as { version?: unknown } | undefined)?.version;
        const previousDoc = uri ? getDoc(store, uri) : null;
        const result = applyDidChange(store, params);
        if (!result.applied) return changeFailureReason(uri, version, result);
        const doc = uri ? getDoc(store, uri) : null;
        dropDispatchDiagnostics(uri);
        if (uri && doc && isMarkdownDoc(doc)) recordChanges(touchState, uri, result.changes || [], doc.text);
        debugNote(() => `didChange ${uri} v${version} (${result.changeCount} changes, ${result.size} chars)`);
        scheduleSweep(uri);
        if (!uri || !previousDoc || !doc || !isMarkdownDoc(doc)) return null;
        if (!detectBlankLineBoundary({
          previousText: previousDoc.text,
          nextText: doc.text,
          changes: params?.contentChanges as Parameters<typeof detectBlankLineBoundary>[0]['changes'],
        })) return null;
        cancelDispatch(uri);
        dispatchSettled = runDispatch(uri, 'edit').catch((error: unknown) => warn(`dispatch loop failed: ${errorMessage(error)}`));
        return null;
      },
      'textDocument/didSave': (params) => {
        const uri = uriOfParams(params);
        if (!uri) return 'invalid-params';
        reportEditorEvent('textDocument/didSave', uri);
        cancelSweep(uri);
        publishDiagnostics(uri, 'save');
        cancelDispatch(uri);
        dispatchSettled = runDispatch(uri, 'edit').catch((error: unknown) => warn(`dispatch loop failed: ${errorMessage(error)}`));
        return null;
      },
      [ACTIVITY_METHOD]: (params) => {
        const uri = typeof params?.uri === 'string' ? params.uri : null;
        const method = typeof params?.method === 'string' ? params.method : null;
        if (!uri || !method) return 'invalid-params';
        reportEditorEvent(method, uri);
        return null;
      },
      'visions/dismissFinding': (params) => {
        const dismissal = readDismissParams(params);
        if (!dismissal || !isUriInScope(dismissal.uri)) {
          debugNote(() => 'dropped a dismissal: unusable params or out of scope');
          return null;
        }
        rememberRecords([dismissFeedbackInput({
          uri: dismissal.uri, project: projectTagForUri(dismissal.uri), id: dismissal.id,
        })]);
        return null;
      },
      'textDocument/didClose': (params) => {
        const uri = uriOfParams(params);
        if (uri) cancelSweep(uri);
        if (uri) cancelDispatch(uri);
        const result = applyDidClose(store, params);
        const isLastOwner = releaseUri(uri, connection);
        resetTouchedUri(touchState, uri);
        if (uri) orientedUris.delete(uri);
        if (!result.applied) return result.reason ?? null;
        reportEditorEvent('textDocument/didClose', uri);
        note(`didClose ${uri} (${listDocs(store).length} open)`);
        failPendingApplyEdits('the buffer closed', uri);
        if (!isLastOwner || !uri) return null;
        clearUriState(uri);
        return null;
      },
    };

    function handleFrame(raw: string): void {
      if (closed) return;
      const frame = readFrame(raw);
      if (!frame.ok) {
        warn(`dropped a frame: ${frame.reason}`);
        return;
      }
      if (frame.type === 'lsp-request') {
        handleRequestFrame(frame);
        return;
      }
      if (frame.type === 'lsp-response') {
        handleResponseFrame(frame);
        return;
      }
      const handler = frame.method ? handlersByMethod[frame.method] : undefined;
      if (!handler) return;
      const reason = handler(frame.params);
      if (!reason) return;
      warn(`ignored ${frame.method}: ${reason}`);
    }

    function close(): void {
      if (closed) return;
      closed = true;
      for (const timer of sweepTimersByUri.values()) clearTimeoutFn(timer);
      sweepTimersByUri.clear();
      for (const timer of dispatchTimersByUri.values()) clearTimeoutFn(timer);
      dispatchTimersByUri.clear();
      failPendingApplyEdits('the relay disconnected');
      const dropped = listDocs(store);
      for (const doc of dropped) {
        if (!doc) continue;
        applyDidClose(store, { textDocument: { uri: doc.uri } });
        if (releaseUri(doc.uri, connection)) clearUriState(doc.uri);
      }
      connections.delete(connection);
      note(`connection closed: ${dropped.length} mirrored documents dropped, ${connections.size} connections remain`);
    }

    const connection: VisionsConnection = {
      handleFrame,
      close,
      noteActivity,
      get docCount() { return listDocs(store).length; },
      get pendingSweepCount() { return sweepTimersByUri.size; },
      get pendingDispatchCount() { return dispatchTimersByUri.size; },
      get isClosed() { return closed; },
    };
    connections.add(connection);
    note(`connection opened: ${connections.size} connections, dispatch ${dispatchEnabled ? 'on' : 'off'}`);
    return connection;
  }

  function attach(ws: WebSocket): VisionsConnection {
    const connection = openConnection({
      send: (message: unknown) => {
        if (ws.readyState !== 1) return;
        ws.send(JSON.stringify(message));
      },
    });
    ws.on('message', (data: Buffer) => handleSocketData(connection, data));
    ws.on('error', (error: Error) => warn(`socket error: ${errorMessage(error)}`));
    ws.on('close', () => connection.close());
    return connection;
  }

  function handleSocketData(connection: VisionsConnection, data: Buffer): void {
    try {
      connection.handleFrame(data.toString());
    } catch (error) {
      warn(`frame handling failed: ${errorMessage(error)}`);
    }
  }

  function noteActivity(): void {
    if (!dispatchEnabled) return;
    for (const connection of connections) connection.noteActivity();
  }

  wss.on('connection', (ws) => { attach(ws); });

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  }

  function stop(): void {
    for (const client of wss.clients) client.close(1001, 'Visions stopped');
    for (const connection of [...connections]) connection.close();
    wss.close();
  }

  return {
    handleUpgrade,
    attach,
    openConnection,
    stop,
    documentsSnapshot,
    snapshotMessage,
    applyModelIntent,
    noteActivity,
    getIntent: () => intentPayload(currentIntentState()),
    getIntentFor: (projectId: string | null = null, uri: string | null = null) => intentProjectPayload(currentIntentState(), projectId, uri),
    whenIntentPersistenceIdle: () => (intentStateWriter ? intentStateWriter.idle() : Promise.resolve()),
    whenMemoryIdle: () => memoryChain,
    latestContextSeq: readContextSeq,
    whenDispatchSettled: () => Promise.resolve(dispatchSettled),
    get connectionCount() { return connections.size; },
    get dispatchEnabled() { return dispatchEnabled; },
  };
}

export {
  APPLY_EDIT_TIMEOUT_MS,
  DIGEST_BUDGET_CHARS,
  VISIONS_DEBOUNCE_MS,
  createVisionsWiring,
  isMarkdownDoc,
  readFrame,
};
export type { DispatchOutcome, MemorySection, VisionsConnection, VisionsMemoryStore, VisionsWiringOptions };
