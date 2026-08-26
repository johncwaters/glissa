'use strict';

const fs = require('node:fs');
const path = require('node:path');

const WebSocket = require('ws');

const {
  classifyMessage,
  createParserState,
  feedFrameBytes,
  serializeFrame,
} = require('../server/core/visions-lsp-core');
const {
  applyDidChange,
  applyDidClose,
  applyDidOpen,
  createDocStore,
  formatRange,
  getDoc,
  listDocs,
  uriOfParams,
} = require('../server/core/visions-buffer-core');
const { decideConfigPath, glissaHomeDir } = require('../server/core/config-path-core');
const {
  MAX_DAEMON_FRAME_BYTES,
  daemonMessage,
  decideDaemonFrame,
  decideMirrorSync,
  planMirrorReplay,
  replayDidOpenMessage,
} = require('./core/visions-relay-core');

const DEFAULT_PORTS = [5173, 3000];
const INITIAL_RETRY_MS = 500;
const MAX_RETRY_MS = 5000;
const STABLE_CONNECTION_MS = 5000;
const METHOD_NOT_FOUND = -32601;
const MIRROR_METHODS = new Set(['textDocument/didOpen', 'textDocument/didChange', 'textDocument/didClose']);
const FORWARDED_METHODS = new Set([...MIRROR_METHODS, 'textDocument/didSave']);
// The one editor request the daemon answers. Everything else is still method-not-found.
const CODE_ACTION_METHOD = 'textDocument/codeAction';
// The one request the daemon initiates, which is what makes tier 1 silent (docs/archive/plan-navigator-2.md, M6).
const APPLY_EDIT_METHOD = 'workspace/applyEdit';
// A daemon that never answers must not hang the editor: past this the relay answers "no actions" itself.
const CODE_ACTION_TIMEOUT_MS = 2000;

function parsePortValue(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

// The configured port leads but the defaults stay behind it: a dev daemon answers on Vite's 5173 while
// its own config still says 3000.
function resolvePortPlan(argv = [], env = process.env, configPort = null) {
  const flagIndex = argv.indexOf('--port');
  const flagPort = flagIndex >= 0 ? parsePortValue(argv[flagIndex + 1]) : null;
  if (flagPort !== null) return { ports: [flagPort], isFixed: true };

  const envPort = parsePortValue(env.GLISSA_PORT);
  if (envPort !== null) return { ports: [envPort], isFixed: true };

  const configured = parsePortValue(configPort);
  if (configured === null) return { ports: DEFAULT_PORTS.slice(), isFixed: false };
  return { ports: [configured, ...DEFAULT_PORTS.filter((port) => port !== configured)], isFixed: false };
}

// Read-only: the relay runs inside somebody's editor and must never seed or rewrite the operator's config.
function readConfiguredPort(env = process.env, fsApi = fs) {
  const decided = decideConfigPath({
    env,
    homeDir: glissaHomeDir(),
    packageRoot: path.join(__dirname, '..'),
  }, (candidate) => {
    try {
      return fsApi.existsSync(candidate);
    } catch {
      return false;
    }
  });
  if (!decided.path) return null;
  try {
    return JSON.parse(fsApi.readFileSync(decided.path, 'utf8'))?.port ?? null;
  } catch {
    return null;
  }
}

function nextDelayMs(currentDelayMs) {
  return Math.min(currentDelayMs * 2, MAX_RETRY_MS);
}

// LSP TextDocumentSyncKind. Incremental is fewer bytes per keystroke on a large buffer, and the store
// still takes whole-text changes, so a client that only speaks Full sync keeps working unchanged.
const SYNC_KIND_INCREMENTAL = 2;

function initializeResult() {
  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: SYNC_KIND_INCREMENTAL,
      },
      codeActionProvider: true,
    },
    serverInfo: {
      name: 'glissa-visions',
    },
  };
}

function methodNotFoundResponse(id, method) {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: METHOD_NOT_FOUND,
      message: 'Method not found',
      data: { method },
    },
  };
}

