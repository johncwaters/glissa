import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Session } from '../session/sessions.ts';
import { awaitBounded } from './core/shutdown-core.ts';
import { firstLine } from './core/text-core.ts';

const JOB_RESULT_FILENAME = 'result.json';

const ABORT_REAP_CAP_MS = 3000;

interface SpawnGate {
  run: (task: () => unknown) => Promise<unknown>;
}

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
        onAbort = () => {
          try { sess.destroy(); } catch {  }
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
    if (signal && onAbort) { try { signal.removeEventListener('abort', onAbort); } catch {  } }
  }
}

async function raceWithAbort<T>({
  start, timeoutMs, onTimeout, onEmpty,
  setTimeoutFn = (fn, ms) => setTimeout(fn, ms), clearTimeoutFn = clearTimeout,
  onPending = null,
}: {
  start: (signal: AbortSignal) => Promise<T | null | undefined>;
  timeoutMs: number;
  onTimeout: () => T;
  onEmpty: () => T;

  setTimeoutFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutFn?: (handle: NodeJS.Timeout) => void;
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

  if (typeof onPending === 'function') onPending(started);
  const result = await Promise.race([started, timeout]);
  if (handle) clearTimeoutFn(handle);
  return result || onEmpty();
}

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

async function createJobResultFile(prefix: unknown): Promise<JobResultFile> {
  const safePrefix = String(prefix).replace(/[^\w.-]+/g, '-');
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `${safePrefix}-`));
  return {
    path: path.join(dir, JOB_RESULT_FILENAME),
    async cleanup() {
      try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch {  }
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
    try { fs.rmSync(resultPath, { force: true }); } catch {  }
  }
}

type RecordLane = (sessionId: string, lane: string, vendor?: string) => void;

interface RegisterableSession {
  on(event: 'claude-session-id', listener: (payload: { id: string; vendor?: string }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: () => void): unknown;
  destroy: () => void;
}

function registerEphemeralSession({ map, id, sess, closeSessionDataClients, logPrefix, name, recordLane = null }: {
  map: Map<string, unknown>;
  id: string;
  sess: RegisterableSession;
  closeSessionDataClients: (id: string) => void;
  logPrefix: string;
  name: string;
  recordLane?: RecordLane | null;
}): void {
  map.set(id, sess);

  if (typeof recordLane === 'function') {
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
export type {
  JobResultFile, RecordLane, RegisterableSession, ResultDecorator, ResultFileOutcome, ResultValidator, SpawnGate,
};
