// Visions lane IO shell. Design rationale lives in docs/archive/plan-navigator.md.

'use strict';

const fs = require('node:fs');
const fsPromisesDefault = require('node:fs/promises');
const { WebSocketServer } = require('ws');
const {
  applyDidChange, applyDidClose, applyDidOpen, createDocStore, detectBlankLineBoundary, formatRange, getDoc, listDocs, uriOfParams,
} = require('./core/visions-buffer-core');
const {
  buildVisionsPrompt,
  createDispatchState,
  decideDispatch,
  decidePromptSize,
  forgetUri,
  hashText,
  commentsToLsp,
  mergeDiagnostics,
  recordDispatch,
  resolveDispatchConfig,
  sanitizeModelDiagnostics,
} = require('./core/visions-dispatch-core');
const { isUriInProjects, projectForUri, scopePathsOf } = require('./core/visions-scope-core');
const {
  applyModelIntent: mergeModelIntent,
  createIntentSlot,
  createIntentState,
  intentPayload,
  intentSlotFor,
  intentSlotPayload,
  intentTextFor,
  isEmptyIntent,
  pruneIntentProjects,
  reviveIntentState,
} = require('./core/visions-intent-core');
const {
  createBoundedKeySet,
  dismissFeedbackInput,
  dispatchMemoryInputs,
  fixFeedbackInput,
  intentMemoryInput,
  MAX_DELIVERED_RECORDS,
  latestIntentHeads,
  memoryDeliveryLines,
  projectTagFor,
  readDismissParams,
  servedFeedbackInput,
  servedFindingOf,
  servedKey,
  slotKeyOf,
} = require('./core/visions-memory-core');
const { sweepMarkdownWithFixes } = require('./core/visions-rules-core');
const {
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
} = require('./core/visions-fix-core');
const { createJsonStateWriter } = require('./json-file');
const { createLaneLog } = require('./lane-log');

// Quiet window before a document is swept.
const VISIONS_DEBOUNCE_MS = 300;
// Whole-document didChange frames can carry editor buffers up to the data WS cap.
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MARKDOWN_EXTENSIONS = ['.md', '.markdown'];
// What one dispatch prompt will spend on recent activity, beside a buffer that can be far larger.
const DIGEST_BUDGET_CHARS = 2000;
const CODE_ACTION_METHOD = 'textDocument/codeAction';
const APPLY_EDIT_METHOD = 'workspace/applyEdit';
// An editor that never answers an applyEdit leaves a slot and a changelog line owed; this bounds both.
const APPLY_EDIT_TIMEOUT_MS = 2000;
const FRAME_TYPES = new Set(['lsp', 'lsp-request', 'lsp-response']);

function isMarkdownDoc(doc) {
  if (!doc) return false;
  if (doc.languageId === 'markdown') return true;
  const uri = typeof doc.uri === 'string' ? doc.uri.toLowerCase() : '';
  return MARKDOWN_EXTENSIONS.some((extension) => uri.endsWith(extension));
}

// A null id is JSON-RPC for "no id", which is exactly as unroutable here as an absent one.
function hasId(parsed) {
  return parsed.id !== null && parsed.id !== undefined;
}

// One relay frame, or the reason it is unusable.
function readFrame(raw) {
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'unparsable JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'not an object' };
  if (!FRAME_TYPES.has(parsed.type)) return { ok: false, reason: `unsupported frame type ${JSON.stringify(parsed.type)}` };
  if (parsed.type === 'lsp-response') {
    if (!hasId(parsed)) return { ok: false, reason: 'missing id' };
    return { ok: true, type: parsed.type, id: parsed.id, result: parsed.result };
  }
  if (typeof parsed.method !== 'string') return { ok: false, reason: 'missing method' };
  const params = parsed.params && typeof parsed.params === 'object' ? parsed.params : {};
  if (parsed.type === 'lsp-request' && !hasId(parsed)) return { ok: false, reason: 'missing id' };
  return {
    ok: true, type: parsed.type, id: parsed.id, method: parsed.method, params,
  };
}

function isPersistedEmptyIntentFile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const legacyEmpty = createIntentSlot();
  if (raw.text === legacyEmpty.text && raw.source === legacyEmpty.source && raw.ts === legacyEmpty.ts) return true;
  const byProject = raw.byProject;
  const hasEmptyMap = byProject && typeof byProject === 'object' && !Array.isArray(byProject)
    && Object.keys(byProject).length === 0;
  return raw.global === null && hasEmptyMap;
}

function shouldWarnForInvalidIntentFile(raw, revived) {
  if (!isEmptyIntent(revived)) return false;
  return !isPersistedEmptyIntentFile(raw);
}

