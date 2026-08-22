'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const path = require('node:path');
const WebSocket = require('ws');

const {
  createParserState,
  feedFrameBytes,
  serializeFrame,
} = require('../server/core/visions-lsp-core');
const { CODE_ACTION_TIMEOUT_MS, SYNC_KIND_INCREMENTAL } = require('../session/visions-relay');

const RELAY_PATH = path.join(__dirname, '..', 'session', 'visions-relay.js');
const TEST_TIMEOUT_MS = 6000;

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createDeferredQueue() {
  const values = [];
  const waiters = [];
  return {
    push(value) {
      const waiter = waiters.shift();
      if (waiter) return waiter(value);
      values.push(value);
      return undefined;
    },
    next(label = 'timed out waiting for value') {
      const value = values.shift();
      if (value) return Promise.resolve(value);
      return withTimeout(new Promise((resolve) => waiters.push(resolve)), TEST_TIMEOUT_MS, label);
    },
  };
}

async function startDaemon(port = 0) {
  const messages = createDeferredQueue();
  const connections = createDeferredQueue();
  const server = new WebSocket.WebSocketServer({ host: '127.0.0.1', port });
  await once(server, 'listening');

  server.on('connection', (socket) => {
    connections.push(socket);
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      messages.push(JSON.parse(data.toString('utf8')));
    });
  });

  return {
    server,
    messages,
    connections,
    port: server.address().port,
    close() {
      for (const client of server.clients) {
        client.close();
      }
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

function startRelay(port) {
  const child = spawn(process.execPath, [RELAY_PATH, '--port', String(port)], {
    cwd: path.join(__dirname, '..'),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stdoutMessages = createDeferredQueue();
  let parserState = createParserState();

  child.stdout.on('data', (chunk) => {
    const parsed = feedFrameBytes(parserState, chunk);
    parserState = parsed.state;
    for (const message of parsed.messages) {
      stdoutMessages.push(message);
    }
  });

  return { child, stdoutMessages };
}

function writeLsp(child, message) {
  child.stdin.write(serializeFrame(message));
}

async function closeRelay(child) {
  if (child.exitCode !== null) return child.exitCode;
  child.kill();
  const [code] = await once(child, 'exit');
  return code;
}

async function runRelayScenario(fn) {
  let daemon = await startDaemon();
  const relay = startRelay(daemon.port);
  const initialSocket = await daemon.connections.next('relay did not connect to daemon');

  try {
    await fn({ daemon, initialSocket, relay, restartDaemon: async () => {
      await daemon.close();
      daemon = await startDaemon(daemon.port);
      return daemon;
    } });
  } finally {
    await closeRelay(relay.child);
    await daemon.close().catch(() => {});
  }
}

test('initialize handshake returns visions capabilities', async () => {
  await runRelayScenario(async ({ relay }) => {
    writeLsp(relay.child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const response = await relay.stdoutMessages.next('initialize response missing');
    assert.equal(response.id, 1);
    assert.deepEqual(response.result, {
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
    });
  });
});

test('didOpen and didChange are forwarded intact to the daemon', async () => {
  await runRelayScenario(async ({ daemon, relay }) => {
    const didOpenParams = {
      textDocument: {
        uri: 'file:///note.md',
        languageId: 'markdown',
        version: 1,
        text: 'alpha',
      },
    };
    const didChangeParams = {
      textDocument: {
        uri: 'file:///note.md',
        version: 2,
      },
      contentChanges: [{ text: 'alpha beta' }],
    };

    writeLsp(relay.child, { jsonrpc: '2.0', method: 'textDocument/didOpen', params: didOpenParams });
    const open = await daemon.messages.next('didOpen not forwarded');
    assert.deepEqual(open, { type: 'lsp', method: 'textDocument/didOpen', params: didOpenParams });

    writeLsp(relay.child, { jsonrpc: '2.0', method: 'textDocument/didChange', params: didChangeParams });
    const change = await daemon.messages.next('didChange not forwarded');
    assert.deepEqual(change, { type: 'lsp', method: 'textDocument/didChange', params: didChangeParams });
  });
});

test('publishDiagnostics from daemon is emitted as an LSP notification', async () => {
  await runRelayScenario(async ({ initialSocket, relay }) => {
    const params = {
      uri: 'file:///note.md',
      diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, message: 'Check this' }],
    };
    initialSocket.send(JSON.stringify({ type: 'publishDiagnostics', params }));

    const message = await relay.stdoutMessages.next('diagnostics notification missing');
    assert.deepEqual(message, {
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params,
    });
  });
});

test('reconnect replay sends current open document text', async () => {
  await runRelayScenario(async ({ daemon, relay, restartDaemon }) => {
    const didOpenParams = {
      textDocument: {
        uri: 'file:///replay.md',
        languageId: 'markdown',
        version: 1,
        text: 'before',
      },
    };
    writeLsp(relay.child, { jsonrpc: '2.0', method: 'textDocument/didOpen', params: didOpenParams });
    await daemon.messages.next('initial didOpen missing');

    const changedParams = {
      textDocument: {
        uri: 'file:///replay.md',
        version: 2,
      },
      contentChanges: [{ text: 'after daemon restart' }],
    };
    const restartedDaemonPromise = restartDaemon();
    writeLsp(relay.child, { jsonrpc: '2.0', method: 'textDocument/didChange', params: changedParams });
    daemon = await restartedDaemonPromise;
    await daemon.connections.next('relay did not reconnect');

    const replay = await daemon.messages.next('replay didOpen missing');
    assert.deepEqual(replay, {
      type: 'lsp',
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri: 'file:///replay.md',
          languageId: 'markdown',
          version: 2,
          text: 'after daemon restart',
        },
      },
    });
  });
});

test('unknown request returns MethodNotFound', async () => {
  await runRelayScenario(async ({ relay }) => {
    writeLsp(relay.child, { jsonrpc: '2.0', id: 77, method: 'workspace/symbol', params: {} });
    const response = await relay.stdoutMessages.next('unknown request response missing');
    assert.equal(response.id, 77);
    assert.equal(response.error.code, -32601);
    assert.equal(response.error.message, 'Method not found');
  });
});

// --- The request path in both directions (docs/archive/plan-navigator-2.md, M6) ---

const CODE_ACTION_PARAMS = {
  textDocument: { uri: 'file:///note.md' },
  range: { start: { line: 2, character: 12 }, end: { line: 2, character: 16 } },
  context: { diagnostics: [] },
};

test('a codeAction request reaches the daemon under the editor own id and its answer comes back', async () => {
  await runRelayScenario(async ({ daemon, initialSocket, relay }) => {
    writeLsp(relay.child, {
      jsonrpc: '2.0', id: 21, method: 'textDocument/codeAction', params: CODE_ACTION_PARAMS,
    });

    const forwarded = await daemon.messages.next('codeAction not forwarded');
    assert.deepEqual(forwarded, {
      type: 'lsp-request', id: 21, method: 'textDocument/codeAction', params: CODE_ACTION_PARAMS,
    });

    const actions = [{ title: 'Delete the repeated word', kind: 'quickfix' }];
    initialSocket.send(JSON.stringify({ type: 'lsp-response', id: 21, result: actions }));

    const response = await relay.stdoutMessages.next('codeAction response missing');
    assert.deepEqual(response, { jsonrpc: '2.0', id: 21, result: actions });
  });
});

test('a daemon that never answers costs the editor a short wait and then no actions', async () => {
  await runRelayScenario(async ({ daemon, relay }) => {
    writeLsp(relay.child, {
      jsonrpc: '2.0', id: 22, method: 'textDocument/codeAction', params: CODE_ACTION_PARAMS,
    });
    await daemon.messages.next('codeAction not forwarded');

    const startedAt = Date.now();
    const response = await relay.stdoutMessages.next('the timed out request was never answered');
    assert.deepEqual(response, { jsonrpc: '2.0', id: 22, result: null });
    assert.ok(Date.now() - startedAt >= CODE_ACTION_TIMEOUT_MS - 200, 'it waited for the daemon first');
  });
});

test('with the daemon socket down the answer is no actions rather than a hang', async () => {
  await runRelayScenario(async ({ daemon, relay }) => {
    await daemon.close();
    await new Promise((resolve) => { setTimeout(resolve, 150).unref(); });

    writeLsp(relay.child, {
      jsonrpc: '2.0', id: 23, method: 'textDocument/codeAction', params: CODE_ACTION_PARAMS,
    });
    const response = await relay.stdoutMessages.next('the disconnected request was never answered');
    assert.deepEqual(response, { jsonrpc: '2.0', id: 23, result: null });
  });
});

test('a daemon applyEdit is forwarded under a relay id and the editor answer routes back to the daemon id', async () => {
  await runRelayScenario(async ({ daemon, initialSocket, relay }) => {
    const params = {
      label: 'Visions: 1 silent fix',
      edit: {
        documentChanges: [{
          textDocument: { uri: 'file:///note.md', version: 4 },
          edits: [{ range: CODE_ACTION_PARAMS.range, newText: '' }],
        }],
      },
    };
    initialSocket.send(JSON.stringify({
      type: 'lsp-request', id: 'visions-fix-1', method: 'workspace/applyEdit', params,
    }));

    const request = await relay.stdoutMessages.next('applyEdit not forwarded to the editor');
    assert.equal(request.method, 'workspace/applyEdit');
    assert.deepEqual(request.params, params);
    assert.notEqual(request.id, 'visions-fix-1', 'the editor sees an id the relay minted');

    writeLsp(relay.child, { jsonrpc: '2.0', id: request.id, result: { applied: true } });
    const answer = await daemon.messages.next('applyEdit answer not routed back');
    assert.deepEqual(answer, { type: 'lsp-response', id: 'visions-fix-1', result: { applied: true } });
  });
});

test('an editor that errors on an applyEdit is reported to the daemon as a refusal', async () => {
  await runRelayScenario(async ({ daemon, initialSocket, relay }) => {
    initialSocket.send(JSON.stringify({
      type: 'lsp-request', id: 'visions-fix-9', method: 'workspace/applyEdit', params: { edit: {} },
    }));
    const request = await relay.stdoutMessages.next('applyEdit not forwarded to the editor');

    // A response for an id the relay never minted is consumed and dropped, not routed anywhere.
    writeLsp(relay.child, { jsonrpc: '2.0', id: 'not-a-relay-id', result: { applied: true } });
    writeLsp(relay.child, { jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'no' } });

    const answer = await daemon.messages.next('the refusal was never routed back');
    assert.deepEqual(answer, { type: 'lsp-response', id: 'visions-fix-9', result: { applied: false } });
  });
});

test('shutdown and exit terminate the relay cleanly', async () => {
  await runRelayScenario(async ({ relay }) => {
    writeLsp(relay.child, { jsonrpc: '2.0', id: 9, method: 'shutdown', params: null });
    const response = await relay.stdoutMessages.next('shutdown response missing');
    assert.deepEqual(response, { jsonrpc: '2.0', id: 9, result: null });

    writeLsp(relay.child, { jsonrpc: '2.0', method: 'exit' });
    const [code] = await withTimeout(once(relay.child, 'exit'), TEST_TIMEOUT_MS, 'relay did not exit');
    assert.equal(code, 0);
  });
});
