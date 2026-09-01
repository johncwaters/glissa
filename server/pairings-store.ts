// Persistence for remote-mode pairing state: ~/.glissa/pairings.json (next to config.json).
//
//   { version: 1,
//     pending: [{ tokenHash, name, createdAt, expiresAt, usedAt }],
//     devices: [{ id, secretHash, name, createdAt, revokedAt }] }
//
// Only hashes live here. Losing this file logs every device out; leaking it grants nothing on its own.
//
// WRITE MODEL: the CLI (`glissa pair`) is the primary writer; the server writes on exactly one path,
// redeeming a pairing token into a device (the redemption has to be durable or the paired phone would
// be logged out by a restart and `pair --list` would not see it). Every write goes through save(),
// which RE-READS the file immediately before writing, exactly like config-store.save: a revocation the
// CLI landed a moment earlier survives a concurrent server-side redemption instead of being clobbered
// by a stale in-memory snapshot. Reads on the request path never touch the disk - they hit the
// snapshot, which a debounced fs.watch refreshes, so a `pair --revoke` propagates without a restart
// and no request handler ever does sync fs (all sessions share one event loop).
//
// FAIL CLOSED: an unreadable or corrupt file yields an EMPTY snapshot (no devices => 401 for every
// remote request), never a permissive one, and blocks writes rather than overwriting data that might
// still be recoverable.

import fs from 'node:fs';
import path from 'node:path';

import { canonicalizePath, equalsIgnoringCaseOnWindows } from '../shared/paths.ts';
import { glissaHomeDir } from './config-store.ts';
import {
  decideRedemption, hashSecret, mintDeviceCredential, mintPairingToken,
} from './core/pairing-token.ts';
import type { RandomBytes } from './core/pairing-token.ts';
import { writeJsonAtomic, writeJsonAtomicSync } from './json-file.ts';

type PendingPairing = {
  tokenHash: string;
  name: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
};

type PairedDevice = {
  id: string;
  secretHash: string;
  name: string;
  createdAt: number;
  revokedAt: number | null;
};

interface PairingsDocument {
  version: number;
  pending: PendingPairing[];
  devices: PairedDevice[];
}

interface RedeemOutcome {
  ok: boolean;
  reason: string | null;
  device: PairedDevice | null;
  cookieValue?: string;
}

interface PairingsStore {
  path: string;
  load(): PairingsDocument;
  save(mutator: (document: PairingsDocument) => boolean): PairingsDocument | null;
  mintPending(options?: { name?: string; ttlMs?: number }): { token: string; expiresAt: number; name: string } | null;
  redeem(token: unknown, options?: { fallbackName?: string }): RedeemOutcome;
  findDevice(id: unknown): PairedDevice | null;
  listDevices(): PairedDevice[];
  revokeDevice(id: string): { ok: boolean; reason: string | null };
  prunePending(): number;
  watch(onChange?: ((snapshot: PairingsDocument) => void) | null): () => void;
  readonly snapshot: PairingsDocument;
}

interface SeenStore {
  touch(deviceId: string): void;
  readAll(): Record<string, number>;
  readonly pending: Promise<void> | null;
}

const EMPTY_DOC: PairingsDocument = { version: 1, pending: [], devices: [] };

// Belt to the fs.watch braces. The watcher is the fast path for propagating a revocation, but its
// install can fail (a platform without inotify, an exhausted watch limit) and a live watcher can be
// silently dropped, and auth reads only ever see the in-memory snapshot - so a lost watcher would
// keep honoring a revoked cookie until the next restart. This interval bounds that at 30 seconds.
const SNAPSHOT_RELOAD_MS = 30000;
// Worst-case revocation propagation the operator is promised (pair-cli prints this number).
const REVOCATION_PROPAGATION_SECONDS = Math.ceil(SNAPSHOT_RELOAD_MS / 1000);

// Cross-process write lock. The CLI and the server both write this file (mint/revoke vs redeem), and
// the re-read inside save() only narrows the last-write-wins window, it does not close it: a CLI
// revocation landing between the server's read and its rename would be lost. O_EXCL on a sidecar
// lockfile closes it. Bounded retries and a staleness sweep mean a crashed writer cannot wedge
// pairing forever, and the whole path is cold (mint, revoke, redeem), never per-request.
const LOCK_SUFFIX = '.lock';
const LOCK_RETRY_MS = 50;
const LOCK_MAX_ATTEMPTS = 10;
const LOCK_STALE_MS = 5000;

