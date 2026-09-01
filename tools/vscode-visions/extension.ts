// A hand-rolled LSP client rather than vscode-languageclient: this extension rides the npm tarball, so
// a client library would have to ride it too as vendored node_modules.
//
// Authored CommonJS-style on purpose: `server/visions-setup.ts` strips the types and packs the result
// under the .js names the extension host loads, and that host has no ESM loader and no type stripping.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const vscode = require('vscode');

const { createParserState, feedFrameBytes, serializeFrame } = require('./visions-lsp-core.js');
const {
  decideEditFreshness, toCodeActions, toDiagnostics, toWorkspaceEdit,
} = require('./lsp-convert.js');

interface Disposable {
  dispose(): void;
}

interface ExtensionContext {
  subscriptions: Disposable[];
}

interface WorkspaceConfiguration {
  get<Value>(key: string, fallback: Value): Value;
}

interface OutputChannel extends Disposable {
  append(text: string): void;
  appendLine(text: string): void;
}

interface DiagnosticCollection extends Disposable {
  set(uri: unknown, diagnostics: unknown): void;
  delete(uri: unknown): void;
  clear(): void;
}

interface DocumentUri {
  toString(): string;
  scheme: string;
}

interface TextDocument {
  uri: DocumentUri;
  languageId: string;
  version: number;
  getText(): string;
}

interface CodeActionRange {
  start: unknown;
  end: unknown;
}

interface CodeActionContext {
  triggerKind?: unknown;
}

interface RelayMessage {
  method?: string;
  id?: number | string;
  params?: Record<string, unknown>;
  result?: unknown;
}

interface RelayClientOptions {
  relayPath: string;
  port: number;
  output: OutputChannel;
  diagnostics: DiagnosticCollection;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  timer: NodeJS.Timeout;
}

interface RelayStream {
  on(event: 'data', listener: (chunk: Buffer) => void): void;
}

interface RelayProcess {
  killed: boolean;
  stdin: { writable: boolean; write(data: unknown): void };
  stdout: RelayStream;
  stderr: RelayStream;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'exit', listener: (code: number | null) => void): void;
  kill(): void;
}

const LANGUAGE_ID = 'markdown';
// Every other file reports markers only: the lane sweeps markdown alone but the machine still moved.
const ACTIVITY_METHOD = 'visions/editorActivity';
const CODE_ACTION_TIMEOUT_MS = 2000;
const INITIAL_RESTART_MS = 1000;
const MAX_RESTART_MS = 15000;

function stampedRelayPath(): string {
  try {
    const stamp: unknown = JSON.parse(fs.readFileSync(path.join(__dirname, 'relay-path.json'), 'utf8'));
    if (typeof stamp !== 'object' || stamp === null) return '';
    if (!('relayPath' in stamp) || typeof stamp.relayPath !== 'string') return '';
    return stamp.relayPath;
  } catch {
    return '';
  }
}

