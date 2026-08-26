/*
 * Visions tier 3 dispatch: the IO half of docs/archive/plan-navigator.md M4.
 *
 * Permissions posture, live-probed against the real CLI (2.x):
 *   - NO --dangerously-skip-permissions. The prompt file embeds arbitrary buffer text, so the session gets
 *     the least capability that still lets it write its result file.
 *   - There is NO allow list. A bare `Write` allow is what unbounds the writes, and no narrower allow
 *     grants the tool at all: both `Write(<dir>/**)` and `Edit(<dir>/**)` were probed and neither
 *     authorizes a Write. What confines them is `defaultMode: acceptEdits` over the throwaway cwd this
 *     module hands the session, which auto-accepts edits there and refuses them anywhere else.
 *   - The deny list below is the guard on top of that. Read is deliberately NOT denied: a bare `Read`
 *     deny refuses the Write tool too (probed), so denying reads and keeping the result contract are
 *     mutually exclusive with this plumbing.
 *   - Re-probed against 2.1.241; every clause and its counter-example is in
 *     server/core/lane-permissions-core.js.
 */

'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  awaitSessionExit, drainPending, firstLine, raceWithAbort, registerEphemeralSession,
} = require('./ephemeral-session');
const {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_HAND_CHARS,
  VISIONS_RESULT_FILE,
  buildVisionsPrompt,
  countLines,
  decidePromptSize,
  sanitizeComments,
} = require('./core/visions-dispatch-core');
const { buildLanePermissions } = require('./core/lane-permissions-core');
const { sanitizeIntentText } = require('./core/visions-intent-core');
const { createLaneLog } = require('./lane-log');

const RESULT_VERDICTS = new Set(['COMMENTS', 'NONE', 'ERROR']);
const RESULT_FILE = VISIONS_RESULT_FILE;
const PROMPT_FILE = 'visions-prompt.txt';
const VISIONS_BOOTSTRAP_PROMPT = 'Read visions-prompt.txt and follow all instructions in that file';

