import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import type { ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Readable } from 'node:stream';
import {
  createParserState,
  feedFrameBytes,
  serializeFrame,
} from '../server/core/visions-lsp-core.ts';
import {
  CODE_ACTION_TIMEOUT_MS, SYNC_KIND_INCREMENTAL, readConfiguredPort, resolvePortPlan, sendWsFrame, sendWsJson,
} from '../session/visions-relay.ts';
const RELAY_PATH = path.join(import.meta.dirname, '..', 'session', 'visions-relay.ts');
const TEST_TIMEOUT_MS = 6000;

// Every LSP/daemon frame this file reads back is asserted field by field, so one indexable shape covers them.
type LspRecord = Record<string, unknown>;

interface RelayScenario {
  daemon: Awaited<ReturnType<typeof startDaemon>>;
  initialSocket: WebSocket;
  relay: ReturnType<typeof startRelay>;
  restartDaemon: () => Promise<Awaited<ReturnType<typeof startDaemon>>>;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createDeferredQueue<T>() {
  const values: T[] = [];
  const waiters: ((value: T) => void)[] = [];
  return {
    push(value: T) {
      const waiter = waiters.shift();
      if (waiter) return waiter(value);
      values.push(value);
      return undefined;
    },
    next(label = 'timed out waiting for value'): Promise<T> {
      const value = values.shift();
      if (value) return Promise.resolve(value);
      return withTimeout(new Promise<T>((resolve) => { waiters.push(resolve); }), TEST_TIMEOUT_MS, label);
    },
    get size() { return values.length; },
  };
}

async function startDaemon(port = 0) {
  const messages = createDeferredQueue<LspRecord>();
  const connections = createDeferredQueue<WebSocket>();
  const server = new WebSocketServer({ host: '127.0.0.1', port });
  await once(server, 'listening');

  server.on('connection', (socket) => {
    connections.push(socket);
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      messages.push(JSON.parse(data.toString('utf8')) as LspRecord);
    });
  });

  return {
    server,
    messages,
    connections,
    port: (server.address() as AddressInfo).port,
    close() {
      for (const client of server.clients) {
        client.close();
      }
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function startRelay(port: number) {
  const child = spawn(process.execPath, [RELAY_PATH, '--port', String(port)], {
    cwd: path.join(import.meta.dirname, '..'),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stdoutMessages = createDeferredQueue<LspRecord>();
  let parserState = createParserState();

  child.stdout?.on('data', (chunk: Buffer) => {
    const parsed = feedFrameBytes(parserState, chunk);
    parserState = parsed.state;
    for (const message of parsed.messages) {
      stdoutMessages.push(message as LspRecord);
    }
  });

  return { child, stdoutMessages };
}

function writeLsp(child: ChildProcess, message: unknown) {
  child.stdin?.write(serializeFrame(message));
}

function writeLspAsync(child: ChildProcess, message: unknown) {
  return new Promise<void>((resolve, reject) => {
    child.stdin?.write(serializeFrame(message), (error) => {
      if (error) return reject(error);
      resolve();
    });
  });
}

function waitForStreamPattern(stream: Readable, pattern: RegExp) {
  let output = '';
  return withTimeout(new Promise<string>((resolve) => {
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (!pattern.test(output)) return;
      stream.off('data', onData);
      resolve(output);
    };
    stream.on('data', onData);
  }), TEST_TIMEOUT_MS, `stream output did not match ${pattern}`);
}

test('sendWsJson routes through the shared websocket frame guard', () => {
  const sent: string[] = [];
  const openSocket = { readyState: WebSocket.OPEN, send: (frame: string) => { sent.push(frame); } };

  assert.equal(sendWsJson(openSocket, { type: 'lsp', method: 'textDocument/didSave' }), true);
  assert.deepEqual(sent, ['{"type":"lsp","method":"textDocument/didSave"}']);
  assert.equal(sendWsFrame({ readyState: WebSocket.CLOSED, send: () => { throw new Error('must not send'); } }, { send: true, serialized: 'ignored' }), false);
});

async function closeRelay(child: ChildProcess) {
  if (child.exitCode !== null) return child.exitCode;
  child.kill();
  const [code] = await once(child, 'exit');
  return code;
}

async function runRelayScenario(fn: (scenario: RelayScenario) => Promise<void>) {
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

test('a refused didChange closes its mirror and a later shrink reopens the full document', async () => {
  await runRelayScenario(async ({ daemon, relay }) => {
    const uri = 'file:///resync.md';
    writeLsp(relay.child, {
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: { uri, languageId: 'markdown', version: 1, text: 'small' },
      },
    });
    await daemon.messages.next('initial didOpen missing');

    await writeLspAsync(relay.child, {
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri, version: 2 },
        contentChanges: [{ text: 'x'.repeat(2 * 1024 * 1024) }],
      },
    });
    const close = await daemon.messages.next('didClose after refused didChange missing');
    assert.deepEqual(close, {
      type: 'lsp', method: 'textDocument/didClose', params: { textDocument: { uri } },
    });

    writeLsp(relay.child, {
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri, version: 3 },
        contentChanges: [{
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          text: 'y',
        }],
      },
    });
    writeLsp(relay.child, {
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri, version: 4 },
        contentChanges: [{ text: 'small again' }],
      },
    });

    const reopen = await daemon.messages.next('full didOpen after shrink missing');
    assert.deepEqual(reopen, {
      type: 'lsp',
      method: 'textDocument/didOpen',
      params: {
        textDocument: { uri, languageId: 'markdown', version: 4, text: 'small again' },
      },
    });
    assert.equal(daemon.messages.size, 0);
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

test('an over-cap mirrored document is not transmitted and does not reconnect-loop', async () => {
  await runRelayScenario(async ({ daemon, relay }) => {
    const oversizedText = 'x'.repeat(2 * 1024 * 1024);
    await writeLspAsync(relay.child, {
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri: 'file:///oversized.md', languageId: 'markdown', version: 1, text: oversizedText,
        },
      },
    });
    const close = await daemon.messages.next('didClose after refused didOpen missing');
    assert.deepEqual(close, {
      type: 'lsp',
      method: 'textDocument/didClose',
      params: { textDocument: { uri: 'file:///oversized.md' } },
    });
    await new Promise((resolve) => { setTimeout(resolve, 750); });

    assert.equal(daemon.messages.size, 0);
    assert.equal(daemon.connections.size, 0);
    assert.equal(daemon.server.clients.size, 1);
    assert.equal(relay.child.exitCode, null);
  });
});