function resolveRelayPath(settings: WorkspaceConfiguration, env: NodeJS.ProcessEnv): string {
  const candidates = [settings.get('relayPath', ''), env.GLISSA_RELAY_PATH || '', stampedRelayPath()];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function relayArgs(relayPath: string, port: number): string[] {
  if (!Number.isInteger(port) || port <= 0) return [relayPath];
  return [relayPath, '--port', String(port)];
}

function activate(context: ExtensionContext): void {
  const output: OutputChannel = vscode.window.createOutputChannel('Glissa Visions');
  const diagnostics: DiagnosticCollection = vscode.languages.createDiagnosticCollection('glissa-visions');
  context.subscriptions.push(output, diagnostics);

  const settings: WorkspaceConfiguration = vscode.workspace.getConfiguration('glissaVisions');
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
    vscode.workspace.onDidOpenTextDocument((document: TextDocument) => client.didOpen(document)),
    vscode.workspace.onDidChangeTextDocument((event: { document: TextDocument }) => client.didChange(event.document)),
    vscode.workspace.onDidSaveTextDocument((document: TextDocument) => client.didSave(document)),
    vscode.workspace.onDidCloseTextDocument((document: TextDocument) => client.didClose(document)),
    vscode.languages.registerCodeActionsProvider(
      { language: LANGUAGE_ID },
      { provideCodeActions: (document: TextDocument, range: CodeActionRange, actionContext: CodeActionContext) => client.codeActions(document, range, actionContext) },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
  );
}

function createRelayClient({ relayPath, port, output, diagnostics }: RelayClientOptions) {
  let child: RelayProcess | null = null;
  let parserState = createParserState();
  let nextRequestId = 1;
  let restartMs = INITIAL_RESTART_MS;
  let restartTimer: NodeJS.Timeout | null = null;
  let isStopping = false;
  const pendingById = new Map<number | string, PendingRequest>();
  const openVersionByUri = new Map<string, number>();

  function send(message: unknown): boolean {
    if (!child || child.killed || !child.stdin.writable) return false;
    child.stdin.write(serializeFrame(message));
    return true;
  }

  function notify(method: string, params: unknown): boolean {
    return send({ jsonrpc: '2.0', method, params });
  }

  function request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve) => {
      const id = nextRequestId;
      nextRequestId += 1;
      const timer = setTimeout(() => settle(id, null), timeoutMs);
      pendingById.set(id, { resolve, timer });
      if (!send({ jsonrpc: '2.0', id, method, params })) settle(id, null);
    });
  }

  function settle(id: number | string, result: unknown): void {
    const pending = pendingById.get(id);
    if (!pending) return;
    pendingById.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }

  function failPending(): void {
    for (const id of [...pendingById.keys()]) settle(id, null);
  }

  function isMirrored(document: TextDocument): boolean {
    return document.languageId === LANGUAGE_ID;
  }

  function reportActivity(document: TextDocument, method: string): void {
    if (document.uri.scheme !== 'file') return;
    notify(ACTIVITY_METHOD, { uri: document.uri.toString(), method });
  }

  function didOpen(document: TextDocument): void {
    if (!isMirrored(document)) {
      reportActivity(document, 'textDocument/didOpen');
      return;
    }
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

  // Whole-buffer changes: the incremental path would re-derive ranges the editor already applied.
  function didChange(document: TextDocument): void {
    if (!isMirrored(document)) return;
    if (!openVersionByUri.has(document.uri.toString())) {
      didOpen(document);
      return;
    }
    openVersionByUri.set(document.uri.toString(), document.version);
    notify('textDocument/didChange', {
      textDocument: { uri: document.uri.toString(), version: document.version },
      contentChanges: [{ text: document.getText() }],
    });
  }

  function didSave(document: TextDocument): void {
    if (!isMirrored(document)) {
      reportActivity(document, 'textDocument/didSave');
      return;
    }
    notify('textDocument/didSave', { textDocument: { uri: document.uri.toString() } });
  }

  function didClose(document: TextDocument): void {
    if (!isMirrored(document)) {
      reportActivity(document, 'textDocument/didClose');
      return;
    }
    openVersionByUri.delete(document.uri.toString());
    diagnostics.delete(document.uri);
    notify('textDocument/didClose', { textDocument: { uri: document.uri.toString() } });
  }

  async function codeActions(document: TextDocument, range: CodeActionRange, actionContext: CodeActionContext) {
    if (!isMirrored(document)) return [];
    const result = await request('textDocument/codeAction', {
      textDocument: { uri: document.uri.toString() },
      range: { start: range.start, end: range.end },
      context: { diagnostics: [], triggerKind: actionContext?.triggerKind },
    }, CODE_ACTION_TIMEOUT_MS);
    return toCodeActions(vscode, result);
  }

  function versionOfUri(uri: string): number | null {
    if (!openVersionByUri.has(uri)) return null;
    return openVersionByUri.get(uri) ?? null;
  }

  async function handleApplyEdit(id: number | string, params: Record<string, unknown> | undefined): Promise<boolean> {
    const edit = params?.edit;
    const freshness = decideEditFreshness(edit, versionOfUri);
    if (!freshness.fresh) {
      output.appendLine(`applyEdit refused: ${freshness.reason}`);
      return send({ jsonrpc: '2.0', id, result: { applied: false } });
    }
    const applied = await vscode.workspace.applyEdit(toWorkspaceEdit(vscode, edit));
    return send({ jsonrpc: '2.0', id, result: { applied } });
  }

  function handleMessage(message: RelayMessage): void {
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

  function openMirroredDocuments(): void {
    for (const document of vscode.workspace.textDocuments) didOpen(document);
  }

  async function handshake(): Promise<void> {
    await request('initialize', {
      processId: process.pid,
      rootUri: null,
      capabilities: {},
      clientInfo: { name: 'glissa-visions-extension' },
    }, CODE_ACTION_TIMEOUT_MS);
    notify('initialized', {});
    openMirroredDocuments();
  }

  function scheduleRestart(): void {
    if (isStopping || restartTimer) return;
    output.appendLine(`relay exited; restarting in ${restartMs}ms`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      start();
    }, restartMs);
    restartMs = Math.min(restartMs * 2, MAX_RESTART_MS);
  }

  function start(): void {
    if (isStopping) return;
    parserState = createParserState();
    openVersionByUri.clear();
    // The editor's own binary in node mode, so an extension host with no `node` on PATH still connects.
    const relay: RelayProcess = spawn(process.execPath, relayArgs(relayPath, port), {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
    });
    child = relay;
    output.appendLine(`relay started: ${relayPath}`);

    relay.stdout.on('data', (chunk: Buffer) => {
      const parsed = feedFrameBytes(parserState, Buffer.from(chunk));
      parserState = parsed.state;
      for (const message of parsed.messages) handleMessage(message);
    });
    relay.stderr.on('data', (chunk: Buffer) => output.append(String(chunk)));
    relay.on('error', (error: Error) => output.appendLine(`relay failed to start: ${error.message}`));
    relay.on('exit', (code: number | null) => {
      failPending();
      diagnostics.clear();
      output.appendLine(`relay exit code ${code}`);
      scheduleRestart();
    });

    handshake();
  }

  function stop(): void {
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

function deactivate(): undefined {
  return undefined;
}

module.exports = { activate, deactivate, resolveRelayPath, relayArgs };