// Verbs a visions never needs: no shell, no editing, no network, no sub-agents.
const VISIONS_DENY_TOOLS = Object.freeze(['Bash', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task']);

function visionsPermissions() {
  return buildLanePermissions({ denyTools: VISIONS_DENY_TOOLS });
}

function errorResult(reason) {
  return {
    verdict: 'ERROR', comments: [], diagnostics: [], intent: null, hand: null, reason,
  };
}

/**
 * The result contract, read once. `onBytesRead` reports what the session actually wrote, so the caller
 * can log a size without a second stat of a file this already has in hand; it rides the options bag
 * rather than the returned shape, which several callers compare field for field.
 */
async function readCommentsResult(resultPath, { lineCount = 0, onBytesRead = null } = {}) {
  let parsed = null;
  try {
    const raw = await fs.readFile(resultPath, 'utf8');
    if (typeof onBytesRead === 'function') onBytesRead(Buffer.byteLength(raw));
    parsed = JSON.parse(raw);
  } catch {
    return errorResult('no readable result file');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return errorResult('result file is not an object');
  }
  const verdict = String(parsed.verdict || '').toUpperCase();
  if (!RESULT_VERDICTS.has(verdict)) {
    return errorResult('invalid verdict in result file');
  }
  if (verdict === 'ERROR') return errorResult('session reported an error verdict');
  // Optional, and validated exactly like a comment message: a non-string or empty claim is simply not
  // an updated belief, so it is dropped rather than clearing the standing statement.
  const intent = sanitizeIntentText(parsed.intent) || null;
  const hand = sanitizeIntentText(parsed.hand, { maxChars: MAX_HAND_CHARS }) || null;
  const diagnostics = sanitizeComments(parsed.diagnostics, { lineCount });
  if (verdict !== 'COMMENTS') {
    return {
      verdict, comments: [], diagnostics, intent, hand, reason: null,
    };
  }
  const comments = sanitizeComments(parsed.comments, { lineCount });
  if (comments.length === 0) {
    return {
      verdict: 'NONE', comments: [], diagnostics, intent, hand, reason: 'no comment in the result file survived validation',
    };
  }
  return {
    verdict, comments, diagnostics, intent, hand, reason: null,
  };
}

/**
 * The real spawn: one ephemeral headless session registered through the shared seam, which is what
 * puts a `visions` row on the Usage tab's lane ledger with no ledger code of its own. Never
 * rejects on an abort; the caller has already resolved that race.
 */
/**
 * @param {{ sessions?: Map<string, unknown>, closeSessionDataClients?: (id: string) => void,
 *   hookRouter?: unknown, getHookPort?: (() => number | null) | null, spawnGate?: unknown,
 *   replayBufferKB?: number, recordLane?: ((...args: unknown[]) => unknown) | null }} [options]
 */
function createVisionsSpawn({
  sessions = new Map(), closeSessionDataClients = () => {}, hookRouter = null, getHookPort = null,
  spawnGate = null, replayBufferKB = undefined, recordLane = null,
} = {}) {
  return async function spawnVisionsSession({ id, name, cwd, model = null, signal = null }) {
    // Required here, not at module load: an inert lane must not pay for resolving `claude` on PATH.
    const { Session } = require('../session/sessions');
    const posture = visionsPermissions();
    const extraClaudeArgs = ['-p'];
    if (model) extraClaudeArgs.push('--model', model);
    const sess = new Session({
      id,
      name,
      path: cwd,
      dangerouslySkipPermissions: false,
      extraClaudeArgs,
      initialPrompt: VISIONS_BOOTSTRAP_PROMPT,
      ephemeral: true,
      settingsPermissions: posture.permissions,
      replayBufferKB,
      hookRouter,
      getHookPort,
    });
    registerEphemeralSession({ map: sessions, id, sess, closeSessionDataClients, logPrefix: 'visions', name, recordLane });

    await awaitSessionExit(sess, { signal, spawnGate });
  };
}

/**
 * One dispatch, end to end: a throwaway cwd, the prompt, the spawn, the timeout race, the result
 * file. Returns { verdict, comments, reason } and never throws, so the wiring's gate logic has a
 * single shape to handle.
 */
/**
 * @param {{ spawnSession?: (options: { id: string, name: string, cwd: string, model?: string | null, signal?: AbortSignal | null, initialPrompt?: string }) => Promise<void>, timeoutSeconds?: number,
 *   model?: string | null, logger?: Console, nowFn?: () => number,
 *   setTimeoutFn?: typeof setTimeout, clearTimeoutFn?: typeof clearTimeout,
 *   makeWorkDir?: () => Promise<string>, removeWorkDir?: (dir: string) => Promise<void>,
 *   readResult?: typeof readCommentsResult, idFor?: (uri: string) => string }} [options]
 */
function createVisionsDispatcher({
  spawnSession,
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  model = null,
  logger = console,
  nowFn = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  makeWorkDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'glissa-visions-')),
  removeWorkDir = async (dir) => { try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* best-effort */ } },
  readResult = readCommentsResult,
  idFor = (uri) => `visions:${uri}:${Date.now()}`,
} = {}) {
  if (typeof spawnSession !== 'function') throw new Error('createVisionsDispatcher requires spawnSession');

  const { note, warn } = createLaneLog({ prefix: '[visions]', logger });

  function spawnWithTimeout({
    id, name, cwd, uri, resultPath, lineCount, onPending = null,
  }) {
    const startedAt = nowFn();
    const elapsed = () => nowFn() - startedAt;
    return raceWithAbort({
      timeoutMs: timeoutSeconds * 1000,
      setTimeoutFn,
      clearTimeoutFn,
      onPending,
      onTimeout: () => {
        warn(`dispatch for ${uri} timed out after ${elapsed()}ms`);
        return errorResult('dispatch timed out');
      },
      onEmpty: () => errorResult('no verdict'),
      start: (signal) => Promise.resolve(spawnSession({
        id, name, cwd, model, signal, initialPrompt: VISIONS_BOOTSTRAP_PROMPT,
      }))
        .then(async () => {
          if (signal.aborted) {
            note(`dispatch for ${uri} was aborted after ${elapsed()}ms`);
            return undefined;
          }
          // Zero whenever the read never got that far, or an injected reader does not report it.
          let bytesRead = 0;
          const result = await readResult(resultPath, { lineCount, onBytesRead: (bytes) => { bytesRead = bytes; } });
          note(`dispatch result for ${uri}: ${result.verdict} (${bytesRead} bytes, ${elapsed()}ms)`);
          return result;
        })
        .catch((error) => errorResult(firstLine(error.message))),
    });
  }

  return async function dispatch({ uri, text, findings = [], intent = '', digest = '', memory = null, prompt = null }) {
    let workDir = null;
    try {
      workDir = await makeWorkDir();
    } catch (error) {
      return errorResult(`no work dir: ${firstLine(error.message)}`);
    }
    const resultPath = path.join(workDir, RESULT_FILE);
    let pendingSpawn = null;
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
      return errorResult(firstLine(error.message));
    } finally {
      // A timeout resolves the verdict while the killed session still holds this dir as its cwd, and removing it under a live process leaks it on Windows.
      await drainPending(pendingSpawn);
      await removeWorkDir(workDir);
    }
  };
}

module.exports = {
  VISIONS_DENY_TOOLS,
  PROMPT_FILE,
  RESULT_FILE,
  VISIONS_BOOTSTRAP_PROMPT,
  visionsPermissions,
  createVisionsDispatcher,
  createVisionsSpawn,
  readCommentsResult,
};
