/*
 * Navigator tier 3 dispatch: the IO half of docs/archive/plan-navigator.md M4.
 *
 * Permissions posture, live-probed against the real CLI (2.x):
 *   - NO --dangerously-skip-permissions. The prompt embeds arbitrary buffer text, so the session gets
 *     the least capability that still lets it write its result file.
 *   - `--allowedTools=Write` pre-approves exactly one tool; every other tool needs an approval no
 *     headless session can be given.
 *   - The deny list below is the guard on top of that. Read is deliberately NOT denied: a deny rule
 *     covering a path blocks WRITING it too (probed: a `Read` deny made the result-file write fail),
 *     so denying reads and keeping the result contract are mutually exclusive with this plumbing.
 *   - Path-scoped allow rules do not narrow a file write (the CLI says only `Edit(path)` rules are
 *     matched by file permission checks, and neither form denied a write elsewhere), so the write
 *     boundary is the cwd this module hands the session: a fresh empty temp dir, never a repo.
 */

'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  awaitSessionExit, firstLine, raceWithAbort, registerEphemeralSession,
} = require('./ephemeral-session');
const {
  DEFAULT_TIMEOUT_SECONDS, MAX_HAND_CHARS, buildNavigatorPrompt, countLines, sanitizeComments,
} = require('./core/navigator-dispatch-core');
const { sanitizeIntentText } = require('./core/navigator-intent-core');
const { createLaneLog } = require('./lane-log');

const RESULT_VERDICTS = new Set(['COMMENTS', 'NONE', 'ERROR']);
const RESULT_FILE = 'navigator-result.json';

/*
 * The one tool the session is pre-approved for, and the only action the prompt asks it to take. The
 * `=` form is load-bearing: `--allowedTools` is VARIADIC, so the spaced form swallows the initial
 * prompt that follows it as another tool name and claude exits with "Input must be provided either
 * through stdin or as a prompt argument" (live-probed).
 */
const NAVIGATOR_ALLOWED_TOOLS = 'Write';
const ALLOWED_TOOLS_ARG = `--allowedTools=${NAVIGATOR_ALLOWED_TOOLS}`;

// Verbs a navigator never needs: no shell, no editing, no network, no sub-agents. Bare tool names,
// because a path-scoped rule here would also cover the result file (see the header).
const NAVIGATOR_DENY = {
  deny: ['Bash', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'],
};

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
 * puts a `navigator` row on the Usage tab's lane ledger with no ledger code of its own. Never
 * rejects on an abort; the caller has already resolved that race.
 */
function createNavigatorSpawn({
  sessions = new Map(), closeSessionDataClients = () => {}, hookRouter = null, getHookPort = null,
  spawnGate = null, replayBufferKB = undefined, recordLane = null,
} = {}) {
  return async function spawnNavigatorSession({ id, name, prompt, cwd, model = null, signal = null }) {
    // Required here, not at module load: an inert lane must not pay for resolving `claude` on PATH.
    const { Session } = require('../session/sessions');
    const extraClaudeArgs = ['-p', ALLOWED_TOOLS_ARG];
    if (model) extraClaudeArgs.push('--model', model);
    const sess = new Session({
      id,
      name,
      path: cwd,
      dangerouslySkipPermissions: false,
      extraClaudeArgs,
      initialPrompt: prompt,
      ephemeral: true,
      settingsPermissions: NAVIGATOR_DENY,
      replayBufferKB,
      hookRouter,
      getHookPort,
    });
    registerEphemeralSession({ map: sessions, id, sess, closeSessionDataClients, logPrefix: 'navigator', name, recordLane });

    await awaitSessionExit(sess, { signal, spawnGate });
  };
}

/**
 * One dispatch, end to end: a throwaway cwd, the prompt, the spawn, the timeout race, the result
 * file. Returns { verdict, comments, reason } and never throws, so the wiring's gate logic has a
 * single shape to handle.
 */
function createNavigatorDispatcher({
  spawnSession,
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  model = null,
  logger = console,
  nowFn = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  makeWorkDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'glissa-navigator-')),
  removeWorkDir = async (dir) => { try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* best-effort */ } },
  readResult = readCommentsResult,
  idFor = (uri) => `navigator:${uri}:${Date.now()}`,
} = {}) {
  if (typeof spawnSession !== 'function') throw new Error('createNavigatorDispatcher requires spawnSession');

  const { note, warn } = createLaneLog({ prefix: '[navigator]', logger });

  function spawnWithTimeout({
    id, name, prompt, cwd, uri, resultPath, lineCount,
  }) {
    const startedAt = nowFn();
    const elapsed = () => nowFn() - startedAt;
    return raceWithAbort({
      timeoutMs: timeoutSeconds * 1000,
      setTimeoutFn,
      clearTimeoutFn,
      onTimeout: () => {
        warn(`dispatch for ${uri} timed out after ${elapsed()}ms`);
        return errorResult('dispatch timed out');
      },
      onEmpty: () => errorResult('no verdict'),
      start: (signal) => Promise.resolve(spawnSession({
        id, name, prompt, cwd, model, signal,
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

  return async function dispatch({ uri, text, findings = [], intent = '', digest = '' }) {
    let workDir = null;
    try {
      workDir = await makeWorkDir();
    } catch (error) {
      return errorResult(`no work dir: ${firstLine(error.message)}`);
    }
    const resultPath = path.join(workDir, RESULT_FILE);
    try {
      return await spawnWithTimeout({
        id: idFor(uri),
        name: `navigator ${uri}`,
        prompt: buildNavigatorPrompt({
          uri, text, findings, intent, digest, resultPath,
        }),
        cwd: workDir,
        uri,
        resultPath,
        lineCount: countLines(text),
      });
    } finally {
      await removeWorkDir(workDir);
    }
  };
}

module.exports = {
  ALLOWED_TOOLS_ARG,
  NAVIGATOR_ALLOWED_TOOLS,
  NAVIGATOR_DENY,
  RESULT_FILE,
  createNavigatorDispatcher,
  createNavigatorSpawn,
  readCommentsResult,
};
