'use strict';

/*
 * The scaffolding every ephemeral lane (pr-review, posthog, pack-distill, visions) shares: the map
 * registration, the wait-for-exit, the hard-timeout race, and the file-borne verdict reader. Each lane
 * keeps its own prompts, verdict sets and fallback wording; only the mechanics live here.
 */

const fs = require('node:fs');

function firstLine(text) {
  return String(text == null ? '' : text).split(/\r?\n/)[0].trim();
}

/**
 * Wait for a seeded session to exit, honoring an AbortSignal (a lane's hard timeout) by destroying it.
 * Rejects only when the Session itself errors. With no spawn gate the start still runs off a microtask,
 * so a synchronous throw reaches the same rejection path.
 */
async function awaitSessionExit(sess, { signal = null, spawnGate = null } = {}) {
  let onAbort = null;
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const done = () => { if (settled) return; settled = true; resolve(); };
      const fail = (error) => { if (settled) return; settled = true; reject(error); };
      sess.on('exit', done);
      sess.on('error', fail);
      if (signal) {
        onAbort = () => { try { sess.destroy(); } catch { /* already gone */ } done(); };
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
  const result = await Promise.race([start(controller.signal), timeout]);
  if (handle) clearTimeoutFn(handle);
  return result || onEmpty();
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
  awaitSessionExit, firstLine, raceWithAbort, readResultFile, registerEphemeralSession,
};
