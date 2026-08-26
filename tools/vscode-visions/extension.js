/*
 * Glissa Visions editor extension: a dependency-free LSP client for session/visions-relay.js.
 *
 * It speaks the protocol directly rather than through vscode-languageclient because this extension
 * ships inside the glissa npm package and is packed into a .vsix at install time (server/core/vsix-core.js):
 * a client library would have to ride the tarball as vendored node_modules, and the repo takes no
 * dependency it does not need. The relay is a plain stdio LSP server, so the client it needs is small.
 *
 * The relay is spawned with the editor's own Electron binary in node mode, so a machine with no `node`
 * on the extension host's PATH still connects.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const vscode = require('vscode');

const { createParserState, feedFrameBytes, serializeFrame } = require('./visions-lsp-core');
const {
  decideEditFreshness, toCodeActions, toDiagnostics, toWorkspaceEdit,
} = require('./lsp-convert');

const LANGUAGE_ID = 'markdown';
const CODE_ACTION_TIMEOUT_MS = 2000;
const INITIAL_RESTART_MS = 1000;
const MAX_RESTART_MS = 15000;

function stampedRelayPath() {
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(__dirname, 'relay-path.json'), 'utf8'));
    return typeof stamp?.relayPath === 'string' ? stamp.relayPath : '';
  } catch {
    return '';
  }
}

function resolveRelayPath(settings, env) {
  const candidates = [settings.get('relayPath', ''), env.GLISSA_RELAY_PATH || '', stampedRelayPath()];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function relayArgs(relayPath, port) {
  if (!Number.isInteger(port) || port <= 0) return [relayPath];
  return [relayPath, '--port', String(port)];
}

function activate(context) {
  const output = vscode.window.createOutputChannel('Glissa Visions');
  const diagnostics = vscode.languages.createDiagnosticCollection('glissa-visions');
  context.subscriptions.push(output, diagnostics);

  const settings = vscode.workspace.getConfiguration('glissaVisions');
  const relayPath = resolveRelayPath(settings, process.env);
  if (!relayPath) {
    output.appendLine('no relay found: reinstall with `glissa visions install`, or set glissaVisions.relayPath');
    vscode.window.showErrorMessage('Glissa Visions found no relay. Run `glissa visions install` again, or set glissaVisions.relayPath.');
    return;
  }

  const client = createRelayClient({
    relayPath,
    port: settings.get('port', 0),
    output,
    diagnostics,
  });
  context.subscriptions.push({ dispose: () => client.stop() });
  client.start();

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => client.didOpen(document)),
    vscode.workspace.onDidChangeTextDocument((event) => client.didChange(event.document)),
    vscode.workspace.onDidSaveTextDocument((document) => client.didSave(document)),
    vscode.workspace.onDidCloseTextDocument((document) => client.didClose(document)),
    vscode.languages.registerCodeActionsProvider(
      { language: LANGUAGE_ID },
      { provideCodeActions: (document, range, actionContext) => client.codeActions(document, range, actionContext) },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
  );
}

function createRelayClient({ relayPath, port, output, diagnostics }) {
  let child = null;
  let parserState = createParserState();
  let nextRequestId = 1;
  let restartMs = INITIAL_RESTART_MS;
  let restartTimer = null;
  let isStopping = false;
  const pendingById = new Map();
  const openVersionByUri = new Map();

  function send(message) {
    if (!child || child.killed || !child.stdin.writable) return false;
    child.stdin.write(serializeFrame(message));
    return true;
  }

  function notify(method, params) {
    return send({ jsonrpc: '2.0', method, params });
  }

  function request(method, params, timeoutMs) {
    return new Promise((resolve) => {
      const id = nextRequestId;
      nextRequestId += 1;
      const timer = setTimeout(() => settle(id, null), timeoutMs);
      pendingById.set(id, { resolve, timer });
      if (!send({ jsonrpc: '2.0', id, method, params })) settle(id, null);
    });
  }

  function settle(id, result) {
    const pending = pendingById.get(id);
    if (!pending) return;
    pendingById.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }

  function failPending() {
    for (const id of [...pendingById.keys()]) settle(id, null);
  }

  function isMirrored(document) {
    return document.languageId === LANGUAGE_ID;
  }

  function didOpen(document) {
    if (!isMirrored(document)) return;
    openVersionByUri.set(document.uri.toString(), document.version);
    notify('textDocument/didOpen', {
      textDocument: {
        uri: document.uri.toString(),
        languageId: document.languageId,
        version: document.version,
        text: document.getText(),
      },
    });
  }

  // Whole-buffer changes: the relay's store takes them (server/core/visions-buffer-core.js), and the
  // incremental path would have this client re-deriving ranges the editor already applied.
  function didChange(document) {
    if (!isMirrored(document)) return;
    if (!openVersionByUri.has(document.uri.toString())) return didOpen(document);
    openVersionByUri.set(document.uri.toString(), document.version);
    notify('textDocument/didChange', {
      textDocument: { uri: document.uri.toString(), version: document.version },
      contentChanges: [{ text: document.getText() }],
    });
  }

  function didSave(document) {
    if (!isMirrored(document)) return;
    notify('textDocument/didSave', { textDocument: { uri: document.uri.toString() } });
  }

  function didClose(document) {
    if (!isMirrored(document)) return;
    openVersionByUri.delete(document.uri.toString());
    diagnostics.delete(document.uri);
    notify('textDocument/didClose', { textDocument: { uri: document.uri.toString() } });
  }

  async function codeActions(document, range, actionContext) {
    if (!isMirrored(document)) return [];
    const result = await request('textDocument/codeAction', {
      textDocument: { uri: document.uri.toString() },
      range: { start: range.start, end: range.end },
      context: { diagnostics: [], triggerKind: actionContext?.triggerKind },
    }, CODE_ACTION_TIMEOUT_MS);
    return toCodeActions(vscode, result);
  }

  function versionOfUri(uri) {
    if (!openVersionByUri.has(uri)) return null;
    return openVersionByUri.get(uri);
  }

  async function handleApplyEdit(id, params) {
    const freshness = decideEditFreshness(params?.edit, versionOfUri);
    if (!freshness.fresh) {
      output.appendLine(`applyEdit refused: ${freshness.reason}`);
      return send({ jsonrpc: '2.0', id, result: { applied: false } });
    }
    const applied = await vscode.workspace.applyEdit(toWorkspaceEdit(vscode, params.edit));
    return send({ jsonrpc: '2.0', id, result: { applied } });
  }

  function handleMessage(message) {
    if (message?.method === 'textDocument/publishDiagnostics') {
      const uri = message.params?.uri;
      if (typeof uri !== 'string') return;
      diagnostics.set(vscode.Uri.parse(uri), toDiagnostics(vscode, message.params?.diagnostics));
      return;
    }
    if (message?.method === 'workspace/applyEdit' && message.id !== undefined) {
      handleApplyEdit(message.id, message.params);
      return;
    }
    if (message?.id !== undefined && message.method === undefined) settle(message.id, message.result ?? null);
  }

  function openMirroredDocuments() {
    for (const document of vscode.workspace.textDocuments) didOpen(document);
  }

  async function handshake() {
    await request('initialize', {
      processId: process.pid,
      rootUri: null,
      capabilities: {},
      clientInfo: { name: 'glissa-visions-extension' },
    }, CODE_ACTION_TIMEOUT_MS);
    notify('initialized', {});
    openMirroredDocuments();
  }

  function scheduleRestart() {
    if (isStopping || restartTimer) return;
    output.appendLine(`relay exited; restarting in ${restartMs}ms`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      start();
    }, restartMs);
    restartMs = Math.min(restartMs * 2, MAX_RESTART_MS);
  }

  function start() {
    if (isStopping) return;
    parserState = createParserState();
    openVersionByUri.clear();
    child = spawn(process.execPath, relayArgs(relayPath, port), {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
    });
    output.appendLine(`relay started: ${relayPath}`);

    child.stdout.on('data', (chunk) => {
      const parsed = feedFrameBytes(parserState, Buffer.from(chunk));
      parserState = parsed.state;
      for (const message of parsed.messages) handleMessage(message);
    });
    child.stderr.on('data', (chunk) => output.append(String(chunk)));
    child.on('error', (error) => output.appendLine(`relay failed to start: ${error.message}`));
    child.on('exit', (code) => {
      failPending();
      diagnostics.clear();
      output.appendLine(`relay exit code ${code}`);
      scheduleRestart();
    });

    handshake();
  }

  function stop() {
    isStopping = true;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    failPending();
    if (!child) return;
    notify('shutdown', {});
    notify('exit', {});
    child.kill();
    child = null;
  }

  return { codeActions, didChange, didClose, didOpen, didSave, start, stop };
}

function deactivate() {
  return undefined;
}

module.exports = { activate, deactivate, resolveRelayPath, relayArgs };