function errorLabel(err: unknown): string {
  const failure = (err ?? {}) as { code?: unknown; message?: unknown };
  return String(failure.code || failure.message || err);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Only ever seen under contention on a cold path, and holding the loop is the point: the whole
// read-modify-write has to be atomic against the other process.
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function emptyDoc(): PairingsDocument {
  return { version: 1, pending: [], devices: [] };
}

/** A sibling of an explicitly configured config.json, or the fallback under ~/.glissa. */
function configSiblingPath(configPath: string | null | undefined, name: string): string {
  if (configPath) return path.join(path.dirname(configPath), name);
  return path.join(glissaHomeDir(), name);
}

function defaultPairingsPath(configPath?: string | null): string {
  return configSiblingPath(configPath, 'pairings.json');
}

function defaultSeenPath(configPath?: string | null): string {
  return configSiblingPath(configPath, 'pairings-seen.json');
}

function coerceDoc(parsed: unknown): PairingsDocument {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyDoc();
  const source = parsed as { pending?: unknown; devices?: unknown };
  return {
    version: 1,
    pending: Array.isArray(source.pending)
      ? (source.pending as PendingPairing[]).filter((r) => r && typeof r.tokenHash === 'string')
      : [],
    devices: Array.isArray(source.devices)
      ? (source.devices as PairedDevice[]).filter((r) => r && typeof r.id === 'string')
      : [],
  };
}

/**
 * Cheap content fingerprint of a coerced doc. Taken over the NORMALIZED doc rather than the raw bytes
 * (or an mtime) so re-serialization, a rewrite with identical content, or a touched mtime does not read
 * as a change. Pure.
 */
function pairingsSignature(doc: unknown): string {
  const safe = coerceDoc(doc);
  return JSON.stringify(safe);
}

function createPairingsStore({
  filePath = defaultPairingsPath(),
  now = Date.now,
  randomBytes,
  warn = console.warn,
}: {
  filePath?: string;
  now?: () => number;
  randomBytes?: RandomBytes;
  warn?: (message: string) => void;
} = {}): PairingsStore {
  const pairingsPath = filePath;
  let snapshot = emptyDoc();

  function readDocSync(): { doc: PairingsDocument; missing: boolean; corrupt: boolean } {
    let raw: string;
    try {
      raw = fs.readFileSync(pairingsPath, 'utf8');
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === 'ENOENT') return { doc: emptyDoc(), missing: true, corrupt: false };
      warn(`[pairings] Failed to read ${pairingsPath}: ${errorLabel(err)}`);
      return { doc: emptyDoc(), missing: false, corrupt: true };
    }
    try {
      return { doc: coerceDoc(JSON.parse(raw)), missing: false, corrupt: false };
    } catch (err) {
      warn(`[pairings] Invalid JSON in ${pairingsPath}: ${errorMessage(err)} - treating as no paired devices`);
      return { doc: emptyDoc(), missing: false, corrupt: true };
    }
  }

  function load(): PairingsDocument {
    snapshot = readDocSync().doc;
    return snapshot;
  }

  const lockPath = `${pairingsPath}${LOCK_SUFFIX}`;

  function ensureDir(): void {
    // 0o700: the file holds no plaintext secrets, but the device list is machine-local auth state.
    // Windows ignores the mode entirely, which is harmless.
    fs.mkdirSync(path.dirname(pairingsPath), { recursive: true, mode: 0o700 });
  }

  /** Real wall clock, not the injected `now`: this is compared against a filesystem mtime. */
  function removeIfStale(): boolean {
    try {
      const stat = fs.statSync(lockPath);
      if (Date.now() - stat.mtimeMs <= LOCK_STALE_MS) return false;
      fs.unlinkSync(lockPath);
      warn('[pairings] Removed a stale write lock left by an earlier process');
      return true;
    } catch {
      return true; // the lock vanished under us, which is as good as removing it
    }
  }

  function acquireLock(): boolean {
    for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
      try {
        fs.closeSync(fs.openSync(lockPath, 'wx', 0o600));
        return true;
      } catch (err) {
        if ((err as { code?: unknown } | null)?.code !== 'EEXIST') {
          warn(`[pairings] Could not take the write lock: ${errorLabel(err)}`);
          return false;
        }
      }
      if (removeIfStale()) continue;
      sleepSync(LOCK_RETRY_MS);
    }
    return false;
  }

  function releaseLock(): void {
    try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
  }

  /**
   * Read-modify-write under a cross-process lock, committed by an atomic tmp+rename. Returns the
   * resulting doc, or null when the file was unreadable or the lock could not be taken (writes fail
   * CLOSED rather than racing). A mutator that returns false declines the write (a rejected
   * redemption must not rewrite the file: an identical rewrite still fires the watch refresh on
   * every replay attempt).
   */
  function save(mutator: (document: PairingsDocument) => boolean): PairingsDocument | null {
    try {
      ensureDir();
    } catch (err) {
      warn(`[pairings] Failed to create ${path.dirname(pairingsPath)}: ${errorLabel(err)}`);
      return null;
    }
    if (!acquireLock()) {
      warn('[pairings] Another process holds the pairings write lock - nothing was written');
      return null;
    }
    try {
      // Read INSIDE the lock: the point is that nobody can land a write between this and the rename.
      const { doc, corrupt } = readDocSync();
      if (corrupt) {
        warn('[pairings] Refusing to write over an unreadable pairings file');
        return null;
      }
      if (!mutator(doc)) {
        snapshot = doc;
        return doc;
      }
      writeJsonAtomicSync(pairingsPath, doc, { mode: 0o600 });
      snapshot = doc;
      return doc;
    } catch (err) {
      warn(`[pairings] Failed to write ${pairingsPath}: ${errorLabel(err)}`);
      return null;
    } finally {
      releaseLock();
    }
  }

  function isDeadPending(record: PendingPairing | null | undefined, at: number): boolean {
    if (!record) return true;
    if (record.usedAt) return true;
    return typeof record.expiresAt === 'number' && at > record.expiresAt;
  }

  function mintPending({ name = '', ttlMs }: { name?: string; ttlMs?: number } = {}) {
    const minted = mintPairingToken({ now: now(), ttlMs, randomBytes });
    const written = save((doc) => {
      doc.pending = doc.pending.filter((p) => !isDeadPending(p, now()));
      doc.pending.push({
        tokenHash: minted.tokenHash,
        name: String(name || ''),
        createdAt: minted.createdAt,
        expiresAt: minted.expiresAt,
        usedAt: null,
      });
      return true;
    });
    if (!written) return null;
    return { token: minted.token, expiresAt: minted.expiresAt, name: String(name || '') };
  }

  /**
   * Single-use redemption: marks the pending record used and appends a device in ONE write, so a
   * replayed pairing URL can never mint a second device.
   */
  function redeem(token: unknown, { fallbackName = '' }: { fallbackName?: string } = {}): RedeemOutcome {
    const tokenHash = hashSecret(token);
    let outcome: RedeemOutcome = { ok: false, reason: 'unknown', device: null };
    const written = save((doc) => {
      const record = doc.pending.find((p) => p.tokenHash === tokenHash) || null;
      const verdict = decideRedemption({ record, now: now() });
      if (!verdict.ok) {
        outcome = { ok: false, reason: verdict.reason, device: null };
        return false;
      }
      if (!record) return false;
      const credential = mintDeviceCredential({ randomBytes });
      record.usedAt = now();
      const device: PairedDevice = {
        id: credential.id,
        secretHash: credential.secretHash,
        name: record.name || String(fallbackName || '') || 'unnamed device',
        createdAt: now(),
        revokedAt: null,
      };
      doc.devices.push(device);
      outcome = { ok: true, reason: null, device, cookieValue: credential.cookieValue };
      return true;
    });
    if (!written) return { ok: false, reason: 'write-failed', device: null };
    return outcome;
  }

  /** Snapshot read, no IO: this runs on every remote request. */
  function findDevice(id: unknown): PairedDevice | null {
    if (typeof id !== 'string' || id === '') return null;
    return snapshot.devices.find((d) => d.id === id) || null;
  }

  function listDevices(): PairedDevice[] {
    return snapshot.devices.map((d) => ({ ...d }));
  }

  function revokeDevice(id: string): { ok: boolean; reason: string | null } {
    let found = false;
    const written = save((doc) => {
      const device = doc.devices.find((d) => d.id === id);
      if (!device) return false;
      found = true;
      device.revokedAt = now();
      return true;
    });
    if (!written) return { ok: false, reason: 'write-failed' };
    if (!found) return { ok: false, reason: 'unknown' };
    return { ok: true, reason: null };
  }

  function prunePending(): number {
    const at = now();
    let removed = 0;
    save((doc) => {
      const kept = doc.pending.filter((p) => !isDeadPending(p, at));
      removed = doc.pending.length - kept.length;
      if (removed === 0) return false;
      doc.pending = kept;
      return true;
    });
    return removed;
  }

  /**
   * Keeps the in-memory snapshot current by two independent means: a debounced fs.watch (fast,
   * mirrors configStore.watchForChanges, canonicalizePath included because fs.watch on an 8.3 short
   * path aborts the process from native code) and a low-frequency reload interval that bounds
   * propagation at SNAPSHOT_RELOAD_MS even if the watcher never installs or is silently dropped.
   * Auth reads only ever see this snapshot, so "the watcher died" must not mean "revocations stop".
   * Returns a closer - a leaked watcher or timer keeps the event loop alive and hangs any embedder.
   */
  function watch(onChange?: ((snapshot: PairingsDocument) => void) | null): () => void {
    let timer: NodeJS.Timeout | null = null;
    let watcher: fs.FSWatcher | null = null;
    const dir = path.dirname(pairingsPath);
    // Safe to seed from the snapshot without a fresh read: createPairingsStore calls load()
    // synchronously before returning, so this is the on-disk content as of construction. A change
    // landing between construction and this call is therefore REPORTED by the first refresh, not
    // masked - which is why the seed is not taken after a re-load here.
    let lastSignature = pairingsSignature(snapshot);

    // The snapshot is reloaded on EVERY tick (that unconditional reload is the revocation guarantee),
    // but onChange fires only when the content actually differs. Without this gate the 30s interval
    // announced a change forever - the remote-auth listener logs one line per call, so an idle server
    // wrote "pairings.json changed" 2880 times a day into journalctl.
    function refresh(): void {
      load();
      const signature = pairingsSignature(snapshot);
      if (signature === lastSignature) return;
      lastSignature = signature;
      if (onChange) onChange(snapshot);
    }

    const reloadInterval = setInterval(refresh, SNAPSHOT_RELOAD_MS);
    if (reloadInterval.unref) reloadInterval.unref();

    try {
      ensureDir();
      // Watching the DIRECTORY, not the file: the atomic tmp+rename write replaces the inode, which
      // silently detaches a file watcher after the first write.
      watcher = fs.watch(canonicalizePath(dir), (_event, filename) => {
        if (filename && !equalsIgnoringCaseOnWindows(path.basename(String(filename)), path.basename(pairingsPath))) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(refresh, 200);
        if (timer.unref) timer.unref();
      });
    } catch (err) {
      warn(`[pairings] Failed to watch ${dir}: ${errorMessage(err)} - falling back to the ${REVOCATION_PROPAGATION_SECONDS}s reload interval`);
    }
    return function stop() {
      if (timer) clearTimeout(timer);
      clearInterval(reloadInterval);
      if (watcher) { try { watcher.close(); } catch { /* already closed */ } }
      watcher = null;
    };
  }

  load();

  return {
    path: pairingsPath,
    load, save, mintPending, redeem, findDevice, listDevices, revokeDevice, prunePending, watch,
    get snapshot() { return snapshot; },
  };
}

