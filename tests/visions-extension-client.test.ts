// End-to-end for the bundled editor extension: the real relay, a fake daemon, and the vscode stub the
// extension host would otherwise supply. The extension is the only Visions component the daemon's own
// tests never exercised, and it is the one that has to be right for a file edit to reach the lane.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';

import vscode from './helpers/vscode-stub.ts';
import { ACTIVITY_METHOD } from '../server/core/ingest-editor-core.ts';

const requireFromHere = createRequire(import.meta.url);

// The framing module is COPIED beside the extension when the vsix is packed (server/visions-setup.ts), so
// in the repo it resolves only from the one place that owns it.
const LSP_CORE_PATH = requireFromHere.resolve('../server/core/visions-lsp-core.ts');
const CONVERT_PATH = requireFromHere.resolve('../tools/vscode-visions/lsp-convert.ts');
const RELAY_PATH = path.join(import.meta.dirname, '..', 'session', 'visions-relay.ts');
const WAIT_MS = 8000;
const URI = 'file:///tmp/plan.md';

type ModuleLoad = (request: string, ...rest: unknown[]) => unknown;
type ModuleResolve = (request: string, ...rest: unknown[]) => string;

interface LoaderInternals {
  _load: ModuleLoad;
  _resolveFilename: ModuleResolve;
}

// The extension is authored CommonJS so the extension host can require it, so its surface is declared
// here rather than imported.
interface ExtensionModule {
  activate(context: { subscriptions: { dispose?: () => void }[] }): void;
  relayArgs(relayPath: string, port: number): string[];
}

