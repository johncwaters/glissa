'use strict';

const WebSocket = require('ws');

const {
  classifyMessage,
  createParserState,
  feedFrameBytes,
  serializeFrame,
} = require('../server/core/navigator-lsp-core');
const {
  applyDidChange,
  applyDidClose,
  applyDidOpen,
  createDocStore,
  listDocs,
} = require('../server/core/navigator-buffer-core');

const DEFAULT_PORTS = [5173, 3000];
const INITIAL_RETRY_MS = 500;
const MAX_RETRY_MS = 5000;
const METHOD_NOT_FOUND = -32601;
const MIRROR_METHODS = new Set(['textDocument/didOpen', 'textDocument/didChange', 'textDocument/didClose']);
const FORWARDED_METHODS = new Set([...MIRROR_METHODS, 'textDocument/didSave']);

function parsePortValue(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

function resolvePortPlan(argv = [], env = process.env) {
  const flagIndex = argv.indexOf('--port');
  const flagPort = flagIndex >= 0 ? parsePortValue(argv[flagIndex + 1]) : null;
  if (flagPort !== null) return { ports: [flagPort], isFixed: true };

  const envPort = parsePortValue(env.GLISSA_PORT);
  if (envPort !== null) return { ports: [envPort], isFixed: true };

  return { ports: DEFAULT_PORTS.slice(), isFixed: false };
}

function nextDelayMs(currentDelayMs) {
  return Math.min(currentDelayMs * 2, MAX_RETRY_MS);
}

function initializeResult() {
  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: 2,
      },
    },
    serverInfo: {
      name: 'glissa-navigator',
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

function daemonMessage(method, params) {
  return { type: 'lsp', method, params };
}

function uriOfParams(params) {
  const uri = params?.textDocument?.uri;
  return typeof uri === 'string' && uri !== '' ? uri : '<unknown>';
}

function replayDidOpenMessage(doc) {
  return daemonMessage('textDocument/didOpen', {
    textDocument: {
      uri: doc.uri,
      languageId: doc.languageId,
      version: doc.version,
      text: doc.text,
    },
  });
}

function sendWsJson(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(payload));
  return true;
}

function createRelay({
  argv = process.argv.slice(2),
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const portPlan = resolvePortPlan(argv, env);
  const docStore = createDocStore();
  let parserState = createParserState();
  let ws = null;
  let retryTimer = null;
  let retryMs = INITIAL_RETRY_MS;
  let nextPortIndex = 0;
  let isStopping = false;

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

  function scheduleReconnect() {
    if (isStopping || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, retryMs);
    retryTimer.unref?.();
    retryMs = nextDelayMs(retryMs);
  }

  function replayMirror() {
    for (const doc of listDocs(docStore)) {
      sendWsJson(ws, replayDidOpenMessage(doc));
    }
  }

  function connect() {
    if (isStopping) return;
    const port = currentPort();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/navigator`);
    ws = socket;

    socket.on('open', () => {
      if (ws !== socket) return;
      retryMs = INITIAL_RETRY_MS;
      replayMirror();
    });

    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      handleDaemonText(data.toString('utf8'));
    });

    socket.on('error', () => {});

    socket.on('close', () => {
      if (ws === socket) ws = null;
      scheduleReconnect();
    });
  }

  function stop(exitCode = 0) {
    if (isStopping) return;
    isStopping = true;
    clearRetryTimer();
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
    if (!msg || msg.type !== 'publishDiagnostics') return;
    writeEditorMessage(editorNotification('textDocument/publishDiagnostics', msg.params));
  }

  function updateMirror(method, params) {
    if (method === 'textDocument/didOpen') return applyDidOpen(docStore, params);
    if (method === 'textDocument/didChange') return applyDidChange(docStore, params);
    if (method === 'textDocument/didClose') return applyDidClose(docStore, params);
    return { applied: false, reason: 'not-buffer-method' };
  }

  function handleNotification(method, params) {
    if (MIRROR_METHODS.has(method)) {
      const mirrorUpdate = updateMirror(method, params);
      if (!mirrorUpdate.applied) stderr.write(`[navigator-relay] mirror update failed method=${method} uri=${uriOfParams(params)} reason=${mirrorUpdate.reason}\n`);
    }
    if (FORWARDED_METHODS.has(method)) return sendWsJson(ws, daemonMessage(method, params));
    if (method === 'exit') return stop(0);
    return false;
  }

  function handleRequest(id, method) {
    if (method === 'initialize') return writeEditorMessage(responseMessage(id, initializeResult()));
    if (method === 'shutdown') return writeEditorMessage(responseMessage(id, null));
    return writeEditorMessage(methodNotFoundResponse(id, method));
  }

  function handleEditorMessage(msg) {
    const classification = classifyMessage(msg);
    if (classification.kind === 'request') return handleRequest(classification.id, classification.method);
    if (classification.kind === 'notification') return handleNotification(classification.method, msg.params);
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
  createRelay,
  daemonMessage,
  initializeResult,
  methodNotFoundResponse,
  nextDelayMs,
  replayDidOpenMessage,
  resolvePortPlan,
};
