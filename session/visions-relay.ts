import fs from "node:fs";
import os from "node:os";

import WebSocket from "ws";

import {
  classifyMessage,
  createParserState,
  feedFrameBytes,
  serializeFrame,
} from "../server/core/visions-lsp-core.ts";
import type { LspMessage, LspParserState } from "../server/core/visions-lsp-core.ts";
import {
  applyDidChange,
  applyDidClose,
  applyDidOpen,
  createDocStore,
  formatRange,
  getDoc,
  listDocs,
  uriOfParams,
} from "../server/core/visions-buffer-core.ts";
import type { Range } from "../server/core/visions-buffer-core.ts";
import { decideConfigPath, glissaHomeDir } from "../server/core/config-path-core.ts";
import { ACTIVITY_METHOD } from "../server/core/ingest-editor-core.ts";
import { packageRoot } from "../server/runtime-paths.ts";
import {
  MAX_DAEMON_FRAME_BYTES,
  daemonMessage,
  decideDaemonFrame,
  decideMirrorSync,
  planMirrorReplay,
  replayDidOpenMessage,
} from "./core/visions-relay-core.ts";
import type { DaemonMessage } from "./core/visions-relay-core.ts";

const DEFAULT_PORTS = [5173, 3000];

const MAX_PENDING_FORWARDS = 50;
const INITIAL_RETRY_MS = 500;
const MAX_RETRY_MS = 5000;
const STABLE_CONNECTION_MS = 5000;
const METHOD_NOT_FOUND = -32601;
const MIRROR_METHODS = new Set(["textDocument/didOpen", "textDocument/didChange", "textDocument/didClose"]);
const FORWARDED_METHODS = new Set([...MIRROR_METHODS, "textDocument/didSave", ACTIVITY_METHOD]);

const CODE_ACTION_METHOD = "textDocument/codeAction";

const APPLY_EDIT_METHOD = "workspace/applyEdit";

const CODE_ACTION_TIMEOUT_MS = 2000;

type MirrorParams = Parameters<typeof applyDidOpen>[1];

function asDocumentParams(params: unknown): MirrorParams {
  if (params && typeof params === "object" && !Array.isArray(params)) return params as MirrorParams;
  return null;
}

interface PortPlan {
  ports: number[];
  isFixed: boolean;
}

interface MirrorUpdate {
  applied: boolean;
  reason?: string;
  index?: number;
  range?: Range | null;
  version?: number;
  currentVersion?: number;
}

interface FsApi {
  existsSync(candidate: string): boolean;
  readFileSync(candidate: string, encoding: "utf8"): string;
}

interface StdinLike {
  on(event: string, listener: (chunk: Buffer | string) => void): unknown;
  pause(): unknown;
}

interface StreamLike {
  write(chunk: string | Buffer): unknown;
}

interface WebSocketLike {
  readyState: number;
  send(data: string): void;
}

function parsePortValue(value: unknown): number | null {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

function resolvePortPlan(
  argv: string[] = [],
  env: Record<string, string | undefined> = process.env,
  configPort: unknown = null,
): PortPlan {
  const flagIndex = argv.indexOf("--port");
  const flagPort = flagIndex >= 0 ? parsePortValue(argv[flagIndex + 1]) : null;
  if (flagPort !== null) return { ports: [flagPort], isFixed: true };

  const envPort = parsePortValue(env.GLISSA_PORT);
  if (envPort !== null) return { ports: [envPort], isFixed: true };

  const configured = parsePortValue(configPort);
  if (configured === null) return { ports: DEFAULT_PORTS.slice(), isFixed: false };
  return { ports: [configured, ...DEFAULT_PORTS.filter((port) => port !== configured)], isFixed: false };
}

function readConfiguredPort(env: Record<string, string | undefined> = process.env, fsApi: FsApi = fs): unknown {
  const decided = decideConfigPath({
    env,
    homeDir: glissaHomeDir(os.homedir()),
    packageRoot,
  }, (candidate) => {
    try {
      return fsApi.existsSync(candidate);
    } catch {
      return false;
    }
  });
  if (!decided.path) return null;
  try {
    const parsed: unknown = JSON.parse(fsApi.readFileSync(decided.path, "utf8"));
    if (parsed && typeof parsed === "object") return (parsed as Record<string, unknown>).port ?? null;
    return null;
  } catch {
    return null;
  }
}

function nextDelayMs(currentDelayMs: number): number {
  return Math.min(currentDelayMs * 2, MAX_RETRY_MS);
}

const SYNC_KIND_INCREMENTAL = 2;

function initializeResult(): Record<string, unknown> {
  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: SYNC_KIND_INCREMENTAL,
      },
      codeActionProvider: true,
    },
    serverInfo: {
      name: "glissa-visions",
    },
  };
}