interface DaemonMessage {
  type: string;
  method?: string;
  id?: unknown;
  result?: unknown;
  params?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asMessage(value: unknown): DaemonMessage {
  if (!isRecord(value) || typeof value.type !== 'string') throw new Error('the daemon received a frame with no type');
  const { type, method, id, result, params } = value;
  return {
    type,
    method: typeof method === 'string' ? method : undefined,
    id,
    result,
    params: isRecord(params) ? params : undefined,
  };
}

interface CodeActionProvider {
  provideCodeActions(
    document: unknown,
    range: unknown,
    context: { triggerKind: number },
  ): Promise<{ title: string }[]>;
}

function isCodeActionProvider(value: unknown): value is CodeActionProvider {
  return isRecord(value) && typeof value.provideCodeActions === 'function';
}

// A frame's params walked by path, so an assertion states the field it means in one line.
function paramAt(message: DaemonMessage, dottedPath: string): unknown {
  let cursor: unknown = message.params;
  for (const key of dottedPath.split('.')) {
    if (!isRecord(cursor) && !Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

// The stub is an ES module now, so a resolve-time redirect would hand the extension's CommonJS
// `require('vscode')` the namespace wrapper instead of the namespace itself. Intercepting the load is
// what puts the stub object in its hands.
const loader: LoaderInternals = requireFromHere('node:module');
const originalLoad = loader._load;
loader._load = function loadWithVscodeStub(this: unknown, request: string, ...rest: unknown[]): unknown {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, ...rest);
};

const originalResolve = loader._resolveFilename;
loader._resolveFilename = function resolveVisionsSources(this: unknown, request: string, ...rest: unknown[]): string {
  if (request === './visions-lsp-core.js') return LSP_CORE_PATH;
  if (request === './lsp-convert.js') return CONVERT_PATH;
  return originalResolve.call(this, request, ...rest);
};

const extension: ExtensionModule = requireFromHere('../tools/vscode-visions/extension.ts');

interface Waiter {
  matches: (message: DaemonMessage) => boolean;
  resolve: (message: DaemonMessage) => void;
}

function createDaemon() {
  const server = new WebSocketServer({ port: 0, path: '/visions' });
  const received: DaemonMessage[] = [];
  const waiters: Waiter[] = [];
  let socket: WebSocket | null = null;

  server.on('connection', (connection) => {
    socket = connection;
    connection.on('message', (data: Buffer) => {
      const message = asMessage(JSON.parse(data.toString('utf8')));
      const waiter = waiters.findIndex((entry) => entry.matches(message));
      if (waiter >= 0) {
        const [entry] = waiters.splice(waiter, 1);
        entry.resolve(message);
        return;
      }
      received.push(message);
    });
  });

  return {
    server,
    port: () => {
      const address = server.address();
      if (typeof address === 'string') throw new Error('the fake daemon bound a pipe, not a port');
      return address.port;
    },
    send: (payload: unknown) => {
      if (!socket) throw new Error('the extension never connected');
      socket.send(JSON.stringify(payload));
    },
    waitFor(matches: (message: DaemonMessage) => boolean, label: string): Promise<DaemonMessage> {
      const index = received.findIndex(matches);
      const hit = index >= 0 ? received.splice(index, 1)[0] : undefined;
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(label)), WAIT_MS);
        waiters.push({ matches, resolve: (message) => { clearTimeout(timer); resolve(message); } });
      });
    },
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

function isLsp(method: string) {
  return (message: DaemonMessage) => message.type === 'lsp' && message.method === method;
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(label);
}

test('the extension mirrors buffers to the daemon and renders what it sends back', async (t) => {
  const daemon = createDaemon();
  await once(daemon.server, 'listening');

  vscode.__test.reset();
  vscode.__test.state.settings = { relayPath: RELAY_PATH, port: daemon.port() };
  const context: { subscriptions: { dispose?: () => void }[] } = { subscriptions: [] };
  extension.activate(context);
  t.after(async () => {
    for (const subscription of context.subscriptions) subscription.dispose?.();
    await daemon.close();
  });

  const document = vscode.__test.document({ uri: URI, text: '# Plan\n\nthe the buffer\n', version: 1 });
  vscode.__test.state.documents = [document];
  vscode.__test.fire('open', document);

  const opened = await daemon.waitFor(isLsp('textDocument/didOpen'), 'no didOpen reached the daemon');
  assert.equal(paramAt(opened, 'textDocument.uri'), URI);
  assert.equal(paramAt(opened, 'textDocument.languageId'), 'markdown');
  assert.match(String(paramAt(opened, 'textDocument.text')), /the the buffer/);

  const edited = vscode.__test.document({ uri: URI, text: '# Plan\n\nthe buffer\n', version: 2 });
  vscode.__test.state.documents = [edited];
  vscode.__test.fire('change', { document: edited });

  const changed = await daemon.waitFor(isLsp('textDocument/didChange'), 'no didChange reached the daemon');
  assert.equal(paramAt(changed, 'textDocument.version'), 2);
  assert.equal(paramAt(changed, 'contentChanges.0.text'), '# Plan\n\nthe buffer\n');

  vscode.__test.fire('save', edited);
  await daemon.waitFor(isLsp('textDocument/didSave'), 'no didSave reached the daemon');

  daemon.send({
    type: 'publishDiagnostics',
    params: {
      uri: URI,
      diagnostics: [{
        range: { start: { line: 2, character: 0 }, end: { line: 2, character: 7 } },
        message: 'Repeated word',
        severity: 2,
        source: 'glissa-visions',
      }],
    },
  });
  await waitUntil(() => vscode.__test.state.diagnosticsByUri.has(URI), 'no diagnostics reached the editor');
  const published = vscode.__test.state.diagnosticsByUri.get(URI)?.[0];
  assert.ok(isRecord(published), 'a diagnostic reached the editor');
  assert.equal(published.message, 'Repeated word');

  const registered = vscode.__test.state.codeActionProviders[0]?.provider;
  assert.ok(isCodeActionProvider(registered), 'the extension registered a code action provider');
  const range = new vscode.Range(new vscode.Position(2, 0), new vscode.Position(2, 7));
  const actionsPromise = registered.provideCodeActions(edited, range, { triggerKind: 1 });
  const actionRequest = await daemon.waitFor((message) => message.type === 'lsp-request' && message.method === 'textDocument/codeAction', 'no codeAction request reached the daemon');
  daemon.send({
    type: 'lsp-response',
    id: actionRequest.id,
    result: [{
      title: 'Visions: remove repeated word',
      kind: 'quickfix',
      edit: { documentChanges: [{ textDocument: { uri: URI, version: 2 }, edits: [{ range: { start: { line: 2, character: 0 }, end: { line: 2, character: 4 } }, newText: '' }] }] },
    }],
  });
  const actions = await actionsPromise;
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.title, 'Visions: remove repeated word');

  daemon.send({
    type: 'lsp-request',
    id: 'lane-1',
    method: 'workspace/applyEdit',
    params: { label: 'Visions: 1 silent fix', edit: { documentChanges: [{ textDocument: { uri: URI, version: 2 }, edits: [{ range: { start: { line: 2, character: 0 }, end: { line: 2, character: 4 } }, newText: '' }] }] } },
  });
  const applied = await daemon.waitFor((message) => message.type === 'lsp-response' && message.id === 'lane-1', 'no applyEdit answer reached the daemon');
  assert.deepEqual(applied.result, { applied: true });
  assert.equal(vscode.__test.state.appliedEdits.length, 1);

  daemon.send({
    type: 'lsp-request',
    id: 'lane-2',
    method: 'workspace/applyEdit',
    params: { edit: { documentChanges: [{ textDocument: { uri: URI, version: 1 }, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'x' }] }] } },
  });
  const refused = await daemon.waitFor((message) => message.type === 'lsp-response' && message.id === 'lane-2', 'no applyEdit refusal reached the daemon');
  assert.deepEqual(refused.result, { applied: false });
  assert.equal(vscode.__test.state.appliedEdits.length, 1);

  vscode.__test.fire('close', edited);
  await daemon.waitFor(isLsp('textDocument/didClose'), 'no didClose reached the daemon');
  assert.equal(vscode.__test.state.diagnosticsByUri.has(URI), false);
});

