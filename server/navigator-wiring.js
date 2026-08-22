// Navigator lane IO shell. Design rationale lives in docs/archive/plan-navigator.md.

'use strict';

const { WebSocketServer } = require('ws');
const {
  applyDidChange, applyDidClose, applyDidOpen, createDocStore, formatRange, getDoc, listDocs, uriOfParams,
} = require('./core/navigator-buffer-core');
const {
  createDispatchState, decideDispatch, forgetUri, hashText, recordDispatch, resolveDispatchConfig,
} = require('./core/navigator-dispatch-core');
const {
  applyModelIntent: mergeModelIntent,
  applyOperatorIntent: mergeOperatorIntent,
  createIntentState,
  intentPayload,
} = require('./core/navigator-intent-core');
const { sweepMarkdownWithFixes } = require('./core/navigator-rules-core');
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
} = require('./core/navigator-fix-core');
const { createLaneLog } = require('./lane-log');

// Quiet window before a document is swept.
const NAVIGATOR_DEBOUNCE_MS = 300;
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

function createNavigatorWiring({
  debounceMs = NAVIGATOR_DEBOUNCE_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  nowFn = Date.now,
  sweep = sweepMarkdownWithFixes,
  maxPayload = MAX_FRAME_BYTES,
  // Tier 1 silent fixes (docs/plan-navigator-2.md, M6). The pull half is always on with the lane; this
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
  digestBudgetChars = DIGEST_BUDGET_CHARS,
  hashFn = hashText,
  // Per-keystroke chatter, off unless the operator turned debugMode on. Boolean or getter, and the
  // privacy rule every line here obeys lives with the helper in server/lane-log.js.
  debug = false,
} = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload });
  const connections = new Set();
  /*
   * Findings the Navigator tab is currently showing, keyed by uri and shared across relays: the tab is a
   * view of what is open in the editors, not of which socket mirrored it. A uri with no findings is
   * ABSENT rather than stored empty, so the map and the rendered sections always agree.
   */
  const findingsByUri = new Map();
  /*
   * Tier 3 model comments, keyed by uri beside the findings and on the same lifecycle: replaced whole
   * by each dispatch, cleared on didClose. Separate from findingsByUri because a document can have one
   * kind without the other, and the tab renders them as two different things.
   */
  const commentsByUri = new Map();
  const handsByUri = new Map();
  /*
   * Tier 1 fixes from the last sweep of each uri, stored WITH the text hash they were computed against.
   * A code action is offered only while that hash still describes the buffer, so a fix can never be
   * served against text the carbon unit has already moved on from.
   */
  const fixesByUri = new Map();
  // What the lane has actually touched, applied and refused alike: the tab's audit of tier 1.
  let fixLog = [];
  let nextApplyEditId = 1;
  /*
   * The intent model (docs/archive/plan-navigator.md, M5): ONE statement for the machine, not one per uri,
   * because it says what the carbon unit is building rather than what a buffer contains. In memory
   * only in v1, so a daemon restart starts from nothing.
   */
  let intentState = createIntentState();
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

  const { debugNote, note, warn } = createLaneLog({ prefix: '[navigator]', logger, debugFlag: debug });

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

  function broadcastFindings(uri, diagnostics) {
    if (typeof broadcast !== 'function') return;
    broadcast({ type: 'navigator-findings', uri, diagnostics, ts: nowFn() });
  }

  function recordFindings(uri, diagnostics) {
    const findings = Array.isArray(diagnostics) ? diagnostics : [];
    if (findings.length === 0) findingsByUri.delete(uri);
    if (findings.length > 0) findingsByUri.set(uri, findings);
    broadcastFindings(uri, findings);
  }

  // A uri the tab never had a section for needs no message telling it to forget one.
  function clearFindings(uri) {
    if (!findingsByUri.delete(uri)) return;
    broadcastFindings(uri, []);
  }

  function broadcastComments(uri, comments) {
    if (typeof broadcast !== 'function') return;
    broadcast({ type: 'navigator-comments', uri, comments, ts: nowFn() });
  }

  // Wholesale replacement, like a sweep's findings: a uri with no comments is absent, never stored empty.
  function recordComments(uri, comments) {
    const list = Array.isArray(comments) ? comments : [];
    if (list.length === 0) commentsByUri.delete(uri);
    if (list.length > 0) commentsByUri.set(uri, list);
    broadcastComments(uri, list);
  }

  function clearComments(uri) {
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
      type: 'navigator-hand', uri, hand, ts: nowFn(),
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
    if (typeof broadcast !== 'function') return;
    broadcast({
      type: 'navigator-fix', uri, fix: fixPayload(entry), ts: entry.ts,
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

  function broadcastIntent() {
    if (typeof broadcast !== 'function') return;
    broadcast({ type: 'navigator-intent', intent: intentPayload(intentState), ts: nowFn() });
  }

  // Every write goes through the pure merge, so the lock rule is enforced in one place and a merge
  // that changes nothing costs no broadcast.
  function commitIntent(merged) {
    if (!merged.changed) return false;
    intentState = merged.state;
    broadcastIntent();
    return true;
  }

  // A model's updated belief. The merge, not this caller, is what keeps it off a locked statement.
  function applyModelIntent(text) {
    const changed = commitIntent(mergeModelIntent(intentState, { text, now: nowFn() }));
    // The source and the size, never the sentence: a model-authored intent is derived from the buffer
    // and the digest, so logging it verbatim would put buffer content in the log by the back door.
    if (changed) note(`intent model-set (${(intentState.text || '').length} chars)`);
    return changed;
  }

  // The tab's correction. Empty text clears the statement and hands control back to the model.
  function setOperatorIntent(text) {
    const changed = commitIntent(mergeOperatorIntent(intentState, { text, now: nowFn() }));
    if (changed) note(`intent operator-set (${(intentState.text || '').length} chars)`);
    return changed;
  }

  /*
   * What a finished dispatch is allowed to change. An ERROR (no result file, unparsable, unknown
   * verdict, timeout) leaves the standing comments exactly as they were: the lane says nothing rather
   * than inventing something or blanking a section because one session fell over.
   */
  function applyDispatchResult(uri, result) {
    if (result.verdict === 'ERROR') {
      warn(`dispatch for ${uri} failed: ${result.reason || 'no reason given'}`);
      return false;
    }
    if (result.reason) note(`dispatch for ${uri}: ${result.reason}`);
    recordComments(uri, result.verdict === 'COMMENTS' ? result.comments : []);
    recordHand(uri, handFromResult(result));
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
      type: 'navigator-snapshot', documents, intent: intentPayload(intentState), fixes: fixLog, ts: nowFn(),
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
      const seq = readContextSeq();
      const decision = decideDispatch({
        state: dispatchState,
        uri,
        textHash,
        now: nowFn(),
        config: dispatchSettings,
        inFlight: dispatchInFlight,
        contextSeq: seq,
        armedBy,
      });
      if (!decision.dispatch) {
        noteGate(uri, decision);
        return;
      }
      lastGateByUri.delete(uri);
      // Recorded before the await, so the cooldown and the hourly budget count attempts, not successes.
      dispatchInFlight = true;
      recordDispatch(dispatchState, {
        uri, textHash, now: nowFn(), contextSeq: seq, trigger: decision.trigger,
      });
      let result = null;
      try {
        result = await dispatch({
          uri,
          text,
          findings: findingsByUri.get(uri) || [],
          intent: intentState.text,
          digest: readContextDigest(),
        });
      } catch (error) {
        warn(`dispatch for ${uri} threw: ${error.message}`);
      } finally {
        dispatchInFlight = false;
      }
      if (!result) return;
      // The buffer can close while a session is thinking; its comments died with it.
      if (closed || !getDoc(store, uri)) {
        note(`dropped a dispatch result for ${uri}: the buffer is gone`);
        return;
      }
      const recorded = applyDispatchResult(uri, result);
      // After the comments, and through the merge: a locked operator intent survives this untouched.
      const intentMoved = applyModelIntent(result.intent);
      if (!recorded) return;
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
      return buildCodeActions(filterFixesByRange(entry.fixes, params?.range), { uri, version: doc.version });
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
      const id = `navigator-fix-${nextApplyEditId}`;
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
      const { diagnostics, fixes } = readSweepResult(sweep(doc.text));
      try {
        send({ type: 'publishDiagnostics', params: { uri, diagnostics } });
      } catch (error) {
        warn(`could not publish diagnostics for ${uri}: ${error.message}`);
      }
      // Outside the try: the tab's state does not depend on the editor socket accepting the frame.
      recordFindings(uri, diagnostics);
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
        const doc = uri ? getDoc(store, uri) : null;
        if (doc) note(`didOpen ${uri} (${doc.text.length} chars, ${listDocs(store).length} open)`);
        scheduleSweep(uri);
        return null;
      },
      'textDocument/didChange': (params) => {
        const uri = uriOfParams(params);
        const version = params?.textDocument?.version;
        const result = applyDidChange(store, params);
        if (!result.applied) return changeFailureReason(uri, version, result);
        // Debug only: this fires once per keystroke burst on every open buffer.
        debugNote(() => `didChange ${uri} v${version} (${result.changeCount} changes, ${result.size} chars)`);
        scheduleSweep(uri);
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
      // The carbon unit closed the buffer, so its findings are gone rather than merely unrefreshed.
      'textDocument/didClose': (params) => {
        const uri = uriOfParams(params);
        cancelSweep(uri);
        cancelDispatch(uri);
        const result = applyDidClose(store, params);
        if (!result.applied) return result.reason;
        note(`didClose ${uri} (${listDocs(store).length} open)`);
        clearFindings(uri);
        clearComments(uri);
        clearHand(uri);
        fixesByUri.delete(uri);
        failPendingApplyEdits('the buffer closed', uri);
        forgetUri(dispatchState, uri);
        lastGateByUri.delete(uri);
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
      for (const doc of dropped) applyDidClose(store, { textDocument: { uri: doc.uri } });
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
    for (const client of wss.clients) client.close(1001, 'Navigator stopped');
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
    setOperatorIntent,
    noteActivity,
    getIntent: () => intentPayload(intentState),
    // The movement signal the next gate will read, so a caller can see whether a lane is wired at all.
    latestContextSeq: readContextSeq,
    // Settles once the in-flight dispatch has been applied, which is how a test waits for the lane.
    whenDispatchSettled: () => Promise.resolve(dispatchSettled),
    get connectionCount() { return connections.size; },
    get dispatchEnabled() { return dispatchEnabled; },
  };
}

module.exports = {
  createNavigatorWiring,
  isMarkdownDoc,
  readFrame,
  APPLY_EDIT_TIMEOUT_MS,
  DIGEST_BUDGET_CHARS,
  NAVIGATOR_DEBOUNCE_MS,
};
