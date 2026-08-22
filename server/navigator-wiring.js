// Navigator lane IO shell. Design rationale lives in docs/plan-navigator.md.

'use strict';

const { WebSocketServer } = require('ws');
const {
  applyDidChange, applyDidClose, applyDidOpen, createDocStore, getDoc, listDocs, uriOfParams,
} = require('./core/navigator-buffer-core');
const {
  createDispatchState, decideDispatch, forgetUri, hashText, recordDispatch, resolveDispatchConfig,
} = require('./core/navigator-dispatch-core');
const { sweepMarkdown } = require('./core/navigator-rules-core');

// Quiet window before a document is swept.
const NAVIGATOR_DEBOUNCE_MS = 300;
// Whole-document didChange frames can carry editor buffers up to the data WS cap.
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MARKDOWN_EXTENSIONS = ['.md', '.markdown'];
// What one dispatch prompt will spend on recent activity, beside a buffer that can be far larger.
const DIGEST_BUDGET_CHARS = 2000;

function isMarkdownDoc(doc) {
  if (!doc) return false;
  if (doc.languageId === 'markdown') return true;
  const uri = typeof doc.uri === 'string' ? doc.uri.toLowerCase() : '';
  return MARKDOWN_EXTENSIONS.some((extension) => uri.endsWith(extension));
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
  if (parsed.type !== 'lsp') return { ok: false, reason: `unsupported frame type ${JSON.stringify(parsed.type)}` };
  if (typeof parsed.method !== 'string') return { ok: false, reason: 'missing method' };
  const params = parsed.params && typeof parsed.params === 'object' ? parsed.params : {};
  return { ok: true, method: parsed.method, params };
}

function createNavigatorWiring({
  debounceMs = NAVIGATOR_DEBOUNCE_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  nowFn = Date.now,
  sweep = sweepMarkdown,
  maxPayload = MAX_FRAME_BYTES,
  logger = console,
  broadcast = null,
  // Tier 3 model dispatch (docs/plan-navigator.md, M4). Absent config or no dispatch function means
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

  function warn(message) {
    if (!logger || typeof logger.warn !== 'function') return;
    logger.warn(`[navigator] ${message}`);
  }

  function note(message) {
    if (!logger || typeof logger.log !== 'function') return;
    logger.log(`[navigator] ${message}`);
  }

  // A refusal is news when the gate CHANGES; the same gate holding again is the steady state, and an
  // undeduped line would be one log entry per open document per quiet window, forever.
  function noteGate(uri, gate) {
    if (lastGateByUri.get(uri) === gate) return;
    lastGateByUri.set(uri, gate);
    note(`no dispatch for ${uri}: ${gate}`);
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

  // Every uri the tab has a section for: findings, comments, or both.
  function documentsSnapshot() {
    const uris = new Set([...findingsByUri.keys(), ...commentsByUri.keys()]);
    return [...uris].map((uri) => ({
      uri,
      diagnostics: findingsByUri.get(uri) || [],
      comments: commentsByUri.get(uri) || [],
    }));
  }

  /*
   * What a finished dispatch is allowed to change. An ERROR (no result file, unparsable, unknown
   * verdict, timeout) leaves the standing comments exactly as they were: the lane says nothing rather
   * than inventing something or blanking a section because one session fell over.
   */
  function applyDispatchResult(uri, result) {
    if (result.verdict === 'ERROR') {
      warn(`dispatch for ${uri} failed: ${result.reason || 'no reason given'}`);
      return;
    }
    if (result.reason) note(`dispatch for ${uri}: ${result.reason}`);
    recordComments(uri, result.verdict === 'COMMENTS' ? result.comments : []);
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
    return { type: 'navigator-snapshot', documents: documentsSnapshot(), ts: nowFn() };
  }

  // One document store per connection: an editor's buffers die with the relay that mirrored them.
  function openConnection({ send }) {
    const store = createDocStore();
    const sweepTimersByUri = new Map();
    const dispatchTimersByUri = new Map();
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
     * pure gate, and a refusal costs exactly one log line naming the gate that held.
     */
    async function runDispatch(uri) {
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
      });
      if (!decision.dispatch) {
        noteGate(uri, decision.gate);
        return;
      }
      lastGateByUri.delete(uri);
      // Recorded before the await, so the cooldown and the hourly budget count attempts, not successes.
      dispatchInFlight = true;
      recordDispatch(dispatchState, {
        uri, textHash, now: nowFn(), contextSeq: seq,
      });
      let result = null;
      try {
        result = await dispatch({
          uri,
          text,
          findings: findingsByUri.get(uri) || [],
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
      applyDispatchResult(uri, result);
    }

    function armDispatch(uri) {
      if (!dispatchEnabled || closed || !uri) return;
      cancelDispatch(uri);
      const timer = setTimeoutFn(() => {
        dispatchTimersByUri.delete(uri);
        if (closed) return;
        dispatchSettled = runDispatch(uri).catch((error) => warn(`dispatch loop failed: ${error.message}`));
      }, dispatchSettings.quietMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
      dispatchTimersByUri.set(uri, timer);
    }

    // Typing pushes an armed quiet window out and never opens one, because a document with no published
    // sweep behind it has nothing to react to yet; noteActivity below is the only other armer.
    function rearmDispatch(uri) {
      if (!dispatchTimersByUri.has(uri)) return;
      armDispatch(uri);
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
        armDispatch(doc.uri);
      }
    }

    function publishDiagnostics(uri) {
      const doc = getDoc(store, uri);
      if (!isMarkdownDoc(doc)) return;
      const diagnostics = sweep(doc.text);
      try {
        send({ type: 'publishDiagnostics', params: { uri, diagnostics } });
      } catch (error) {
        warn(`could not publish diagnostics for ${uri}: ${error.message}`);
      }
      // Outside the try: the tab's state does not depend on the editor socket accepting the frame.
      recordFindings(uri, diagnostics);
      // A published sweep is the pause boundary tier 3 waits behind; the quiet window starts here.
      armDispatch(uri);
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
        scheduleSweep(uriOfParams(params));
        return null;
      },
      'textDocument/didChange': (params) => {
        const result = applyDidChange(store, params);
        if (!result.applied) return result.reason;
        scheduleSweep(uriOfParams(params));
        return null;
      },
      // A save IS a pause boundary, so it sweeps without waiting out the quiet window.
      'textDocument/didSave': (params) => {
        const uri = uriOfParams(params);
        if (!uri) return 'invalid-params';
        cancelSweep(uri);
        publishDiagnostics(uri);
        // A save is the boundary itself: it evaluates the same gate now rather than waiting it out.
        cancelDispatch(uri);
        dispatchSettled = runDispatch(uri).catch((error) => warn(`dispatch loop failed: ${error.message}`));
        return null;
      },
      // The carbon unit closed the buffer, so its findings are gone rather than merely unrefreshed.
      'textDocument/didClose': (params) => {
        const uri = uriOfParams(params);
        cancelSweep(uri);
        cancelDispatch(uri);
        const result = applyDidClose(store, params);
        if (!result.applied) return result.reason;
        clearFindings(uri);
        clearComments(uri);
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
      for (const doc of listDocs(store)) applyDidClose(store, { textDocument: { uri: doc.uri } });
      connections.delete(connection);
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
    noteActivity,
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
  DIGEST_BUDGET_CHARS,
  NAVIGATOR_DEBOUNCE_MS,
};