/**
 * lastSeenAt lives in a SEPARATE server-owned file: it is display-only telemetry, is never consulted
 * by an auth decision, and must not make the server contend with the CLI over pairings.json on every
 * request. Throttled to one write per device per interval and fire-and-forget - a failed write is
 * never surfaced.
 */
function createSeenStore({
  filePath = defaultSeenPath(),
  throttleMs = 60000,
  now = Date.now,
}: { filePath?: string; throttleMs?: number; now?: () => number } = {}): SeenStore {
  const lastWriteByDevice = new Map<string, number>();
  let pending: Promise<void> | null = null;

  function readAll(): Record<string, number> {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, number>;
      return {};
    } catch {
      return {};
    }
  }

  // Read once at construction (cold path) and keep the doc in memory: touch() runs on request
  // handling, where a sync read would block every session on the shared event loop.
  const doc = readAll();

  function touch(deviceId: string): void {
    if (!deviceId) return;
    const at = now();
    const last = lastWriteByDevice.get(deviceId);
    if (last != null && at - last < throttleMs) return;
    lastWriteByDevice.set(deviceId, at);
    doc[deviceId] = at;
    pending = writeJsonAtomic(filePath, doc, { mode: 0o600 })
      .catch(() => { /* display-only telemetry, never fatal */ });
  }

  return { touch, readAll, get pending() { return pending; } };
}

export {
  EMPTY_DOC,
  REVOCATION_PROPAGATION_SECONDS,
  SNAPSHOT_RELOAD_MS,
  configSiblingPath,
  createPairingsStore,
  createSeenStore,
  defaultPairingsPath,
  defaultSeenPath,
  pairingsSignature,
};
export type { PairedDevice, PairingsDocument, PairingsStore, PendingPairing, RedeemOutcome, SeenStore };
