'use strict';

/*
 * The scaffolding every ephemeral lane (pr-review, posthog, pack-distill, visions) shares: the map
 * registration, the wait-for-exit, the hard-timeout race, and the file-borne verdict reader. Each lane
 * keeps its own prompts, verdict sets and fallback wording; only the mechanics live here.
 */

const fs = require('node:fs');

const { awaitBounded } = require('./core/shutdown-core');

// How long a timeout-abort waits for the killed PTY tree to actually die before giving up on it. Same
// order as the lifecycle's own reap bound: long enough for taskkill, short enough that a child which
// resists kill cannot pin a lane's concurrency slot.
const ABORT_REAP_CAP_MS = 3000;

function firstLine(text) {
  return String(text == null ? '' : text).split(/\r?\n/)[0].trim();
}

/**
 * Wait for a seeded session to exit, honoring an AbortSignal (a lane's hard timeout) by destroying it.
 * Rejects only when the Session itself errors. With no spawn gate the start still runs off a microtask,
 * so a synchronous throw reaches the same rejection path.
 */
async function awaitSessionExit(sess, { signal = null, spawnGate = null, reapCapMs = ABORT_REAP_CAP_MS } = {}) {
  let onAbort = null;
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const done = () => { if (settled) return; settled = true; resolve(); };
      const fail = (error) => { if (settled) return; settled = true; reject(error); };
      sess.on('exit', done);
      sess.on('error', fail);
      if (signal) {
        /*
         * A timeout-abort must not resolve before the PTY tree it just killed is REAPED. The caller's
         * finally block discards the job's worktree, and on Windows a surviving claude/cmd/conhost
         * holding a handle in that directory makes the discard fail, leaking the checkout and the
         * branch. destroy() starts the taskkill and parks the promise on `_killReap` (sessions.js), so
         * that is what is awaited here - bounded, because a child that resists kill must cost a delay,
         * never the lane's concurrency slot.
         */
        onAbort = () => {
          try { sess.destroy(); } catch { /* already gone */ }
          if (!sess._killReap) { done(); return; }
          void awaitBounded([sess._killReap], { capMs: reapCapMs }).then(done, done);
        };
        if (signal.aborted) onAbort();
        if (!signal.aborted) signal.addEventListener('abort', onAbort, { once: true });
      }
      const run = () => (signal?.aborted ? undefined : sess.start());
      const started = spawnGate ? spawnGate.run(run) : Promise.resolve().then(run);
      started.catch(fail);
    });
  } finally {
    if (signal && onAbort) { try { signal.removeEventListener('abort', onAbort); } catch { /* noop */ } }
  }
}

/**
 * Race `start` against a hard timeout so a hung `claude -p` can never pin a lane's concurrency slot.
 * On timeout the signal is aborted (the lane's spawn destroys the session) and `onTimeout()` is the
 * verdict; `onEmpty()` covers a start that resolved nothing at all.
 */
async function raceWithAbort({
  start, timeoutMs, onTimeout, onEmpty, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
  onPending = null,
}) {
  const controller = new AbortController();
  let handle = null;
  const timeout = new Promise((resolve) => {
    handle = setTimeoutFn(() => {
      controller.abort();
      resolve(onTimeout());
    }, timeoutMs);
    if (handle && typeof handle.unref === 'function') handle.unref();
  });
  const started = start(controller.signal);
  /*
   * A timeout resolves the VERDICT the moment it fires, which is the point: a hung job must free its
   * concurrency slot at once, not one reap later. But the aborted session is still being killed for a
   * moment afterwards, so a caller with cleanup that cannot run under a live process - discarding the
   * job's worktree - takes the start promise here and drains it first, with drainPending below.
   */
  if (typeof onPending === 'function') onPending(started);
  const result = await Promise.race([started, timeout]);
  if (handle) clearTimeoutFn(handle);
  return result || onEmpty();
}

/**
 * Wait for an aborted job's start promise to settle before cleaning up under it. awaitSessionExit is
 * what makes that mean "the killed PTY tree has been reaped", which on Windows is what keeps a
 * surviving claude/cmd/conhost from holding a handle in the worktree the caller is about to discard.
 *
 * Bounded on REAL timers, deliberately not a lane's injected timeout seam: that seam is a JOB deadline
 * a test drives by hand, so routing this through it would leave the drain waiting for a callback
 * nobody fires. The bound also has to outlast the reap wait inside awaitSessionExit.
 */
function drainPending(pending, { capMs = ABORT_REAP_CAP_MS + 500 } = {}) {
  if (!pending) return Promise.resolve();
  return awaitBounded([pending], { capMs }).then(() => {});
}

/**
 * Read the verdict a dispatched session wrote to its result file. Missing or invalid means ERROR, so a
 * crashed or confused session never masquerades as a finished job. The file is removed either way.
 * `decorate` adds the per-lane extra fields from the same parsed object.
 */
function readResultFile(resultPath, allowed, decorate = null) {
  try {
    const obj = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    const verdict = String(obj.verdict || '').toUpperCase();
    if (!allowed.has(verdict)) return { verdict: 'ERROR', summary: 'invalid verdict in result file' };
    const result = { verdict, summary: String(obj.summary || '') };
    if (!decorate) return result;
    return { ...result, ...decorate(obj) };
  } catch {
    return { verdict: 'ERROR', summary: 'no result file' };
  } finally {
    try { fs.rmSync(resultPath, { force: true }); } catch { /* best-effort */ }
  }
}

// Register an ephemeral (never persisted) Session in its lane's map with guaranteed cleanup:
// removal + data-client close on 'exit', and a wrapped destroy() because callers'
// removeAllListeners can pre-empt the 'exit' cleanup (every orchestrator/poller finish path
// calls destroy()). logPrefix names the lane in error logs (e.g. 'pr-review', 'posthog').
function registerEphemeralSession({ map, id, sess, closeSessionDataClients, logPrefix, name, recordLane = null }) {
  map.set(id, sess);
  /*
   * Lane attribution. Every ephemeral lane registers here and already names itself via logPrefix, so this is
   * the one place that knows both the lane and the Claude session id it spawned. Hooks do fire for these
   * headless `-p` sessions (live-verified: UserPromptSubmit, Stop and SessionEnd all arrive carrying
   * session_id), which is what makes the lanes attributable at all.
   */
  if (typeof recordLane === 'function') {
    sess.on('claude-session-id', ({ id: claudeSessionId }) => recordLane(claudeSessionId, logPrefix));
  }
  sess.on('error', (err) => console.error(`[${logPrefix} ${name}] error: ${err.message}`));
  const removeFromMap = () => {
    if (map.get(id) === sess) {
      map.delete(id);
      closeSessionDataClients(id);
    }
  };
  sess.on('exit', removeFromMap);
  const origDestroy = sess.destroy.bind(sess);
  sess.destroy = () => { origDestroy(); removeFromMap(); };
}

module.exports = {
  awaitSessionExit, drainPending, firstLine, raceWithAbort, readResultFile, registerEphemeralSession,
};