function methodNotFoundResponse(id: unknown, method: string | undefined): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: METHOD_NOT_FOUND,
      message: "Method not found",
      data: { method },
    },
  };
}

function responseMessage(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function editorNotification(method: string, params: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", method, params };
}

function daemonRequest(id: unknown, method: string, params: unknown): Record<string, unknown> {
  return { type: "lsp-request", id, method, params };
}

function daemonResponse(id: unknown, result: unknown): Record<string, unknown> {
  return { type: "lsp-response", id, result };
}

function editorRequest(id: string, method: string, params: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method, params };
}

function mirrorFailureDetail(update: MirrorUpdate): string {
  if (update.reason === "invalid-range" || update.reason === "invalid-text") return ` change=${update.index} range=${formatRange(update.range)}`;
  if (update.reason === "stale-version") return ` version=${update.version} current=${update.currentVersion}`;
  return "";
}

function sendWsFrame(ws: WebSocketLike | null, decision: { send: boolean; serialized: string }): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  if (!decision.send) return false;
  ws.send(decision.serialized);
  return true;
}

function sendWsJson(ws: WebSocketLike | null, payload: unknown): boolean {
  return sendWsFrame(ws, { send: true, serialized: JSON.stringify(payload) });
}

function createRelay({
  argv = process.argv.slice(2),
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
}: {
  argv?: string[];
  env?: Record<string, string | undefined>;
  stdin?: StdinLike;
  stdout?: StreamLike;
  stderr?: StreamLike;
} = {}) {
  const portPlan = resolvePortPlan(argv, env, readConfiguredPort(env));
  const docStore = createDocStore();
  let parserState: LspParserState = createParserState();
  let ws: WebSocket | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let stableConnectionTimer: NodeJS.Timeout | null = null;
  let retryMs = INITIAL_RETRY_MS;
  let nextPortIndex = 0;
  let isStopping = false;

  const pendingCodeActionById = new Map<unknown, NodeJS.Timeout>();

  const applyEditDaemonIdByEditorId = new Map<string, unknown>();
  const unsyncedUris = new Set<string>();
  const pendingForwards: DaemonMessage[] = [];
  let nextEditorRequestId = 1;

  function note(message: string): void {
    stderr.write(`[visions-relay] ${message}\n`);
  }

  function writeEditorMessage(message: unknown): void {
    stdout.write(serializeFrame(message));
  }

  function currentPort(): number {
    const port = portPlan.ports[nextPortIndex % portPlan.ports.length];
    nextPortIndex++;
    return port;
  }

  function clearRetryTimer(): void {
    if (!retryTimer) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  function clearStableConnectionTimer(): void {
    if (!stableConnectionTimer) return;
    clearTimeout(stableConnectionTimer);
    stableConnectionTimer = null;
  }

  function scheduleReconnect(port: number): void {
    if (isStopping || retryTimer) return;
    note(`lost the daemon on port ${port}; reconnecting in ${retryMs}ms`);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, retryMs);
    retryTimer.unref?.();
    retryMs = nextDelayMs(retryMs);
  }

  function forwardNotification(method: string, params: unknown): boolean {
    const message = daemonMessage(method, params);
    if (sendWsJson(ws, message)) return true;
    pendingForwards.push(message);
    if (pendingForwards.length > MAX_PENDING_FORWARDS) pendingForwards.shift();
    return false;
  }

  function flushPendingForwards(): number {
    let sent = 0;
    while (pendingForwards.length > 0) {
      if (!sendWsJson(ws, pendingForwards[0])) return sent;
      pendingForwards.shift();
      sent += 1;
    }
    return sent;
  }

  function replayMirror(socket: WebSocket) {
    const replay = planMirrorReplay(listDocs(docStore));
    for (const frame of replay.frames) {
      socket.send(frame.serialized);
      unsyncedUris.delete(frame.uri);
    }
    for (const skipped of replay.skipped) {
      sendWsJson(socket, daemonMessage("textDocument/didClose", { textDocument: { uri: skipped.uri } }));
      if (!unsyncedUris.has(skipped.uri)) {
        note(`mirror unsynced uri=${skipped.uri}: ${skipped.frameBytes} bytes exceeds ${MAX_DAEMON_FRAME_BYTES}`);
      }
      unsyncedUris.add(skipped.uri);
    }
    return replay;
  }

  function connect(): void {
    if (isStopping) return;
    const port = currentPort();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/visions`);
    ws = socket;

    socket.on("open", () => {
      if (ws !== socket) return;
      clearStableConnectionTimer();
      stableConnectionTimer = setTimeout(() => {
        if (ws !== socket) return;
        retryMs = INITIAL_RETRY_MS;
        stableConnectionTimer = null;
      }, STABLE_CONNECTION_MS);
      stableConnectionTimer.unref?.();
      const replay = replayMirror(socket);
      const forwarded = flushPendingForwards();
      note(`connected to the daemon on port ${port} (replayed ${replay.frames.length} mirrored documents, skipped ${replay.skipped.length}, ${forwarded} held markers)`);
    });

    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      handleDaemonText(data.toString("utf8"));
    });

    socket.on("error", () => {});

    socket.on("close", () => {
      if (ws === socket) ws = null;
      clearStableConnectionTimer();

      failPendingCodeActions();
      applyEditDaemonIdByEditorId.clear();
      scheduleReconnect(port);
    });
  }

  function settleCodeAction(id: unknown, result: unknown): boolean {
    if (!pendingCodeActionById.has(id)) return false;
    const timer = pendingCodeActionById.get(id);
    pendingCodeActionById.delete(id);
    if (timer) clearTimeout(timer);
    writeEditorMessage(responseMessage(id, result));
    return true;
  }

  function failPendingCodeActions(): void {
    for (const id of [...pendingCodeActionById.keys()]) settleCodeAction(id, null);
  }

  function forwardCodeAction(id: unknown, params: unknown): void {
    if (!sendWsJson(ws, daemonRequest(id, CODE_ACTION_METHOD, params))) {
      writeEditorMessage(responseMessage(id, null));
      return;
    }
    const timer = setTimeout(() => settleCodeAction(id, null), CODE_ACTION_TIMEOUT_MS);
    timer.unref?.();
    pendingCodeActionById.set(id, timer);
  }

  function forwardApplyEdit(daemonId: unknown, params: unknown): void {
    const editorId = `glissa-visions-${nextEditorRequestId}`;
    nextEditorRequestId += 1;
    applyEditDaemonIdByEditorId.set(editorId, daemonId);
    writeEditorMessage(editorRequest(editorId, APPLY_EDIT_METHOD, params));
  }

  function handleEditorResponse(editorId: unknown, msg: LspMessage): void {
    if (typeof editorId !== "string" || !applyEditDaemonIdByEditorId.has(editorId)) return;
    const daemonId = applyEditDaemonIdByEditorId.get(editorId);
    applyEditDaemonIdByEditorId.delete(editorId);
    const refused = "error" in msg ? msg.error : undefined;
    const result = "result" in msg ? msg.result : undefined;
    sendWsJson(ws, daemonResponse(daemonId, refused ? { applied: false } : result));
  }

  function stop(exitCode = 0): void {
    if (isStopping) return;
    isStopping = true;
    note(`shutting down (exit ${exitCode})`);
    clearRetryTimer();
    clearStableConnectionTimer();
    stdin.pause();
    if (ws) ws.close();
    setImmediate(() => process.exit(exitCode));
  }

  function handleDaemonText(text: string): void {
    let msg: { type?: unknown; id?: unknown; params?: unknown; method?: unknown; result?: unknown; error?: unknown } | null = null;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "publishDiagnostics") {
      writeEditorMessage(editorNotification("textDocument/publishDiagnostics", msg.params));
      return;
    }
    if (msg.type === "lsp-response") {
      settleCodeAction(msg.id, msg.result);
      return;
    }
    if (msg.type === "lsp-request" && msg.method === APPLY_EDIT_METHOD) forwardApplyEdit(msg.id, msg.params);
  }

  function updateMirror(method: string, params: unknown): MirrorUpdate {
    const documentParams = asDocumentParams(params);
    if (method === "textDocument/didOpen") return applyDidOpen(docStore, documentParams);
    if (method === "textDocument/didChange") return applyDidChange(docStore, documentParams);
    if (method === "textDocument/didClose") return applyDidClose(docStore, documentParams);
    return { applied: false, reason: "not-buffer-method" };
  }

  function sendMirrorNotification(method: string, params: unknown, mirrorUpdate: MirrorUpdate): boolean {
    const uri = uriOfParams(asDocumentParams(params));
    const originalMessage = daemonMessage(method, params);
    if (!uri) return sendWsJson(ws, originalMessage);

    const isUnsynced = unsyncedUris.has(uri);
    if (!mirrorUpdate.applied && !isUnsynced) return sendWsJson(ws, originalMessage);
    if (!mirrorUpdate.applied && method === "textDocument/didClose") {
      unsyncedUris.delete(uri);
      return false;
    }
    if (!mirrorUpdate.applied) return false;

    const originalFrame = decideDaemonFrame(originalMessage);
    const shouldCheckFullOpen = method !== "textDocument/didClose" && (isUnsynced || !originalFrame.send);
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
      if (action === "original") didSend = sendWsFrame(ws, originalFrame) || didSend;
      if (action === "close") {
        const closeMessage = daemonMessage("textDocument/didClose", { textDocument: { uri } });
        didSend = sendWsJson(ws, closeMessage) || didSend;
      }
      if (action === "full-open" && fullOpenFrame && sendWsFrame(ws, fullOpenFrame)) {
        unsyncedUris.delete(uri);
        didSend = true;
      }
    }
    if (syncPlan.forgetUnsynced) unsyncedUris.delete(uri);
    return didSend;
  }

  function handleNotification(method: string, params: unknown): boolean {
    if (MIRROR_METHODS.has(method)) {
      const mirrorUpdate = updateMirror(method, params);
      if (!mirrorUpdate.applied) note(`mirror update failed method=${method} uri=${uriOfParams(asDocumentParams(params)) || "<unknown>"} reason=${mirrorUpdate.reason}${mirrorFailureDetail(mirrorUpdate)}`);
      return sendMirrorNotification(method, params, mirrorUpdate);
    }
    if (FORWARDED_METHODS.has(method)) return forwardNotification(method, params);
    if (method === "exit") stop(0);
    return false;
  }

  function handleRequest(id: unknown, method: string | undefined, params: unknown): void {
    if (method === CODE_ACTION_METHOD) {
      forwardCodeAction(id, params);
      return;
    }
    if (method === "initialize") {
      note(`initialize answered: textDocumentSync change=${SYNC_KIND_INCREMENTAL} (incremental)`);
      writeEditorMessage(responseMessage(id, initializeResult()));
      return;
    }
    if (method === "shutdown") {
      note("shutdown requested by the editor");
      writeEditorMessage(responseMessage(id, null));
      return;
    }
    writeEditorMessage(methodNotFoundResponse(id, method));
  }

  function handleEditorMessage(msg: LspMessage): boolean {
    const classification = classifyMessage(msg);
    const params = "params" in msg ? msg.params : undefined;
    if (classification.kind === "request") {
      handleRequest(classification.id, classification.method, params);
      return false;
    }
    if (classification.kind === "notification" && classification.method) {
      return handleNotification(classification.method, params);
    }
    if (classification.kind === "response") handleEditorResponse(classification.id, msg);
    return false;
  }

  function handleStdinChunk(chunk: Buffer | string): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    const parsed = feedFrameBytes(parserState, bytes);
    parserState = parsed.state;
    for (const msg of parsed.messages) {
      handleEditorMessage(msg);
    }
  }

  function start(): void {
    connect();
    stdin.on("data", handleStdinChunk);
    stdin.on("end", () => stop(0));
  }

  return {
    start,
    stop,
    handleEditorMessage,
    handleDaemonText,
    portPlan,
  };
}

function main(): void {
  createRelay().start();
}

if (process.argv[1] === import.meta.filename) {
  main();
}

export {
  ACTIVITY_METHOD,
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
export type { WebSocketLike };
