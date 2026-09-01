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

const SNAPSHOT_RELOAD_MS = 30000;

const REVOCATION_PROPAGATION_SECONDS = Math.ceil(SNAPSHOT_RELOAD_MS / 1000);

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

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function emptyDoc(): PairingsDocument {
  return { version: 1, pending: [], devices: [] };
}

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

function pairingsSignature(doc: unknown): string {
  const safe = coerceDoc(doc);
  return JSON.stringify(safe);
}

function createPairingsStore({
  filePath = defaultPairingsPath(),
  now = Date.now,
  randomBytes,
  warn = console.warn,
  setIntervalFn = (fn, ms) => setInterval(fn, ms),
  clearIntervalFn = (handle) => clearInterval(handle),
}: {
  filePath?: string;
  now?: () => number;
  randomBytes?: RandomBytes;
  warn?: (message: string) => void;
  setIntervalFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn?: (handle: NodeJS.Timeout) => void;
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
    fs.mkdirSync(path.dirname(pairingsPath), { recursive: true, mode: 0o700 });
  }

  function removeIfStale(): boolean {
    try {
      const stat = fs.statSync(lockPath);
      if (Date.now() - stat.mtimeMs <= LOCK_STALE_MS) return false;
      fs.unlinkSync(lockPath);
      warn('[pairings] Removed a stale write lock left by an earlier process');
      return true;
    } catch {
      return true;
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
    try { fs.unlinkSync(lockPath); } catch {  }
  }

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

  function watch(onChange?: ((snapshot: PairingsDocument) => void) | null): () => void {
    let timer: NodeJS.Timeout | null = null;
    let watcher: fs.FSWatcher | null = null;
    const dir = path.dirname(pairingsPath);

    let lastSignature = pairingsSignature(snapshot);

    function refresh(): void {
      load();
      const signature = pairingsSignature(snapshot);
      if (signature === lastSignature) return;
      lastSignature = signature;
      if (onChange) onChange(snapshot);
    }

    const reloadInterval = setIntervalFn(refresh, SNAPSHOT_RELOAD_MS);
    if (reloadInterval.unref) reloadInterval.unref();

    try {
      ensureDir();

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
      clearIntervalFn(reloadInterval);
      if (watcher) { try { watcher.close(); } catch {  } }
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

  const doc = readAll();

  function touch(deviceId: string): void {
    if (!deviceId) return;
    const at = now();
    const last = lastWriteByDevice.get(deviceId);
    if (last != null && at - last < throttleMs) return;
    lastWriteByDevice.set(deviceId, at);
    doc[deviceId] = at;
    pending = writeJsonAtomic(filePath, doc, { mode: 0o600 })
      .catch(() => {  });
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
