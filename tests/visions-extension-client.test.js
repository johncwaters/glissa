'use strict';

// End-to-end for the bundled editor extension: the real relay, a fake daemon, and the vscode stub the
// extension host would otherwise supply. The extension is the only Visions component the daemon's own
// tests never exercised, and it is the one that has to be right for a file edit to reach the lane.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');

const vscode = require('./helpers/vscode-stub');

const STUB_PATH = require.resolve('./helpers/vscode-stub');
// The framing module is COPIED beside the extension when the vsix is packed (server/visions-cli.js), so
// in the repo it resolves only from the one place that owns it.
const LSP_CORE_PATH = require.resolve('../server/core/visions-lsp-core');
const RELAY_PATH = path.join(__dirname, '..', 'session', 'visions-relay.js');
const WAIT_MS = 8000;
const URI = 'file:///tmp/plan.md';

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolveWithVscodeStub(request, ...rest) {
  if (request === 'vscode') return STUB_PATH;
  if (request === './visions-lsp-core') return LSP_CORE_PATH;
  return originalResolve.call(this, request, ...rest);
};

const extension = require('../tools/vscode-visions/extension');

function createDaemon() {
  const server = new WebSocketServer({ port: 0, path: '/visions' });
  const received = [];
  const waiters = [];
  let socket = null;

  server.on('connection', (connection) => {
    socket = connection;
    connection.on('message', (data) => {
      const message = JSON.parse(data.toString('utf8'));
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
    port: () => server.address().port,
    send: (payload) => socket.send(JSON.stringify(payload)),
    waitFor(matches, label) {
      const index = received.findIndex(matches);
      if (index >= 0) return Promise.resolve(received.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(label)), WAIT_MS);
        waiters.push({ matches, resolve: (message) => { clearTimeout(timer); resolve(message); } });
      });
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function isLsp(method) {
  return (message) => message.type === 'lsp' && message.method === method;
}

async function waitUntil(predicate, label) {
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
  const context = { subscriptions: [] };
  extension.activate(context);
  t.after(async () => {
    for (const subscription of context.subscriptions) subscription.dispose?.();
    await daemon.close();
  });

  const document = vscode.__test.document({ uri: URI, text: '# Plan\n\nthe the buffer\n', version: 1 });
  vscode.__test.state.documents = [document];
  vscode.__test.fire('open', document);

  const opened = await daemon.waitFor(isLsp('textDocument/didOpen'), 'no didOpen reached the daemon');
  assert.equal(opened.params.textDocument.uri, URI);
  assert.equal(opened.params.textDocument.languageId, 'markdown');
  assert.match(opened.params.textDocument.text, /the the buffer/);

  const edited = vscode.__test.document({ uri: URI, text: '# Plan\n\nthe buffer\n', version: 2 });
  vscode.__test.state.documents = [edited];
  vscode.__test.fire('change', { document: edited });

  const changed = await daemon.waitFor(isLsp('textDocument/didChange'), 'no didChange reached the daemon');
  assert.equal(changed.params.textDocument.version, 2);
  assert.equal(changed.params.contentChanges[0].text, '# Plan\n\nthe buffer\n');

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
  assert.equal(vscode.__test.state.diagnosticsByUri.get(URI)[0].message, 'Repeated word');

  const provider = vscode.__test.state.codeActionProviders[0].provider;
  const range = new vscode.Range(new vscode.Position(2, 0), new vscode.Position(2, 7));
  const actionsPromise = provider.provideCodeActions(edited, range, { triggerKind: 1 });
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
  assert.equal(actions[0].title, 'Visions: remove repeated word');

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

test('a non-markdown buffer is never mirrored', async (t) => {
  const daemon = createDaemon();
  await once(daemon.server, 'listening');

  vscode.__test.reset();
  vscode.__test.state.settings = { relayPath: RELAY_PATH, port: daemon.port() };
  const context = { subscriptions: [] };
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
  assert.equal(opened.params.textDocument.uri, URI);
});

test('an absent relay reports itself instead of spawning anything', () => {
  vscode.__test.reset();
  vscode.__test.state.settings = { relayPath: '/nowhere/visions-relay.js', port: 0 };
  const context = { subscriptions: [] };
  extension.activate(context);
  assert.equal(context.subscriptions.length, 2);
  assert.match(vscode.__test.state.errors[0], /glissa visions install/);
});

test('the relay port rides argv only when one was configured', () => {
  assert.deepEqual(extension.relayArgs('/opt/relay.js', 0), ['/opt/relay.js']);
  assert.deepEqual(extension.relayArgs('/opt/relay.js', 5173), ['/opt/relay.js', '--port', '5173']);
});
