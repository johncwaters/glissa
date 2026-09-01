/*
 * The scaffolding every ephemeral lane (pr-review, posthog, pack-distill, visions) shares: the map
 * registration, the wait-for-exit, the hard-timeout race, and the file-borne verdict reader. Each lane
 * keeps its own prompts, verdict sets and fallback wording; only the mechanics live here.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Session } from '../session/sessions.ts';
import { awaitBounded } from './core/shutdown-core.ts';
import { firstLine } from './core/text-core.ts';

// The fixed name inside a job's private result directory: the directory is already unique, so the file
// inside it carries no identity and never has to be told apart from anything.
const JOB_RESULT_FILENAME = 'result.json';

// How long a timeout-abort waits for the killed PTY tree to actually die before giving up on it. Same
// order as the lifecycle's own reap bound: long enough for a taskkill or a signalled group to settle,
// short enough that a child which resists kill cannot pin a lane's concurrency slot.
const ABORT_REAP_CAP_MS = 3000;

interface SpawnGate {
  run: (task: () => unknown) => Promise<unknown>;
}

/**
 * Wait for a seeded session to exit, honoring an AbortSignal (a lane's hard timeout) by destroying it.
 * Rejects only when the Session itself errors. With no spawn gate the start still runs off a microtask,
 * so a synchronous throw reaches the same rejection path.
 */