test('short-lived connections back off instead of resetting the retry delay on open', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  server.on('connection', (socket) => socket.close());
  const relay = startRelay((server.address() as AddressInfo).port);

  try {
    const output = await waitForStreamPattern(relay.child.stderr as Readable, /reconnecting in 500ms[\s\S]*reconnecting in 1000ms/);
    assert.match(output, /reconnecting in 500ms/);
    assert.match(output, /reconnecting in 1000ms/);
  } finally {
    await closeRelay(relay.child);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('unknown request returns MethodNotFound', async () => {
  await runRelayScenario(async ({ relay }) => {
    writeLsp(relay.child, { jsonrpc: '2.0', id: 77, method: 'workspace/symbol', params: {} });
    const response = await relay.stdoutMessages.next('unknown request response missing');
    assert.equal(response.id, 77);
    const error = response.error as LspRecord;
    assert.equal(error.code, -32601);
    assert.equal(error.message, 'Method not found');
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

test('an over-cap applyEdit response still reaches the daemon', async () => {
  await runRelayScenario(async ({ daemon, initialSocket, relay }) => {
    initialSocket.send(JSON.stringify({
      type: 'lsp-request', id: 'visions-fix-large', method: 'workspace/applyEdit', params: { edit: {} },
    }));
    const request = await relay.stdoutMessages.next('applyEdit not forwarded to the editor');
    const oversizedDetail = 'x'.repeat(2 * 1024 * 1024);

    await writeLspAsync(relay.child, {
      jsonrpc: '2.0', id: request.id, result: { applied: true, oversizedDetail },
    });

    const answer = await daemon.messages.next('large applyEdit answer not routed back');
    assert.deepEqual(answer, {
      type: 'lsp-response', id: 'visions-fix-large', result: { applied: true, oversizedDetail },
    });
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

test('the port plan puts the daemon\'s configured port ahead of the defaults', () => {
  // An explicit flag or env is a fixed answer: the operator named the daemon, so nothing else is tried.
  assert.deepEqual(resolvePortPlan(['--port', '4100'], {}, 3000), { ports: [4100], isFixed: true });
  assert.deepEqual(resolvePortPlan([], { GLISSA_PORT: '4100' }, 3000), { ports: [4100], isFixed: true });

  // A configured port leads but does not exclude: a dev daemon answers on Vite's port with 3000 on disk.
  assert.deepEqual(resolvePortPlan([], {}, 4100), { ports: [4100, 5173, 3000], isFixed: false });
  assert.deepEqual(resolvePortPlan([], {}, 3000), { ports: [3000, 5173], isFixed: false });
  assert.deepEqual(resolvePortPlan([], {}, null), { ports: [5173, 3000], isFixed: false });
  assert.deepEqual(resolvePortPlan([], {}, 'not-a-port'), { ports: [5173, 3000], isFixed: false });
});

test('the configured port is read from the resolved config, never seeded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-relay-config-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ port: 4321, projects: [] }), 'utf8');
  try {
    assert.equal(readConfiguredPort({ GLISSA_CONFIG: configPath }), 4321);
    assert.equal(readConfiguredPort({ GLISSA_CONFIG: path.join(dir, 'missing.json') }), null);
    assert.equal(fs.existsSync(path.join(dir, 'missing.json')), false);

    fs.writeFileSync(configPath, '{ not json', 'utf8');
    assert.equal(readConfiguredPort({ GLISSA_CONFIG: configPath }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