function responseMessage(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function editorNotification(method, params) {
  return { jsonrpc: '2.0', method, params };
}

function daemonRequest(id, method, params) {
  return { type: 'lsp-request', id, method, params };
}

function daemonResponse(id, result) {
  return { type: 'lsp-response', id, result };
}

function editorRequest(id, method, params) {
  return { jsonrpc: '2.0', id, method, params };
}

// What a refused mirror update needs beside its reason to be diagnosable from one log line.
function mirrorFailureDetail(update) {
  if (update.reason === 'invalid-range' || update.reason === 'invalid-text') return ` change=${update.index} range=${formatRange(update.range)}`;
  if (update.reason === 'stale-version') return ` version=${update.version} current=${update.currentVersion}`;
  return '';
}

function sendWsFrame(ws, decision) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  if (!decision.send) return false;
  ws.send(decision.serialized);
  return true;
}

function sendWsJson(ws, payload) {
  return sendWsFrame(ws, { send: true, serialized: JSON.stringify(payload) });
}

function createRelay({
  argv = process.argv.slice(2),
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const portPlan = resolvePortPlan(argv, env, readConfiguredPort(env));
  const docStore = createDocStore();
  let parserState = createParserState();
  let ws = null;
  let retryTimer = null;
  let stableConnectionTimer = null;
  let retryMs = INITIAL_RETRY_MS;
  let nextPortIndex = 0;
  let isStopping = false;
  // Editor request id -> its expiry timer, for the codeAction requests the daemon is answering.
  const pendingCodeActionById = new Map();
  // Editor-facing id -> the daemon id it answers for, for the applyEdit direction.
  const applyEditDaemonIdByEditorId = new Map();
  const unsyncedUris = new Set();
  let nextEditorRequestId = 1;

  // stdout carries the LSP protocol, so every line the relay says about itself goes to stderr.
  function note(message) {
    stderr.write(`[visions-relay] ${message}\n`);
  }

  function writeEditorMessage(message) {
    stdout.write(serializeFrame(message));
  }

  function currentPort() {
    const port = portPlan.ports[nextPortIndex % portPlan.ports.length];
    nextPortIndex++;
    return port;
  }

  function clearRetryTimer() {
    if (!retryTimer) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  function clearStableConnectionTimer() {
    if (!stableConnectionTimer) return;
    clearTimeout(stableConnectionTimer);
    stableConnectionTimer = null;
  }

  function scheduleReconnect(port) {
    if (isStopping || retryTimer) return;
    note(`lost the daemon on port ${port}; reconnecting in ${retryMs}ms`);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, retryMs);
    retryTimer.unref?.();
    retryMs = nextDelayMs(retryMs);
  }

  function replayMirror() {
    const replay = planMirrorReplay(listDocs(docStore));
    for (const frame of replay.frames) {
      ws.send(frame.serialized);
      unsyncedUris.delete(frame.uri);
    }
    for (const skipped of replay.skipped) {
      sendWsJson(ws, daemonMessage('textDocument/didClose', { textDocument: { uri: skipped.uri } }));
      if (!unsyncedUris.has(skipped.uri)) {
        note(`mirror unsynced uri=${skipped.uri}: ${skipped.frameBytes} bytes exceeds ${MAX_DAEMON_FRAME_BYTES}`);
      }
      unsyncedUris.add(skipped.uri);
    }
    return replay;
  }

  function connect() {
    if (isStopping) return;
    const port = currentPort();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/visions`);
    ws = socket;

    socket.on('open', () => {
      if (ws !== socket) return;
      clearStableConnectionTimer();
      stableConnectionTimer = setTimeout(() => {
        if (ws !== socket) return;
        retryMs = INITIAL_RETRY_MS;
        stableConnectionTimer = null;
      }, STABLE_CONNECTION_MS);
      stableConnectionTimer.unref?.();
      const replay = replayMirror();
      note(`connected to the daemon on port ${port} (replayed ${replay.frames.length} mirrored documents, skipped ${replay.skipped.length})`);
    });

    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      handleDaemonText(data.toString('utf8'));
    });

    socket.on('error', () => {});

    socket.on('close', () => {
      if (ws === socket) ws = null;
      clearStableConnectionTimer();
      // A daemon that went away answers nothing, so the editor gets the "no actions" answer now.
      failPendingCodeActions();
      applyEditDaemonIdByEditorId.clear();
      scheduleReconnect(port);
    });
  }

  function settleCodeAction(id, result) {
    if (!pendingCodeActionById.has(id)) return false;
    const timer = pendingCodeActionById.get(id);
    pendingCodeActionById.delete(id);
    if (timer) clearTimeout(timer);
    writeEditorMessage(responseMessage(id, result));
    return true;
  }

  function failPendingCodeActions() {
    for (const id of [...pendingCodeActionById.keys()]) settleCodeAction(id, null);
  }

  // The editor's own id travels to the daemon and back, so this direction mints nothing.
  function forwardCodeAction(id, params) {
    if (!sendWsJson(ws, daemonRequest(id, CODE_ACTION_METHOD, params))) {
      writeEditorMessage(responseMessage(id, null));
      return;
    }
    const timer = setTimeout(() => settleCodeAction(id, null), CODE_ACTION_TIMEOUT_MS);
    timer.unref?.();
    pendingCodeActionById.set(id, timer);
  }

  // The other direction needs an id the editor has never seen, hence the one prefix the relay mints.
  function forwardApplyEdit(daemonId, params) {
    const editorId = `glissa-visions-${nextEditorRequestId}`;
    nextEditorRequestId += 1;
    applyEditDaemonIdByEditorId.set(editorId, daemonId);
    writeEditorMessage(editorRequest(editorId, APPLY_EDIT_METHOD, params));
  }

  // A client error answering an applyEdit is a refusal, which is exactly what the daemon logs it as.
  function handleEditorResponse(editorId, msg) {
    if (!applyEditDaemonIdByEditorId.has(editorId)) return;
    const daemonId = applyEditDaemonIdByEditorId.get(editorId);
    applyEditDaemonIdByEditorId.delete(editorId);
    sendWsJson(ws, daemonResponse(daemonId, msg.error ? { applied: false } : msg.result));
  }

  function stop(exitCode = 0) {
    if (isStopping) return;
    isStopping = true;
    note(`shutting down (exit ${exitCode})`);
    clearRetryTimer();
    clearStableConnectionTimer();
    stdin.pause();
    if (ws) ws.close();
    setImmediate(() => process.exit(exitCode));
  }

  function handleDaemonText(text) {
    let msg = null;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'publishDiagnostics') {
      writeEditorMessage(editorNotification('textDocument/publishDiagnostics', msg.params));
      return;
    }
    if (msg.type === 'lsp-response') {
      settleCodeAction(msg.id, msg.result);
      return;
    }
    if (msg.type === 'lsp-request' && msg.method === APPLY_EDIT_METHOD) forwardApplyEdit(msg.id, msg.params);
  }

  function updateMirror(method, params) {
    if (method === 'textDocument/didOpen') return applyDidOpen(docStore, params);
    if (method === 'textDocument/didChange') return applyDidChange(docStore, params);
    if (method === 'textDocument/didClose') return applyDidClose(docStore, params);
    return { applied: false, reason: 'not-buffer-method' };
  }

  function sendMirrorNotification(method, params, mirrorUpdate) {
    const uri = uriOfParams(params);
    const originalMessage = daemonMessage(method, params);
    if (!uri) return sendWsJson(ws, originalMessage);

    const isUnsynced = unsyncedUris.has(uri);
    if (!mirrorUpdate.applied && !isUnsynced) return sendWsJson(ws, originalMessage);
    if (!mirrorUpdate.applied && method === 'textDocument/didClose') {
      unsyncedUris.delete(uri);
      return false;
    }
    if (!mirrorUpdate.applied) return false;

    const originalFrame = decideDaemonFrame(originalMessage);
    const shouldCheckFullOpen = method !== 'textDocument/didClose' && (isUnsynced || !originalFrame.send);
    const doc = shouldCheckFullOpen ? getDoc(docStore, uri) : null;
    const fullOpenMessage = doc ? replayDidOpenMessage(doc) : null;
    const fullOpenFrame = fullOpenMessage ? decideDaemonFrame(fullOpenMessage) : null;
    const syncPlan = decideMirrorSync({
      method,
      isUnsynced,
      originalFrameFits: originalFrame.send,
      fullFrameFits: fullOpenFrame?.send === true,
    });

    if (syncPlan.markUnsynced) unsyncedUris.add(uri);
    if (syncPlan.shouldLog) {
      note(`mirror unsynced uri=${uri}: ${originalFrame.frameBytes} bytes exceeds ${MAX_DAEMON_FRAME_BYTES}`);
    }

    let didSend = false;
    for (const action of syncPlan.actions) {
      if (action === 'original') didSend = sendWsFrame(ws, originalFrame) || didSend;
      if (action === 'close') {
        const closeMessage = daemonMessage('textDocument/didClose', { textDocument: { uri } });
        didSend = sendWsJson(ws, closeMessage) || didSend;
      }
      if (action === 'full-open' && fullOpenFrame && sendWsFrame(ws, fullOpenFrame)) {
        unsyncedUris.delete(uri);
        didSend = true;
      }
    }
    if (syncPlan.forgetUnsynced) unsyncedUris.delete(uri);
    return didSend;
  }

  function handleNotification(method, params) {
    if (MIRROR_METHODS.has(method)) {
      const mirrorUpdate = updateMirror(method, params);
      if (!mirrorUpdate.applied) note(`mirror update failed method=${method} uri=${uriOfParams(params) || '<unknown>'} reason=${mirrorUpdate.reason}${mirrorFailureDetail(mirrorUpdate)}`);
      return sendMirrorNotification(method, params, mirrorUpdate);
    }
    if (FORWARDED_METHODS.has(method)) return sendWsJson(ws, daemonMessage(method, params));
    if (method === 'exit') return stop(0);
    return false;
  }

  function handleRequest(id, method, params) {
    if (method === CODE_ACTION_METHOD) return forwardCodeAction(id, params);
    if (method === 'initialize') {
      note(`initialize answered: textDocumentSync change=${SYNC_KIND_INCREMENTAL} (incremental)`);
      return writeEditorMessage(responseMessage(id, initializeResult()));
    }
    if (method === 'shutdown') {
      note('shutdown requested by the editor');
      return writeEditorMessage(responseMessage(id, null));
    }
    return writeEditorMessage(methodNotFoundResponse(id, method));
  }

  function handleEditorMessage(msg) {
    const classification = classifyMessage(msg);
    if (classification.kind === 'request') return handleRequest(classification.id, classification.method, msg.params);
    if (classification.kind === 'notification') return handleNotification(classification.method, msg.params);
    if (classification.kind === 'response') return handleEditorResponse(classification.id, msg);
    return undefined;
  }

  function handleStdinChunk(chunk) {
    const parsed = feedFrameBytes(parserState, Buffer.from(chunk));
    parserState = parsed.state;
    for (const msg of parsed.messages) {
      handleEditorMessage(msg);
    }
  }

  function start() {
    connect();
    stdin.on('data', handleStdinChunk);
    stdin.on('end', () => stop(0));
  }

  return {
    start,
    stop,
    handleEditorMessage,
    handleDaemonText,
    portPlan,
  };
}

function main() {
  createRelay().start();
}

if (require.main === module) {
  main();
}

module.exports = {
  APPLY_EDIT_METHOD,
  readConfiguredPort,
  CODE_ACTION_METHOD,
  CODE_ACTION_TIMEOUT_MS,
  MAX_DAEMON_FRAME_BYTES,
  STABLE_CONNECTION_MS,
  SYNC_KIND_INCREMENTAL,
  createRelay,
  daemonMessage,
  decideDaemonFrame,
  initializeResult,
  methodNotFoundResponse,
  nextDelayMs,
  planMirrorReplay,
  replayDidOpenMessage,
  resolvePortPlan,
  sendWsFrame,
  sendWsJson,
};
