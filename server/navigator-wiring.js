// Navigator lane IO shell. Design rationale lives in docs/plan-navigator.md.

'use strict';

const { WebSocketServer } = require('ws');
const {
  applyDidChange, applyDidClose, applyDidOpen, createDocStore, getDoc, listDocs, uriOfParams,
} = require('./core/navigator-buffer-core');
const { sweepMarkdown } = require('./core/navigator-rules-core');

// Quiet window before a document is swept.
const NAVIGATOR_DEBOUNCE_MS = 300;
// Whole-document didChange frames can carry editor buffers up to the data WS cap.
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MARKDOWN_EXTENSIONS = ['.md', '.markdown'];

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
  sweep = sweepMarkdown,
  maxPayload = MAX_FRAME_BYTES,
  logger = console,
} = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload });
  const connections = new Set();

  function warn(message) {
    if (!logger || typeof logger.warn !== 'function') return;
    logger.warn(`[navigator] ${message}`);
  }

  // One document store per connection: an editor's buffers die with the relay that mirrored them.
  function openConnection({ send }) {
    const store = createDocStore();
    const sweepTimersByUri = new Map();
    let closed = false;

    function cancelSweep(uri) {
      const timer = sweepTimersByUri.get(uri);
      if (!timer) return;
      clearTimeoutFn(timer);
      sweepTimersByUri.delete(uri);
    }

    function publishDiagnostics(uri) {
      const doc = getDoc(store, uri);
      if (!isMarkdownDoc(doc)) return;
      try {
        send({ type: 'publishDiagnostics', params: { uri, diagnostics: sweep(doc.text) } });
      } catch (error) {
        warn(`could not publish diagnostics for ${uri}: ${error.message}`);
      }
    }

    function scheduleSweep(uri) {
      if (closed || !uri) return;
      // Non-markdown documents are mirrored but never swept in v1, so they arm no timer either.
      if (!isMarkdownDoc(getDoc(store, uri))) return;
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
        return null;
      },
      'textDocument/didClose': (params) => {
        cancelSweep(uriOfParams(params));
        const result = applyDidClose(store, params);
        if (!result.applied) return result.reason;
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

    function close() {
      if (closed) return;
      closed = true;
      for (const timer of sweepTimersByUri.values()) clearTimeoutFn(timer);
      sweepTimersByUri.clear();
      for (const doc of listDocs(store)) applyDidClose(store, { textDocument: { uri: doc.uri } });
      connections.delete(connection);
    }

    const connection = {
      handleFrame,
      close,
      get docCount() { return listDocs(store).length; },
      get pendingSweepCount() { return sweepTimersByUri.size; },
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
    get connectionCount() { return connections.size; },
  };
}

module.exports = {
  createNavigatorWiring,
  isMarkdownDoc,
  readFrame,
  NAVIGATOR_DEBOUNCE_MS,
};
