import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { HookRouter } from '../detection/hook-source.ts';
import { Session } from '../session/sessions.ts';
import type { SessionOptions } from '../session/sessions.ts';
import { buildLanePermissions } from './core/lane-permissions-core.ts';
import {
  DEFAULT_TIMEOUT_SECONDS,
  ERROR_SOURCE_SESSION,
  ERROR_SOURCE_TRANSPORT,
  MAX_HAND_CHARS,
  VISIONS_RESULT_FILE,
  buildVisionsPrompt,
  countLines,
  decidePromptSize,
  sanitizeCommentsWithDrops,
} from './core/visions-dispatch-core.ts';
import type { VisionsComment } from './core/visions-dispatch-core.ts';
import { readIntentProposal, sanitizeIntentText } from './core/visions-intent-core.ts';
import {
  awaitSessionExit, drainPending, firstLine, raceWithAbort, registerEphemeralSession,
} from './ephemeral-session.ts';
import type { RecordLane, SpawnGate } from './ephemeral-session.ts';
import { createLaneLog } from './lane-log.ts';

const RESULT_VERDICTS = new Set(['COMMENTS', 'NONE', 'ERROR']);
const RESULT_FILE = VISIONS_RESULT_FILE;
const PROMPT_FILE = 'visions-prompt.txt';
const VISIONS_BOOTSTRAP_PROMPT = 'Read visions-prompt.txt and follow all instructions in that file';

const VISIONS_DENY_TOOLS = Object.freeze(['Bash', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task']);

const VISIONS_ALLOW_TOOLS = Object.freeze(['Read', 'Write']);

type VisionsSpawn = (options: {
  id: string;
  name: string;
  cwd: string;
  model?: string | null;
  signal?: AbortSignal | null;
  initialPrompt?: string;
}) => Promise<void>;

interface DispatchResult {
  verdict: string;
  comments: VisionsComment[];
  diagnostics: VisionsComment[];
  intent: { thread: string | null; text: string } | null;
  hand: string | null;
  outOfRange: number;
  errorSource: string | null;
  reason: string | null;
}

interface VisionsSpawnOptions {
  sessions?: Map<string, unknown>;
  closeSessionDataClients?: (id: string) => void;
  hookRouter?: Pick<HookRouter, 'register' | 'unregister'> | null;
  getHookPort?: (() => number | null) | null;
  spawnGate?: SpawnGate | null;
  replayBufferKB?: number;
  recordLane?: RecordLane | null;
}

interface VisionsDispatcherOptions {
  spawnSession?: VisionsSpawn;
  timeoutSeconds?: number;
  model?: string | null;
  logger?: Console;
  nowFn?: () => number;

  setTimeoutFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutFn?: (handle: NodeJS.Timeout) => void;
  makeWorkDir?: () => Promise<string>;
  removeWorkDir?: (dir: string) => Promise<void>;
  readResult?: typeof readCommentsResult;
  idFor?: (uri: string) => string;
}

interface DispatchInput {
  uri: string;
  text: string;
  findings?: unknown[];
  intent?: string;
  digest?: string;
  memory?: { text: string; count: number; version: string | null } | null;
  prompt?: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function visionsPermissions() {
  return buildLanePermissions({ denyTools: VISIONS_DENY_TOOLS, allowTools: VISIONS_ALLOW_TOOLS });
}

function errorResult(reason: string | null, errorSource: string = ERROR_SOURCE_TRANSPORT): DispatchResult {
  return {
    verdict: 'ERROR', comments: [], diagnostics: [], intent: null, hand: null, outOfRange: 0, errorSource, reason,
  };
}

async function readCommentsResult(
  resultPath: string,
  { lineCount = 0, onBytesRead = null }: {
    lineCount?: number;
    onBytesRead?: ((bytes: number) => void) | null;
  } = {},
): Promise<DispatchResult> {
  let raw = '';
  try {
    raw = await fs.readFile(resultPath, 'utf8');
  } catch {
    return errorResult('no readable result file');
  }
  if (typeof onBytesRead === 'function') onBytesRead(Buffer.byteLength(raw));
  let parsed: { verdict?: unknown; intent?: unknown; hand?: unknown; diagnostics?: unknown; comments?: unknown } | null = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return errorResult('result file is not JSON', ERROR_SOURCE_SESSION);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return errorResult('result file is not an object', ERROR_SOURCE_SESSION);
  }
  const verdict = String(parsed.verdict || '').toUpperCase();
  if (!RESULT_VERDICTS.has(verdict)) {
    return errorResult('invalid verdict in result file', ERROR_SOURCE_SESSION);
  }
  if (verdict === 'ERROR') return errorResult('session reported an error verdict', ERROR_SOURCE_SESSION);

  const intent = readIntentProposal(parsed.intent);
  const hand = sanitizeIntentText(parsed.hand, { maxChars: MAX_HAND_CHARS }) || null;
  const diagnosticsResult = sanitizeCommentsWithDrops(parsed.diagnostics, { lineCount });
  const diagnostics = diagnosticsResult.comments;
  if (verdict !== 'COMMENTS') {
    return {
      verdict, comments: [], diagnostics, intent, hand, outOfRange: diagnosticsResult.outOfRange, errorSource: null, reason: null,
    };
  }
  const commentsResult = sanitizeCommentsWithDrops(parsed.comments, { lineCount });
  const comments = commentsResult.comments;
  const outOfRange = commentsResult.outOfRange + diagnosticsResult.outOfRange;
  if (comments.length === 0) {
    return {
      verdict: 'NONE', comments: [], diagnostics, intent, hand, outOfRange, errorSource: null, reason: 'no comment in the result file survived validation',
    };
  }
  return {
    verdict, comments, diagnostics, intent, hand, outOfRange, errorSource: null, reason: null,
  };
}

function createVisionsSpawn({
  sessions = new Map(), closeSessionDataClients = () => {}, hookRouter = null, getHookPort = null,
  spawnGate = null, replayBufferKB = undefined, recordLane = null,
}: VisionsSpawnOptions = {}): VisionsSpawn {
  return async function spawnVisionsSession({ id, name, cwd, model = null, signal = null, initialPrompt = VISIONS_BOOTSTRAP_PROMPT }) {
    const posture = visionsPermissions();
    const extraClaudeArgs = ['-p', ...posture.args];
    if (model) extraClaudeArgs.push('--model', model);
    const options: SessionOptions = {
      id,
      name,
      path: cwd,
      dangerouslySkipPermissions: false,
      extraClaudeArgs,
      initialPrompt,
      ephemeral: true,
      settingsPermissions: posture.permissions,
      replayBufferKB,
      hookRouter,
      getHookPort,
    };
    const sess = new Session(options);
    registerEphemeralSession({ map: sessions, id, sess, closeSessionDataClients, logPrefix: 'visions', name, recordLane });

    await awaitSessionExit(sess, { signal, spawnGate });
  };
}

function makeVisionsWorkDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'glissa-visions-'));
}