// The prune runs AFTER the warn decision: a file whose only statements belonged to deleted projects was
// valid when it was written, and calling that invalid would put a warning on a routine deletion.
function loadIntentState({ intentStatePath, fsFns, warn, knownProjectIds }) {
  if (!intentStatePath) return createIntentState();
  let rawText = '';
  try {
    rawText = fsFns.readFileSync(intentStatePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return createIntentState();
    warn(`intent state unreadable, starting empty: ${error.message}`);
    return createIntentState();
  }
  try {
    const parsed = JSON.parse(rawText);
    const revived = reviveIntentState(parsed);
    if (shouldWarnForInvalidIntentFile(parsed, revived)) warn('intent state invalid, starting empty');
    return pruneIntentProjects(revived, knownProjectIds);
  } catch (error) {
    warn(`intent state unreadable, starting empty: ${error.message}`);
    return createIntentState();
  }
}

/*
 * What a refused didChange needs beside its reason for the log line to answer the next question by
 * itself: which buffer, which frame, and which change in the batch was the malformed one.
 */
function changeFailureReason(uri, version, result) {
  if (result.reason === 'invalid-range' || result.reason === 'invalid-text') {
    return `${result.reason} (uri=${uri} version=${version} change=${result.index} range=${formatRange(result.range)})`;
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
  // Tier 1 silent fixes (docs/archive/plan-navigator-2.md, M6). The pull half is always on with the lane; this
  // flag governs only the push half, where an edit lands in the buffer without being asked for.
  autoFix = false,
  fixLogMax = DEFAULT_FIX_LOG_MAX,
  applyEditTimeoutMs = APPLY_EDIT_TIMEOUT_MS,
  logger = console,
  broadcast = null,
  // Tier 3 model dispatch (docs/archive/plan-navigator.md, M4). Absent config or no dispatch function means
  // the lane behaves exactly as it did before M4: no dispatch timer is ever armed and nothing spawns.
  dispatchConfig = null,
  dispatch = null,
  // Cross-source context digest from the ingest lane (docs/plan-ingestion.md, M6). Absent by default
  // and then never called, which is what keeps a dispatch prompt with no ingest lane byte-identical.
  contextDigest = null,
  // The ingest lane's newest seq (docs/plan-ingestion.md, M7.5): the movement signal that lets the gate
  // see activity the buffer never showed. Absent means null, and the gate is then the pre-M7.5 one.
  contextSeq = null,
  // Each entry is { id, path }: the id names the intent slot a uri's proposals land in, the path scopes it.
  scopeProjects = null,
  knownProjectIds = null,
  /*
   * Long-term memory (docs/plan-visions-3.md, M13). A thunk because the store is constructed once at
   * boot and is null on a default config; every writer below is then a no-op and nothing is recorded.
   */
  getMemoryStore = null,
  // How many remembered records one dispatch prompt may carry (docs/plan-visions-3.md, M16).
  memoryDeliveryLimit = MAX_DELIVERED_RECORDS,
  intentStatePath = null,
  fsFns = fs,
  fsPromises = fsPromisesDefault,
  digestBudgetChars = DIGEST_BUDGET_CHARS,
  hashFn = hashText,
  buildPrompt = buildVisionsPrompt,
  // Per-keystroke chatter, off unless the operator turned debugMode on. Boolean or getter, and the
  // privacy rule every line here obeys lives with the helper in server/lane-log.js.
  debug = false,
} = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload });
  const connections = new Set();
  const { debugNote, note, warn } = createLaneLog({ prefix: '[visions]', logger, debugFlag: debug });
  /*
   * Findings the Visions tab is currently showing, keyed by uri and shared across relays: the tab is a
   * view of what is open in the editors, not of which socket mirrored it. A uri with no findings is
   * ABSENT rather than stored empty, so the map and the rendered sections always agree.
   */
  const findingsByUri = new Map();
  const ruleFindingsByUri = new Map();
  const modelDiagnosticsByUri = new Map();
  /*
   * Tier 3 model comments, keyed by uri beside the findings and on the same lifecycle: replaced whole
   * by each dispatch, cleared on didClose. Separate from findingsByUri because a document can have one
   * kind without the other, and the tab renders them as two different things.
   */
  const commentsByUri = new Map();
  // The same comments as LSP diagnostics, kept apart from the tab's copy because they die with the next
  // keystroke exactly as the model diagnostics beside them do.
  const commentDiagnosticsByUri = new Map();
  const handsByUri = new Map();
  const openOwnersByUri = new Map();
  /*
   * Tier 1 fixes from the last sweep of each uri, stored WITH the text hash they were computed against.
   * A code action is offered only while that hash still describes the buffer, so a fix can never be
   * served against text the carbon unit has already moved on from.
   */
  const fixesByUri = new Map();
  // What the lane has actually touched, applied and refused alike: the tab's audit of tier 1.
  let fixLog = [];
  let nextApplyEditId = 1;
  // The intent model (docs/archive/plan-navigator.md, M5), one statement per project.
  const scopePaths = scopePathsOf(scopeProjects);
  let intentState = loadIntentState({
    intentStatePath, fsFns, warn, knownProjectIds,
  });
  const intentStateWriter = intentStatePath
    ? createJsonStateWriter({
      filePath: intentStatePath,
      fsPromises,
      warn: (error) => warn(`intent state write failed: ${error.message}`),
    })
    : null;
  const dispatchSettings = resolveDispatchConfig(dispatchConfig);
  const dispatchEnabled = dispatchSettings.enabled === true && typeof dispatch === 'function';
  const dispatchState = createDispatchState();
  /*
   * The last gate LOGGED per uri. Activity arms a window as often as the machine moves, so an
   * undeduped refusal line is one log entry per open document per quiet window, forever. A refusal is
   * news when the gate CHANGES; the same gate holding again is the steady state, not an event.
   */
  const lastGateByUri = new Map();
  // Concurrency 1, machine-wide: a dispatch while one is in flight is GATED, never queued.
  let dispatchInFlight = false;

  /*
   * Keyed by trigger AND gate, never the gate alone: a poke and a save can be refused by the same cap
   * for entirely different reasons, and the operator's own save being turned away is exactly the line
   * that must not be swallowed by the machine's. A dispatch clears the mark, so the next refusal is news.
   */
  function noteGate(uri, { gate, trigger }) {
    const key = `${trigger}:${gate}`;
    if (lastGateByUri.get(uri) === key) return;
    lastGateByUri.set(uri, key);
    note(`no dispatch for ${uri}: ${gate}${trigger ? ` (${trigger})` : ''}`);
  }

  function isUriInScope(uri) {
    return isUriInProjects(uri, scopePaths);
  }

  const memoryStoreOf = typeof getMemoryStore === 'function' ? getMemoryStore : () => null;
  const servedFindingKeys = createBoundedKeySet();
  const intentHeadByProject = new Map();
  let intentHeadsSeeded = false;
  // One chain for every memory write, so a supersession can never interleave with the record it names.
  let memoryChain = Promise.resolve();

  function queueMemoryWrite(work) {
    const store = memoryStoreOf();
    if (!store) return;
    memoryChain = memoryChain.then(() => work(store)).catch((error) => warn(`memory write failed: ${String(error?.message || error)}`));
  }

  function projectTagForUri(uri) {
    return projectTagFor(projectForUri(uri, scopeProjects), scopeProjects);
  }

  // Counts only: what was remembered is never what is logged.
  function rememberRecords(inputs) {
    const list = (Array.isArray(inputs) ? inputs : []).filter((input) => input !== null);
    if (list.length === 0) return;
    queueMemoryWrite(async (store) => {
      let written = 0;
      for (const input of list) {
        const record = await store.append(input);
        if (record) written += 1;
      }
      debugNote(() => `memory: ${written}/${list.length} record(s) written`);
    });
  }

  // Seeded from the loaded canon, so a restart continues the intent chain instead of forking a new one.
  function seedIntentHeads(store) {
    if (intentHeadsSeeded) return;
    intentHeadsSeeded = true;
    if (typeof store.records !== 'function') return;
    for (const [key, id] of latestIntentHeads(store.records())) intentHeadByProject.set(key, id);
  }

  function rememberIntent(text, projectTag) {
    queueMemoryWrite(async (store) => {
      seedIntentHeads(store);
      const key = slotKeyOf(projectTag);
      const input = intentMemoryInput({
        text, project: projectTag, supersedes: intentHeadByProject.get(key) || null,
      });
      // Nothing to remember is not a refusal, so it leaves the chain head exactly where it was.
      if (!input) return;
      const record = await store.append(input);
      // A refused write leaves the chain naming a head no later record could resolve, so it starts over.
      if (!record) intentHeadByProject.delete(key);
      if (record) intentHeadByProject.set(key, record.id);
    });
  }

  function rememberServedFindings(uri, fixes, version) {
    if (!memoryStoreOf()) return;
    const project = projectTagForUri(uri);
    const inputs = [];
    for (const fix of fixes) {
      const { id, line } = servedFindingOf(fix);
      if (!servedFindingKeys.add(servedKey({ uri, version, id }))) continue;
      inputs.push(servedFeedbackInput({
        uri, project, id, line,
      }));
    }
    rememberRecords(inputs);
  }

  function broadcastFindings(uri, diagnostics) {
    if (typeof broadcast !== 'function') return;
    broadcast({ type: 'visions-findings', uri, diagnostics, ts: nowFn() });
  }

  function recordFindings(uri, diagnostics) {
    const findings = Array.isArray(diagnostics) ? diagnostics : [];
    if (findings.length === 0) findingsByUri.delete(uri);
    if (findings.length > 0) findingsByUri.set(uri, findings);
    broadcastFindings(uri, findings);
  }

  function unionDiagnosticsFor(uri) {
    return mergeDiagnostics(
      ruleFindingsByUri.get(uri) || [],
      modelDiagnosticsByUri.get(uri) || [],
      commentDiagnosticsByUri.get(uri) || [],
    );
  }

  function recordRuleFindings(uri, diagnostics) {
    const findings = Array.isArray(diagnostics) ? diagnostics : [];
    if (findings.length === 0) ruleFindingsByUri.delete(uri);
    if (findings.length > 0) ruleFindingsByUri.set(uri, findings);
  }

  // A uri the tab never had a section for needs no message telling it to forget one.
  function clearFindings(uri) {
    ruleFindingsByUri.delete(uri);
    if (!findingsByUri.delete(uri)) return;
    broadcastFindings(uri, []);
  }

  function publishDiagnosticsFrame(send, uri, diagnostics) {
    try {
      send({ type: 'publishDiagnostics', params: { uri, diagnostics } });
    } catch (error) {
      warn(`could not publish diagnostics for ${uri}: ${error.message}`);
    }
  }

  function recordModelDiagnostics(uri, result, doc) {
    const { diagnostics, lintDomainDropped } = sanitizeModelDiagnostics(result?.diagnostics, { text: doc?.text || '' });
    if (lintDomainDropped > 0) debugNote(() => `dropped ${lintDomainDropped} model diagnostics in the toolchain domain`);
    const hadDiagnostics = modelDiagnosticsByUri.has(uri);
    if (diagnostics.length === 0) modelDiagnosticsByUri.delete(uri);
    if (diagnostics.length > 0) modelDiagnosticsByUri.set(uri, diagnostics);
    return { changed: hadDiagnostics || diagnostics.length > 0, diagnostics: unionDiagnosticsFor(uri) };
  }

  // Both halves of a dispatch describe the text it read, so a buffer that moved invalidates both.
  function dropDispatchDiagnostics(uri) {
    modelDiagnosticsByUri.delete(uri);
    commentDiagnosticsByUri.delete(uri);
  }

  function broadcastComments(uri, comments) {
    if (typeof broadcast !== 'function') return;
    broadcast({ type: 'visions-comments', uri, comments, ts: nowFn() });
  }

  // Wholesale replacement, like a sweep's findings: a uri with no comments is absent, never stored empty.
  function recordComments(uri, comments, doc = null) {
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

  function clearComments(uri) {
    commentDiagnosticsByUri.delete(uri);
    if (!commentsByUri.delete(uri)) return;
    broadcastComments(uri, []);
  }

  function handFromResult(result) {
    const hand = typeof result?.hand === 'string' ? result.hand.trim() : '';
    return hand || null;
  }

  function broadcastHand(uri, hand) {
    if (typeof broadcast !== 'function') return;
    broadcast({
      type: 'visions-hand', uri, hand, ts: nowFn(),
    });
  }

  function recordHand(uri, hand) {
    const next = typeof hand === 'string' && hand ? hand : null;
    const previous = handsByUri.get(uri) || null;
    if (previous === next) return;
    if (!next) handsByUri.delete(uri);
    if (next) handsByUri.set(uri, next);
    broadcastHand(uri, next);
  }

  function clearHand(uri) {
    recordHand(uri, null);
  }

  // Replaced wholesale by each sweep, like the findings they were derived from.
  function recordFixes(uri, fixes, textHash) {
    if (fixes.length === 0) {
      fixesByUri.delete(uri);
      return;
    }
    fixesByUri.set(uri, { fixes, textHash });
  }

  function claimUri(uri, connection) {
    if (!uri) return;
    const owners = openOwnersByUri.get(uri) || new Set();
    owners.add(connection);
    openOwnersByUri.set(uri, owners);
  }

  function releaseUri(uri, connection) {
    const owners = openOwnersByUri.get(uri);
    if (!owners) return true;
    owners.delete(connection);
    if (owners.size > 0) return false;
    openOwnersByUri.delete(uri);
    return true;
  }

  function clearUriState(uri) {
    dropDispatchDiagnostics(uri);
    clearFindings(uri);
    clearComments(uri);
    clearHand(uri);
    fixesByUri.delete(uri);
    forgetUri(dispatchState, uri);
    lastGateByUri.delete(uri);
  }

  /*
   * One changelog line per fix the lane touched. A refusal is logged exactly as loudly as a success and
   * is never retried: the fix stays on offer through the pull half, which is where a carbon unit who
   * wanted it asks for it.
   */
  function logFix(uri, fix, applied) {
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

  // Every uri the tab has a section for: findings, comments, or both.
  function documentsSnapshot() {
    const uris = new Set([...findingsByUri.keys(), ...commentsByUri.keys(), ...handsByUri.keys()]);
    return [...uris].map((uri) => ({
      uri,
      diagnostics: findingsByUri.get(uri) || [],
      comments: commentsByUri.get(uri) || [],
      hand: handsByUri.get(uri) || null,
    }));
  }

  function broadcastIntent(projectId) {
    if (typeof broadcast !== 'function') return;
    broadcast({
      type: 'visions-intent',
      projectId: projectId || null,
      intent: intentSlotPayload(intentSlotFor(intentState, projectId)),
      ts: nowFn(),
    });
  }

  function commitIntent(merged, projectId) {
    if (!merged.changed) return false;
    intentState = merged.state;
    if (intentStateWriter) {
      const payload = intentPayload(intentState);
      intentStateWriter.write(payload, () => JSON.stringify(payload, null, 2));
    }
    broadcastIntent(projectId);
    rememberIntent(intentSlotFor(intentState, projectId)?.text, projectTagFor(projectId, scopeProjects));
    return true;
  }

  function applyModelIntent(text, projectId = null) {
    const changed = commitIntent(mergeModelIntent(intentState, { text, now: nowFn(), projectId }), projectId);
    if (!changed) return false;
    const slot = intentSlotFor(intentState, projectId);
    note(`intent model-set for ${projectId || 'all projects'} (${(slot ? slot.text : '').length} chars)`);
    return true;
  }

  /*
   * What a finished dispatch is allowed to change. An ERROR (no result file, unparsable, unknown
   * verdict, timeout) leaves the standing comments exactly as they were: the lane says nothing rather
   * than inventing something or blanking a section because one session fell over.
   */
  function applyDispatchResult(uri, result, doc, send) {
    if (result.verdict === 'ERROR') {
      warn(`dispatch for ${uri} failed: ${result.reason || 'no reason given'}`);
      return false;
    }
    if (result.reason) note(`dispatch for ${uri}: ${result.reason}`);
    const modelUpdate = recordModelDiagnostics(uri, result, doc);
    const comments = result.verdict === 'COMMENTS' ? result.comments : [];
    const commentUpdate = recordComments(uri, comments, doc);
    if (modelUpdate.changed || commentUpdate.changed) {
      const merged = unionDiagnosticsFor(uri);
      publishDiagnosticsFrame(send, uri, merged);
      recordFindings(uri, merged);
    }
    const hand = handFromResult(result);
    recordHand(uri, hand);
    rememberRecords(dispatchMemoryInputs({
      uri, project: projectTagForUri(uri), comments, hand,
    }));
    return true;
  }

  /*
   * The ingest lane's digest, read once per dispatch and never on any other path. Synchronous by its own
   * contract, so it cannot describe two moments at once; a lane that throws costs this prompt its
   * context section and nothing else, because additive context must never fail a dispatch.
   */
  function readContextDigest() {
    if (typeof contextDigest !== 'function') return '';
    try {
      const digest = contextDigest({ scopes: null, budgetChars: digestBudgetChars, now: nowFn() });
      return typeof digest === 'string' ? digest : '';
    } catch (error) {
      warn(`context digest failed: ${error.message}`);
      return '';
    }
  }

  /*
   * Long-term memory for this dispatch (docs/plan-visions-3.md, M16): top-K lexically relevant records
   * for the ACTIVE project plus the global layer. Guarded exactly like the digest, so a store that
   * throws costs this prompt its memory section and never the dispatch. Every delivered line is
   * registered with the store, which is what lets the M14 consumer drop the same line coming back.
   */
  async function readMemorySection(uri, text) {
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
      // Counts and a version only: what was remembered is never what is logged.
      debugNote(() => `memory: ${lines.length} record(s) delivered for ${uri}`);
      return { text: body, count: lines.length, version: await readProjectionVersion(store) };
    } catch (error) {
      warn(`memory retrieval failed: ${String(error?.message || error)}`);
      return null;
    }
  }

  async function readProjectionVersion(store) {
    if (typeof store.readPublishedManifest !== 'function') return null;
    const manifest = await store.readPublishedManifest();
    return typeof manifest?.version === 'string' ? manifest.version : null;
  }

  /*
   * The same contract as the digest and read on the same path: once per dispatch, guarded, and a
   * provider that throws costs this dispatch its movement signal rather than the dispatch itself. Null
   * whenever no lane is wired, which is what makes every gate decision identical to the pre-M7.5 one.
   */
  function readContextSeq() {
    if (typeof contextSeq !== 'function') return null;
    try {
      const seq = contextSeq();
      return Number.isFinite(seq) ? seq : null;
    } catch (error) {
      warn(`context seq failed: ${error.message}`);
      return null;
    }
  }

  // The in-flight dispatch, so a test (and shutdown) can wait for the lane to go quiet.
  let dispatchSettled = Promise.resolve();

  // Connect-time repair for the control WS: one current-state frame, not a replay of superseded ones.
  function snapshotMessage() {
    const documents = documentsSnapshot();
    note(`snapshot served: ${documents.length} documents`);
    return {
      type: 'visions-snapshot', documents, intent: intentPayload(intentState), fixes: fixLog, ts: nowFn(),
    };
  }

  // One document store per connection: an editor's buffers die with the relay that mirrored them.
  function openConnection({ send }) {
    const store = createDocStore();
    const sweepTimersByUri = new Map();
    const dispatchTimersByUri = new Map();
    // applyEdit requests this relay owes an answer for, keyed by the id the lane minted for each.
    const pendingApplyEditById = new Map();
    let closed = false;

    function cancelSweep(uri) {
      const timer = sweepTimersByUri.get(uri);
      if (!timer) return;
      clearTimeoutFn(timer);
      sweepTimersByUri.delete(uri);
    }

    function cancelDispatch(uri) {
      const timer = dispatchTimersByUri.get(uri);
      if (!timer) return;
      clearTimeoutFn(timer);
      dispatchTimersByUri.delete(uri);
    }

    /**
     * One dispatch attempt, already at a pause boundary. Every remaining question (has the buffer
     * moved, is the cooldown up, is the hourly budget spent, is one already running) belongs to the
     * pure gate, and a refusal costs exactly one log line naming the gate that held. `armedBy` says
     * which boundary opened this window, and the gate uses it only to classify a buffer it has no
     * recorded hash for.
     */
    async function runDispatch(uri, armedBy = 'edit') {
      if (!dispatchEnabled || closed) return;
      const doc = getDoc(store, uri);
      if (!isMarkdownDoc(doc)) return;
      const text = typeof doc.text === 'string' ? doc.text : '';
      const textHash = hashFn(text);
      const projectId = projectForUri(uri, scopeProjects);
      const seq = readContextSeq();
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
      });
      if (!decision.dispatch) {
        noteGate(uri, decision);
        return;
      }
      const documentSizeDecision = decidePromptSize(text, decision.trigger);
      if (!documentSizeDecision.dispatch) {
        noteGate(uri, documentSizeDecision);
        return;
      }
      dispatchInFlight = true;
      let result = null;
      try {
        const memory = memoryStoreOf() ? await readMemorySection(uri, text) : null;
        const digest = readContextDigest();
        const prompt = buildPrompt({
          uri,
          text,
          findings: findingsByUri.get(uri) || [],
          intent: intentTextFor(intentState, projectId),
          digest,
          memory,
        });
        const sizeDecision = decidePromptSize(prompt, decision.trigger);
        if (!sizeDecision.dispatch) {
          noteGate(uri, sizeDecision);
          return;
        }
        lastGateByUri.delete(uri);
        recordDispatch(dispatchState, {
          uri, textHash, now: nowFn(), contextSeq: seq, trigger: decision.trigger,
        });
        result = await dispatch({
          uri,
          text,
          findings: findingsByUri.get(uri) || [],
          intent: intentTextFor(intentState, projectId),
          digest,
          memory,
          prompt,
        });
      } catch (error) {
        warn(`dispatch for ${uri} threw: ${error.message}`);
      } finally {
        dispatchInFlight = false;
      }
      if (!result) return;
      const currentDoc = getDoc(store, uri);
      if (closed || !currentDoc) {
        note(`dropped a dispatch result for ${uri}: the buffer is gone`);
        return;
      }
      if (hashFn(currentDoc.text) !== textHash) {
        note(`dropped a dispatch result for ${uri}: the buffer moved`);
        return;
      }
      const recorded = applyDispatchResult(uri, result, currentDoc, send);
      if (!recorded) return;
      const intentMoved = applyModelIntent(result.intent, projectId);
      note(`dispatch for ${uri} applied: ${result.verdict}, ${(commentsByUri.get(uri) || []).length} comments, hand=${handsByUri.has(uri) ? 'yes' : 'no'}, intent-moved=${intentMoved ? 'yes' : 'no'}`);
    }

    function armDispatch(uri, armedBy) {
      if (!dispatchEnabled || closed || !uri) return;
      cancelDispatch(uri);
      const timer = setTimeoutFn(() => {
        dispatchTimersByUri.delete(uri);
        if (closed) return;
        dispatchSettled = runDispatch(uri, armedBy).catch((error) => warn(`dispatch loop failed: ${error.message}`));
      }, dispatchSettings.quietMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
      dispatchTimersByUri.set(uri, timer);
      // Debug only: a busy machine re-arms this as often as it moves.
      debugNote(() => `dispatch armed for ${uri} by ${armedBy} in ${dispatchSettings.quietMs}ms`);
    }

    // Typing pushes an armed quiet window out and never opens one, because a document with no published
    // sweep behind it has nothing to react to yet; noteActivity below is the only other armer.
    function rearmDispatch(uri) {
      if (!dispatchTimersByUri.has(uri)) return;
      armDispatch(uri, 'edit');
    }

    /*
     * Machine activity reached the lane (docs/plan-ingestion.md, M7.5). It ARMS an idle document and
     * never touches an armed one: a continuous stream of activity that kept pushing the window out would
     * starve dispatch forever, which is the opposite of what the poke exists for. A window this arms
     * that races a dispatch is simply refused by the gate, at the cost of one log line.
     */
    function noteActivity() {
      if (!dispatchEnabled || closed) return;
      for (const doc of listDocs(store)) {
        if (!isMarkdownDoc(doc)) continue;
        if (dispatchTimersByUri.has(doc.uri)) continue;
        armDispatch(doc.uri, 'activity');
      }
    }

    function sendResponse(id, result) {
      try {
        send({ type: 'lsp-response', id, result });
      } catch (error) {
        warn(`could not answer request ${id}: ${error.message}`);
      }
    }

    /*
     * The pull half never re-sweeps: it filters what the last sweep of this buffer already computed, and
     * offers nothing at all once the stored hash stops describing the mirrored text.
     */
    function codeActionsFor(params) {
      const uri = params?.textDocument?.uri;
      if (typeof uri !== 'string' || !uri) return [];
      const doc = getDoc(store, uri);
      if (!doc) return [];
      const entry = fixesByUri.get(uri);
      if (!isFixSetFresh(entry, hashFn(doc.text))) return [];
      const offered = filterFixesByRange(entry.fixes, params?.range);
      rememberServedFindings(uri, offered, doc.version);
      return buildCodeActions(offered, { uri, version: doc.version });
    }

    // Answered, never dropped: the relay times an unanswered request out and the editor pays that wait.
    function handleRequestFrame(frame) {
      if (frame.method !== CODE_ACTION_METHOD) {
        sendResponse(frame.id, null);
        return;
      }
      sendResponse(frame.id, codeActionsFor(frame.params));
    }

    function settleApplyEdit(id, result, reason) {
      if (!pendingApplyEditById.has(id)) return;
      const pending = pendingApplyEditById.get(id);
      pendingApplyEditById.delete(id);
      if (pending.timer) clearTimeoutFn(pending.timer);
      const applied = !!result && result.applied === true;
      for (const fix of pending.fixes) logFix(pending.uri, fix, applied);
      if (applied) note(`auto-fixed ${pending.uri}: ${pending.fixes.length} edits applied`);
      if (!applied) note(`auto-fix refused for ${pending.uri}: ${reason}`);
    }

    function handleResponseFrame(frame) {
      settleApplyEdit(frame.id, frame.result, 'the editor refused the edit');
    }

    function failPendingApplyEdits(reason, uri = null) {
      for (const id of [...pendingApplyEditById.keys()]) {
        const pending = pendingApplyEditById.get(id);
        if (uri && pending.uri !== uri) continue;
        settleApplyEdit(id, { applied: false }, reason);
      }
    }

    /*
     * The push half, gated on autoFix. One request per sweep carrying that sweep's auto-safe edits as one
     * versioned WorkspaceEdit, so an edit racing a keystroke is refused by the editor rather than landing
     * on moved text, and a refusal costs one changelog line rather than a retry.
     */
    function requestAutoFix(uri, doc) {
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
        settleApplyEdit(id, { applied: false }, `the frame could not be sent (${error.message})`);
      }
    }

    /*
     * `armedBy` is also what decides how loudly the sweep is reported. A debounced sweep runs at typing
     * cadence, so it is debug-gated exactly like the didChange line that drives it; a save is
     * operator-paced, so that one stays the always-visible marker.
     */
    function publishDiagnostics(uri, armedBy = 'edit') {
      const doc = getDoc(store, uri);
      if (!isMarkdownDoc(doc)) return;
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
      // A published sweep is the pause boundary tier 3 waits behind; the quiet window starts here.
      armDispatch(uri, 'edit');
    }

    function scheduleSweep(uri) {
      if (closed || !uri) return;
      // Non-markdown documents are mirrored but never swept in v1, so they arm no timer either.
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

    const handlersByMethod = {
      'textDocument/didOpen': (params) => {
        const result = applyDidOpen(store, params);
        if (!result.applied) return result.reason;
        const uri = uriOfParams(params);
        claimUri(uri, connection);
        const doc = uri ? getDoc(store, uri) : null;
        if (doc) note(`didOpen ${uri} (${doc.text.length} chars, ${listDocs(store).length} open)`);
        scheduleSweep(uri);
        return null;
      },
      'textDocument/didChange': (params) => {
        const uri = uriOfParams(params);
        const version = params?.textDocument?.version;
        const previousDoc = uri ? getDoc(store, uri) : null;
        const result = applyDidChange(store, params);
        if (!result.applied) return changeFailureReason(uri, version, result);
        const doc = uri ? getDoc(store, uri) : null;
        dropDispatchDiagnostics(uri);
        // Debug only: this fires once per keystroke burst on every open buffer.
        debugNote(() => `didChange ${uri} v${version} (${result.changeCount} changes, ${result.size} chars)`);
        scheduleSweep(uri);
        if (!isMarkdownDoc(doc)) return null;
        if (!detectBlankLineBoundary({
          previousText: previousDoc.text,
          nextText: doc.text,
          changes: params?.contentChanges,
        })) return null;
        cancelDispatch(uri);
        dispatchSettled = runDispatch(uri, 'edit').catch((error) => warn(`dispatch loop failed: ${error.message}`));
        return null;
      },
      // A save IS a pause boundary, so it sweeps without waiting out the quiet window.
      'textDocument/didSave': (params) => {
        const uri = uriOfParams(params);
        if (!uri) return 'invalid-params';
        cancelSweep(uri);
        publishDiagnostics(uri, 'save');
        // A save is the boundary itself: it evaluates the same gate now rather than waiting it out.
        cancelDispatch(uri);
        dispatchSettled = runDispatch(uri, 'edit').catch((error) => warn(`dispatch loop failed: ${error.message}`));
        return null;
      },
      // The one editor-driven refusal signal there is; absent it, a served finding is simply unlabeled.
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
      // The carbon unit closed the buffer, so its findings are gone rather than merely unrefreshed.
      'textDocument/didClose': (params) => {
        const uri = uriOfParams(params);
        cancelSweep(uri);
        cancelDispatch(uri);
        const result = applyDidClose(store, params);
        const isLastOwner = releaseUri(uri, connection);
        if (!result.applied) return result.reason;
        note(`didClose ${uri} (${listDocs(store).length} open)`);
        failPendingApplyEdits('the buffer closed', uri);
        if (!isLastOwner) return null;
        clearUriState(uri);
        return null;
      },
    };

    function handleFrame(raw) {
      if (closed) return;
      const frame = readFrame(raw);
      if (!frame.ok) {
        warn(`dropped a frame: ${frame.reason}`);
        return;
      }
      if (frame.type === 'lsp-request') return handleRequestFrame(frame);
      if (frame.type === 'lsp-response') return handleResponseFrame(frame);
      const handler = handlersByMethod[frame.method];
      // Every other LSP notification (initialize, workspace events) is simply not part of v1.
      if (!handler) return;
      const reason = handler(frame.params);
      if (!reason) return;
      warn(`ignored ${frame.method}: ${reason}`);
    }

    // Findings deliberately survive a dropped relay: the shim replays its open buffers on reconnect, so
    // wiping the tab here would blank it for the length of a Vite restart and then refill it unchanged.
    function close() {
      if (closed) return;
      closed = true;
      for (const timer of sweepTimersByUri.values()) clearTimeoutFn(timer);
      sweepTimersByUri.clear();
      for (const timer of dispatchTimersByUri.values()) clearTimeoutFn(timer);
      dispatchTimersByUri.clear();
      failPendingApplyEdits('the relay disconnected');
      const dropped = listDocs(store);
      for (const doc of dropped) {
        applyDidClose(store, { textDocument: { uri: doc.uri } });
        if (releaseUri(doc.uri, connection)) clearUriState(doc.uri);
      }
      connections.delete(connection);
      note(`connection closed: ${dropped.length} mirrored documents dropped, ${connections.size} connections remain`);
    }

    const connection = {
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

  function attach(ws) {
    const connection = openConnection({
      send: (message) => {
        if (ws.readyState !== 1) return;
        ws.send(JSON.stringify(message));
      },
    });
    ws.on('message', (data) => handleSocketData(connection, data));
    ws.on('error', (error) => warn(`socket error: ${error.message}`));
    ws.on('close', () => connection.close());
    return connection;
  }

  // Catch frame handler faults before they reach the ws message emitter.
  function handleSocketData(connection, data) {
    try {
      connection.handleFrame(data.toString());
    } catch (error) {
      warn(`frame handling failed: ${error.message}`);
    }
  }

  /*
   * The ingest lane's poke: the machine moved, so every open markdown buffer gets the same quiet window
   * an edit would have armed. Nothing dispatches here; the gate still decides when the window expires,
   * and a lane with dispatch off does nothing at all.
   */
  function noteActivity() {
    if (!dispatchEnabled) return;
    for (const connection of connections) connection.noteActivity();
  }

  wss.on('connection', (ws) => { attach(ws); });

  function handleUpgrade(req, socket, head) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  }

  // Close detached upgraded sockets so shutdown can exit.
  function stop() {
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
    getIntent: () => intentPayload(intentState),
    getIntentFor: (projectId = null) => intentSlotPayload(intentSlotFor(intentState, projectId)),
    whenIntentPersistenceIdle: () => (intentStateWriter ? intentStateWriter.idle() : Promise.resolve()),
    // Settles once every queued memory write has landed, which is how a test waits for the writers.
    whenMemoryIdle: () => memoryChain,
    // The movement signal the next gate will read, so a caller can see whether a lane is wired at all.
    latestContextSeq: readContextSeq,
    // Settles once the in-flight dispatch has been applied, which is how a test waits for the lane.
    whenDispatchSettled: () => Promise.resolve(dispatchSettled),
    get connectionCount() { return connections.size; },
    get dispatchEnabled() { return dispatchEnabled; },
  };
}

module.exports = {
  createVisionsWiring,
  isMarkdownDoc,
  readFrame,
  APPLY_EDIT_TIMEOUT_MS,
  DIGEST_BUDGET_CHARS,
  VISIONS_DEBOUNCE_MS,
};