test('a non-markdown buffer reports a marker instead of its text', async (t) => {
  const daemon = createDaemon();
  await once(daemon.server, 'listening');

  vscode.__test.reset();
  vscode.__test.state.settings = { relayPath: RELAY_PATH, port: daemon.port() };
  const context: { subscriptions: { dispose?: () => void }[] } = { subscriptions: [] };
  extension.activate(context);
  t.after(async () => {
    for (const subscription of context.subscriptions) subscription.dispose?.();
    await daemon.close();
  });

  const code = vscode.__test.document({ uri: 'file:///tmp/app.js', text: 'const a = 1;', languageId: 'javascript' });
  vscode.__test.fire('open', code);
  vscode.__test.fire('save', code);

  const marker = (method: string) => daemon.waitFor(
    (message) => message.type === 'lsp' && message.method === ACTIVITY_METHOD && paramAt(message, 'method') === method,
    `no ${method} marker reached the daemon`,
  );

  const opened = await marker('textDocument/didOpen');
  assert.equal(paramAt(opened, 'uri'), 'file:///tmp/app.js');
  // The whole point of the marker: the buffer this lane never sweeps does not ride the wire.
  assert.equal(JSON.stringify(opened).includes('const a = 1'), false);

  await marker('textDocument/didSave');
  vscode.__test.fire('close', code);
  await marker('textDocument/didClose');
});

test('a non-markdown buffer is never mirrored', async (t) => {
  const daemon = createDaemon();
  await once(daemon.server, 'listening');

  vscode.__test.reset();
  vscode.__test.state.settings = { relayPath: RELAY_PATH, port: daemon.port() };
  const context: { subscriptions: { dispose?: () => void }[] } = { subscriptions: [] };
  extension.activate(context);
  t.after(async () => {
    for (const subscription of context.subscriptions) subscription.dispose?.();
    await daemon.close();
  });

  const code = vscode.__test.document({ uri: 'file:///tmp/app.js', text: 'const a = 1;', languageId: 'javascript' });
  vscode.__test.fire('open', code);

  const markdown = vscode.__test.document({ uri: URI, text: '# Plan\n' });
  vscode.__test.fire('open', markdown);

  const opened = await daemon.waitFor(isLsp('textDocument/didOpen'), 'no didOpen reached the daemon');
  assert.equal(paramAt(opened, 'textDocument.uri'), URI);
});

test('an absent relay reports itself instead of spawning anything', () => {
  vscode.__test.reset();
  vscode.__test.state.settings = { relayPath: '/nowhere/visions-relay.js', port: 0 };
  const context: { subscriptions: { dispose?: () => void }[] } = { subscriptions: [] };
  extension.activate(context);
  assert.equal(context.subscriptions.length, 2);
  assert.match(String(vscode.__test.state.errors[0]), /glissa visions install/);
});

// The extension is packed into a .vsix and cannot require anything inside this package, so its copy of
// the wire constant is pinned here instead.
test('the packed extension names the same activity method the daemon answers', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'tools', 'vscode-visions', 'extension.ts'), 'utf8');
  assert.match(source, new RegExp(`const ACTIVITY_METHOD = '${ACTIVITY_METHOD}';`));
});

test('the relay port rides argv only when one was configured', () => {
  assert.deepEqual(extension.relayArgs('/opt/relay.js', 0), ['/opt/relay.js']);
  assert.deepEqual(extension.relayArgs('/opt/relay.js', 5173), ['/opt/relay.js', '--port', '5173']);
});