function createVisionsDispatcher({
  spawnSession,
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  model = null,
  logger = console,
  nowFn = Date.now,
  setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
  clearTimeoutFn = clearTimeout,
  makeWorkDir = makeVisionsWorkDir,
  removeWorkDir = async (dir: string) => { try { await fs.rm(dir, { recursive: true, force: true }); } catch {  } },
  readResult = readCommentsResult,
  idFor = (uri: string) => `visions:${uri}:${Date.now()}`,
}: VisionsDispatcherOptions = {}) {
  if (typeof spawnSession !== 'function') throw new Error('createVisionsDispatcher requires spawnSession');

  const { note, warn } = createLaneLog({ prefix: '[visions]', logger });

  const startSession = spawnSession;
  const readDispatchResult = readResult;

  function spawnWithTimeout({
    id, name, cwd, uri, resultPath, lineCount, onPending = null,
  }: {
    id: string;
    name: string;
    cwd: string;
    uri: string;
    resultPath: string;
    lineCount: number;
    onPending?: ((promise: Promise<unknown>) => void) | null;
  }): Promise<DispatchResult> {
    const startedAt = nowFn();
    const elapsed = () => nowFn() - startedAt;
    return raceWithAbort<DispatchResult>({
      timeoutMs: timeoutSeconds * 1000,
      setTimeoutFn,
      clearTimeoutFn,
      onPending,
      onTimeout: () => {
        warn(`dispatch for ${uri} timed out after ${elapsed()}ms`);
        return errorResult('dispatch timed out');
      },
      onEmpty: () => errorResult('no verdict'),
      start: (signal) => Promise.resolve(startSession({
        id, name, cwd, model, signal, initialPrompt: VISIONS_BOOTSTRAP_PROMPT,
      }))
        .then(async () => {
          if (signal.aborted) {
            note(`dispatch for ${uri} was aborted after ${elapsed()}ms`);
            return undefined;
          }

          let bytesRead = 0;
          const result = await readDispatchResult(resultPath, { lineCount, onBytesRead: (bytes) => { bytesRead = bytes; } });
          note(`dispatch result for ${uri}: ${result.verdict} (${bytesRead} bytes, ${elapsed()}ms)`);

          if (result.outOfRange > 0) warn(`dispatch for ${uri} reported ${result.outOfRange} line(s) past the ${lineCount}-line buffer; the entries it kept may be anchored wrong`);
          return result;
        })
        .catch((error: unknown) => errorResult(firstLine(errorMessage(error)))),
    });
  }

  return async function dispatch({ uri, text, findings = [], intent = '', digest = '', memory = null, prompt = null }: DispatchInput): Promise<DispatchResult> {
    let workDir: string | null = null;
    try {
      workDir = await makeWorkDir();
    } catch (error) {
      return errorResult(`no work dir: ${firstLine(errorMessage(error))}`);
    }
    const resultPath = path.join(workDir, RESULT_FILE);
    let pendingSpawn: Promise<unknown> | null = null;
    try {
      const generatedPrompt = typeof prompt === 'string'
        ? prompt
        : buildVisionsPrompt({ uri, text, findings, intent, digest, memory });
      const sizeDecision = decidePromptSize(generatedPrompt);
      if (!sizeDecision.dispatch) return errorResult(sizeDecision.gate);
      await fs.writeFile(path.join(workDir, PROMPT_FILE), generatedPrompt, 'utf8');
      return await spawnWithTimeout({
        id: idFor(uri),
        name: `visions ${uri}`,
        cwd: workDir,
        uri,
        resultPath,
        lineCount: countLines(text),
        onPending: (promise) => { pendingSpawn = promise; },
      });
    } catch (error) {
      return errorResult(firstLine(errorMessage(error)));
    } finally {
      await drainPending(pendingSpawn);
      await removeWorkDir(workDir);
    }
  };
}

export {
  PROMPT_FILE,
  RESULT_FILE,
  VISIONS_BOOTSTRAP_PROMPT,
  VISIONS_DENY_TOOLS,
  createVisionsDispatcher,
  createVisionsSpawn,
  makeVisionsWorkDir,
  readCommentsResult,
  visionsPermissions,
};
export type { DispatchInput, DispatchResult, VisionsSpawn };