async function awaitSessionExit(sess: Session, { signal = null, spawnGate = null, reapCapMs = ABORT_REAP_CAP_MS }: {
  signal?: AbortSignal | null;
  spawnGate?: SpawnGate | null;
  reapCapMs?: number;
} = {}): Promise<void> {
  let onAbort: (() => void) | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = () => { if (settled) return; settled = true; resolve(); };
      const fail = (error: unknown) => { if (settled) return; settled = true; reject(error); };
      sess.on('exit', done);
      sess.on('error', fail);
      if (signal) {
        /*
         * A timeout-abort must not resolve before the PTY tree it just killed is REAPED. The caller's
         * finally block discards the job's worktree, and a survivor still inside it is a problem on
         * either platform: on Windows a claude/cmd/conhost holding a handle makes the discard fail
         * outright, leaking the checkout and the branch, while on POSIX it can still be writing into a
         * tree being removed under it. destroy() starts the kill (taskkill /T /F on Windows, SIGKILL to
         * the process group plus a liveness poll on POSIX) and parks either one on `_killReap`
         * (sessions.ts), so that is what is awaited here - bounded, because a child that resists kill
         * must cost a delay, never the lane's concurrency slot.
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
      const activeSpawnGate = spawnGate;
      const started = activeSpawnGate ? activeSpawnGate.run(run) : Promise.resolve().then(run);
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
async function raceWithAbort<T>({
  start, timeoutMs, onTimeout, onEmpty, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
  onPending = null,
}: {
  // A start that resolves nothing (an aborted spawn) falls through to onEmpty, so the outcome type is
  // the one the two fallbacks name.
  start: (signal: AbortSignal) => Promise<T | null | undefined>;
  timeoutMs: number;
  onTimeout: () => T;
  onEmpty: () => T;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  onPending?: ((promise: Promise<unknown>) => void) | null;
}): Promise<T> {
  const controller = new AbortController();
  let handle: NodeJS.Timeout | null = null;
  const timeout = new Promise<T>((resolve) => {
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
 * what makes that mean "the killed PTY tree has been reaped", which is what keeps a survivor out of the
 * worktree the caller is about to discard: a held handle fails the discard outright on Windows, and a
 * process still writing into a tree being removed is no better on POSIX.
 *
 * Bounded on REAL timers, deliberately not a lane's injected timeout seam: that seam is a JOB deadline
 * a test drives by hand, so routing this through it would leave the drain waiting for a callback
 * nobody fires. The bound also has to outlast the reap wait inside awaitSessionExit.
 */
function drainPending(pending: Promise<unknown> | null | undefined, { capMs = ABORT_REAP_CAP_MS + 500 }: {
  capMs?: number;
} = {}): Promise<void> {
  if (!pending) return Promise.resolve();
  return awaitBounded([pending], { capMs }).then(() => {});
}

interface JobResultFile {
  path: string;
  cleanup(): Promise<void>;
}

/*
 * A private directory for one dispatched job's result file. The agent is TOLD this path, so a
 * predictable name directly under the system temp dir is a symlink-plant target wherever that dir is
 * shared: on a multi-user POSIX host another account can pre-create the path and redirect the write.
 * mkdtemp mints a fresh 0700 directory nobody else can have claimed, and the informative name that used
 * to be the filename rides its prefix instead.
 *
 * cleanup() must run on EVERY exit path of the job, and it is the ONLY way to remove what this minted:
 * the closure is what carries ownership of the directory. A helper taking the path back and deciding
 * from its shape whether the parent is ours would recursively delete any caller-supplied directory
 * whose file happened to be named result.json, which is a trap nobody reading the call site would see.
 */
async function createJobResultFile(prefix: unknown): Promise<JobResultFile> {
  const safePrefix = String(prefix).replace(/[^\w.-]+/g, '-');
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `${safePrefix}-`));
  return {
    path: path.join(dir, JOB_RESULT_FILENAME),
    async cleanup() {
      try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

interface ResultFileOutcome {
  ok?: boolean;
  kind?: string;
  reason?: string;
  verdict: string;
  summary: string;
  [key: string]: unknown;
}

type ResultDecorator = (parsed: Record<string, unknown>) => Record<string, unknown>;
type ResultValidator = (parsed: Record<string, unknown>) => { ok?: boolean; verdict: string; summary: string } | null | undefined;

/**
 * Read the verdict a dispatched session wrote to its result file. Missing or invalid means ERROR, so a
 * crashed or confused session never masquerades as a finished job. The file is removed either way.
 * `decorate` adds the per-lane extra fields from the same parsed object.
 */
function readResultFile(
  resultPath: string,
  allowed: Set<string> | null,
  decorate: ResultDecorator | null = null,
  { maxBytes = null, validate = null }: { maxBytes?: number | null; validate?: ResultValidator | null } = {},
): ResultFileOutcome {
  if (allowed && validate) throw new TypeError('readResultFile accepts allowed or validate, not both');
  const failedRead = (kind: string, reason: string): ResultFileOutcome => (
    { ok: false, kind, reason, verdict: 'ERROR', summary: reason }
  );
  try {
    const fileDescriptor = fs.openSync(resultPath, 'r');
    const chunks: Buffer[] = [];
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let totalBytesRead = 0;
    try {
      while (true) {
        const bytesRead = fs.readSync(fileDescriptor, chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        totalBytesRead += bytesRead;
        if (maxBytes !== null && totalBytesRead > maxBytes) {
          return failedRead('too-large', 'result file is too large');
        }
        chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
      }
    } finally {
      fs.closeSync(fileDescriptor);
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return failedRead('invalid-json', 'invalid JSON in result file');
    }
    if (validate) {
      const validated = validate(obj);
      if (validated && validated.ok !== false) return { ...validated };
      return failedRead('rejected', validated?.summary || 'result file was rejected');
    }
    const verdict = String(obj.verdict || '').toUpperCase();
    if (!allowed || !allowed.has(verdict)) return failedRead('rejected', 'invalid verdict in result file');
    const result = { verdict, summary: String(obj.summary || '') };
    if (!decorate) return result;
    return { ...result, ...decorate(obj) };
  } catch {
    return failedRead('missing', 'no result file');
  } finally {
    try { fs.rmSync(resultPath, { force: true }); } catch { /* best-effort */ }
  }
}

/**
 * The lane ledger's attribution callback. Every ephemeral lane forwards its own copy here, so the
 * signature lives once rather than being re-guessed per lane.
 */
type RecordLane = (sessionId: string, lane: string, vendor?: string) => void;

// Register an ephemeral (never persisted) Session in its lane's map with guaranteed cleanup:
// removal + data-client close on 'exit', and a wrapped destroy() because callers'
// removeAllListeners can pre-empt the 'exit' cleanup (every orchestrator/poller finish path
// calls destroy()). logPrefix names the lane in error logs (e.g. 'pr-review', 'posthog').
function registerEphemeralSession({ map, id, sess, closeSessionDataClients, logPrefix, name, recordLane = null }: {
  map: Map<string, unknown>;
  id: string;
  sess: Session;
  closeSessionDataClients: (id: string) => void;
  logPrefix: string;
  name: string;
  recordLane?: RecordLane | null;
}): void {
  map.set(id, sess);
  /*
   * Lane attribution. Every ephemeral lane registers here and already names itself via logPrefix, so this is
   * the one place that knows both the lane and the Claude session id it spawned. Hooks do fire for these
   * headless `-p` sessions (live-verified: UserPromptSubmit, Stop and SessionEnd all arrive carrying
   * session_id), which is what makes the lanes attributable at all.
   */
  if (typeof recordLane === 'function') {
    // Every ephemeral lane spawns Claude today, so vendor is claude; passed through rather than assumed so
    // a future non-Claude lane records under its own namespace.
    sess.on('claude-session-id', ({ id: claudeSessionId, vendor }) => recordLane(claudeSessionId, logPrefix, vendor));
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

export {
  awaitSessionExit, createJobResultFile, drainPending, firstLine, raceWithAbort, readResultFile,
  registerEphemeralSession, JOB_RESULT_FILENAME,
};
export type { JobResultFile, RecordLane, ResultDecorator, ResultFileOutcome, ResultValidator, SpawnGate };
