// Round-trips the pairings file in a temp dir. Never touches ~/.glissa.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createPairingsStore, createSeenStore, defaultPairingsPath, defaultSeenPath, pairingsSignature,
  SNAPSHOT_RELOAD_MS, REVOCATION_PROPAGATION_SECONDS,
} from '../server/pairings-store.ts';
import type { PairedDevice, PairingsStore } from '../server/pairings-store.ts';
import { hashSecret } from '../server/core/pairing-token.ts';

interface InstalledInterval {
  ms: number | undefined;
  handle: NodeJS.Timeout;
  callback: () => void;
  unrefCalled: boolean;
  cleared: boolean;
}

interface StoreScope {
  store: PairingsStore;
  filePath: string;
  dir: string;
  warnings: string[];
}

// mintPending answers null when the file is unwritable, and redeem answers a device only on success, so
// the happy-path tests state that once here rather than at every call.
function mintedToken(store: PairingsStore, name?: string): { token: string; expiresAt: number } {
  const minted = store.mintPending(name === undefined ? {} : { name });
  if (!minted) throw new Error('the mint was refused');
  return minted;
}

function redeemedDevice(store: PairingsStore, token: string, options?: { fallbackName?: string }): PairedDevice {
  const outcome = store.redeem(token, options);
  if (!outcome.device) throw new Error(`the redemption was refused: ${outcome.reason}`);
  return outcome.device;
}

function device(store: PairingsStore, id: string): PairedDevice {
  const found = store.findDevice(id);
  if (!found) throw new Error(`no device ${id}`);
  return found;
}

function readDoc(filePath: string): { version?: unknown; pending: Record<string, unknown>[]; devices: Record<string, unknown>[] } {
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) throw new Error('the pairings file is not a JSON object');
  const { version, pending, devices } = parsed as { version?: unknown; pending?: unknown; devices?: unknown };
  if (!Array.isArray(pending) || !Array.isArray(devices)) throw new Error('the pairings file carries no arrays');
  return { version, pending, devices };
}

function readSeen(filePath: string): Record<string, number> {
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) throw new Error('the seen file is not a JSON object');
  return parsed as Record<string, number>;
}

function withTempStore<T>(run: (scope: StoreScope) => T, { clock }: { clock?: () => number } = {}): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-pairings-'));
  const filePath = path.join(dir, 'pairings.json');
  const warnings: string[] = [];
  try {
    const store = createPairingsStore({
      filePath,
      now: clock || Date.now,
      warn: (message) => warnings.push(message),
    });
    return run({ store, filePath, dir, warnings });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a missing file loads as empty rather than throwing', () => {
  withTempStore(({ store }) => {
    assert.deepEqual(store.listDevices(), []);
    assert.equal(store.findDevice('anything'), null);
  });
});

test('mint writes an atomic file holding only the token HASH', () => {
  withTempStore(({ store, filePath }) => {
    const minted = mintedToken(store, 'phone');
    const raw = fs.readFileSync(filePath, 'utf8');
    assert.equal(raw.includes(minted.token), false, 'the plaintext token is never persisted');
    const doc = readDoc(filePath);
    assert.equal(doc.version, 1);
    assert.equal(doc.pending.length, 1);
    assert.equal(doc.pending[0]?.tokenHash, hashSecret(minted.token));
    assert.equal(doc.pending[0]?.name, 'phone');
    assert.equal(doc.pending[0]?.usedAt, null);
  });
});

test('no temp file is left behind by a write', () => {
  withTempStore(({ store, dir }) => {
    store.mintPending({ name: 'phone' });
    const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp.'));
    assert.deepEqual(leftovers, []);
  });
});

test('redeem mints a device, marks the token used, and is single use', () => {
  withTempStore(({ store, filePath }) => {
    const minted = mintedToken(store, 'phone');
    const first = store.redeem(minted.token);
    assert.equal(first.ok, true);
    assert.ok(first.device, 'a device was minted');
    assert.equal(first.device.name, 'phone');
    const cookieValue = first.cookieValue;
    assert.ok(cookieValue, 'a cookie value was issued');
    assert.equal(cookieValue.startsWith(`${first.device.id}.`), true);

    const doc = readDoc(filePath);
    assert.equal(typeof doc.pending[0]?.usedAt, 'number');
    assert.equal(doc.devices.length, 1);
    assert.equal(String(doc.devices[0]?.secretHash).length, 64);
    assert.equal(fs.readFileSync(filePath, 'utf8').includes(cookieValue), false, 'the cookie value is never persisted');

    const replay = store.redeem(minted.token);
    assert.deepEqual({ ok: replay.ok, reason: replay.reason }, { ok: false, reason: 'used' });
    assert.equal(readDoc(filePath).devices.length, 1, 'no second device from a replay');
  });
});

test('an unknown token is rejected without writing anything', () => {
  withTempStore(({ store, filePath }) => {
    store.mintPending({ name: 'phone' });
    const before = fs.readFileSync(filePath, 'utf8');
    const outcome = store.redeem('not-a-real-token');
    assert.deepEqual({ ok: outcome.ok, reason: outcome.reason }, { ok: false, reason: 'unknown' });
    assert.equal(fs.readFileSync(filePath, 'utf8'), before, 'a rejected redemption leaves the file untouched');
  });
});

test('an expired token is rejected', () => {
  let clockValue = 1000;
  withTempStore(({ store }) => {
    const minted = mintedToken(store, 'phone');
    clockValue = minted.expiresAt + 1;
    const outcome = store.redeem(minted.token);
    assert.deepEqual({ ok: outcome.ok, reason: outcome.reason }, { ok: false, reason: 'expired' });
  }, { clock: () => clockValue });
});

test('redeem falls back to the user-agent name when the mint had none', () => {
  withTempStore(({ store }) => {
    const minted = mintedToken(store);
    assert.equal(redeemedDevice(store, minted.token, { fallbackName: 'iPhone' }).name, 'iPhone');
  });
});

test('findDevice reads the in-memory snapshot and revokeDevice updates it', () => {
  withTempStore(({ store }) => {
    const paired = redeemedDevice(store, mintedToken(store, 'phone').token);
    assert.equal(device(store, paired.id).id, paired.id);
    assert.equal(device(store, paired.id).revokedAt, null);

    assert.deepEqual(store.revokeDevice(paired.id), { ok: true, reason: null });
    assert.equal(typeof device(store, paired.id).revokedAt, 'number');
    assert.deepEqual(store.revokeDevice('no-such-device'), { ok: false, reason: 'unknown' });
  });
});

test('a revoked device stays listed, so the operator can still see it', () => {
  withTempStore(({ store }) => {
    const paired = redeemedDevice(store, mintedToken(store, 'phone').token);
    store.revokeDevice(paired.id);
    const listed = store.listDevices();
    assert.equal(listed.length, 1);
    assert.equal(typeof listed[0]?.revokedAt, 'number');
  });
});

test('prunePending drops expired and used records, keeping live ones', () => {
  let clockValue = 1000;
  withTempStore(({ store, filePath }) => {
    const stale = mintedToken(store, 'stale');
    clockValue = stale.expiresAt + 1;
    const fresh = mintedToken(store, 'fresh');
    // The mint itself already prunes; assert the explicit call is idempotent and correct.
    assert.equal(store.prunePending(), 0);
    const doc = readDoc(filePath);
    assert.equal(doc.pending.length, 1);
    assert.equal(doc.pending[0]?.tokenHash, hashSecret(fresh.token));
  }, { clock: () => clockValue });
});

test('a corrupt file fails CLOSED: no devices, and writes are refused rather than clobbering it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-pairings-bad-'));
  const filePath = path.join(dir, 'pairings.json');
  fs.writeFileSync(filePath, '{ this is not json', 'utf8');
  const warnings: string[] = [];
  try {
    const store = createPairingsStore({ filePath, warn: (message) => warnings.push(message) });
    assert.deepEqual(store.listDevices(), [], 'no devices means every remote request is refused');
    assert.equal(store.findDevice('anything'), null);
    assert.equal(store.mintPending({ name: 'x' }), null);
    assert.deepEqual(store.revokeDevice('x'), { ok: false, reason: 'write-failed' });
    assert.equal(fs.readFileSync(filePath, 'utf8'), '{ this is not json', 'the unreadable file is left intact');
    assert.equal(warnings.length > 0, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a structurally wrong file (arrays missing) degrades to empty instead of throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-pairings-shape-'));
  const filePath = path.join(dir, 'pairings.json');
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, devices: 'nope' }), 'utf8');
  try {
    const store = createPairingsStore({ filePath });
    assert.deepEqual(store.listDevices(), []);
    assert.equal(typeof mintedToken(store, 'phone').token, 'string');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('save re-reads before writing, so a concurrent revocation is not clobbered by a stale snapshot', () => {
  withTempStore(({ store, filePath }) => {
    const paired = redeemedDevice(store, mintedToken(store, 'phone').token);

    // Simulate the CLI revoking while the server holds an older snapshot in memory.
    const onDisk = readDoc(filePath);
    const stored = onDisk.devices[0];
    assert.ok(stored, 'the redeemed device was persisted');
    stored.revokedAt = 12345;
    fs.writeFileSync(filePath, JSON.stringify(onDisk, null, 2), 'utf8');

    assert.equal(typeof mintedToken(store, 'laptop').token, 'string');
    const after = readDoc(filePath);
    assert.equal(after.devices.find((row) => row.id === paired.id)?.revokedAt, 12345, 'the external revocation survived');
  });
});

test('watch refreshes the snapshot after an external write and the closer stops it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-pairings-watch-'));
  const filePath = path.join(dir, 'pairings.json');
  try {
    const writer = createPairingsStore({ filePath });
    const paired = redeemedDevice(writer, mintedToken(writer, 'phone').token);

    const reader = createPairingsStore({ filePath });
    assert.equal(device(reader, paired.id).revokedAt, null);

    const changed = new Promise<void>((resolve) => {
      const stop = reader.watch(() => { stop(); resolve(); });
      setTimeout(() => writer.revokeDevice(paired.id), 30);
    });
    await changed;
    assert.equal(typeof device(reader, paired.id).revokedAt, 'number', 'revocation propagated without a restart');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Auth reads only ever see the in-memory snapshot, so a watcher that never installed (no inotify, an
// exhausted watch limit) or was silently dropped would keep honoring a revoked cookie until restart.
test('a periodic reload bounds revocation propagation even with no working watcher', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-pairings-interval-'));
  const filePath = path.join(dir, 'pairings.json');
  try {
    const writer = createPairingsStore({ filePath });
    const paired = redeemedDevice(writer, mintedToken(writer, 'phone').token);

    const reader = createPairingsStore({ filePath });
    // Stopping the watcher reproduces the failure mode: the fast path is gone and the periodic
    // reload is the only thing left. The next test pins that the interval really is wired to load().
    const stop = reader.watch(() => {});
    stop();

    writer.revokeDevice(paired.id);
    assert.equal(device(reader, paired.id).revokedAt, null, 'the stale snapshot still says active');
    reader.load();
    assert.equal(typeof device(reader, paired.id).revokedAt, 'number', 'a reload applies the revocation');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('watch installs one reload interval at SNAPSHOT_RELOAD_MS, unref-ed and cleared by the closer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-pairings-timers-'));
  const filePath = path.join(dir, 'pairings.json');
  const intervals: InstalledInterval[] = [];
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  // The one cast in this suite: globalThis.setInterval carries both the DOM overload (returns number) and
  // the Node one (returns Timeout), so no single function satisfies the declared type. The delegate below
  // is behaviourally the real thing, and the store's interval is not injectable.
  globalThis.setInterval = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const handle = realSetInterval(callback, ms, ...args);
    const entry: InstalledInterval = { ms, handle, callback: () => callback(...args), unrefCalled: false, cleared: false };
    const realUnref = handle.unref.bind(handle);
    handle.unref = () => {
      entry.unrefCalled = true;
      return realUnref();
    };
    intervals.push(entry);
    return handle;
  }) as typeof globalThis.setInterval;
  globalThis.clearInterval = (handle?: NodeJS.Timeout | string | number) => {
    const entry = intervals.find((candidate) => candidate.handle === handle);
    if (entry) entry.cleared = true;
    realClearInterval(handle);
  };
  try {
    const writer = createPairingsStore({ filePath });
    const paired = redeemedDevice(writer, mintedToken(writer, 'phone').token);

    const reader = createPairingsStore({ filePath });
    const stop = reader.watch(() => {});
    assert.equal(intervals.length, 1, 'exactly one reload interval');
    const installed = intervals[0];
    assert.ok(installed, 'the reload interval was captured');
    assert.equal(installed.ms, SNAPSHOT_RELOAD_MS);
    assert.equal(installed.unrefCalled, true, 'unref-ed so it never holds the process open');

    // Fire the interval body directly instead of waiting 30 seconds for it.
    writer.revokeDevice(paired.id);
    installed.callback();
    assert.equal(typeof device(reader, paired.id).revokedAt, 'number', 'the interval refreshes the snapshot');

    stop();
    assert.equal(installed.cleared, true);
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pairingsSignature ignores formatting and key order, tracks auth-relevant fields', () => {
  const base = { version: 1, pending: [], devices: [{ id: 'd1', secretHash: 'h', revokedAt: null }] };
  const reserialized = JSON.parse(JSON.stringify(base));
  assert.equal(pairingsSignature(base), pairingsSignature(reserialized), 'identical content, one signature');
  assert.notEqual(
    pairingsSignature(base),
    pairingsSignature({ version: 1, pending: [], devices: [{ id: 'd1', secretHash: 'h', revokedAt: 5 }] }),
    'a revocation must change the signature',
  );
  assert.notEqual(
    pairingsSignature(base),
    pairingsSignature({ version: 1, pending: [{ tokenHash: 't' }], devices: base.devices }),
    'a new pending token must change the signature',
  );
  assert.equal(pairingsSignature(null), pairingsSignature(undefined), 'garbage coerces to the empty doc');
});

// An idle server used to announce a change on every 30s tick, writing ~2880 identical log lines a day.
test('an unchanged reload refreshes the snapshot but does NOT report a change', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-pairings-quiet-'));
  const filePath = path.join(dir, 'pairings.json');
  try {
    const writer = createPairingsStore({ filePath });
    const paired = redeemedDevice(writer, mintedToken(writer, 'phone').token);

    const reader = createPairingsStore({ filePath });
    let changes = 0;
    const stop = reader.watch(() => { changes += 1; });
    try {
      // A byte-identical rewrite of the same content, exactly what an interval tick sees.
      const raw = fs.readFileSync(filePath, 'utf8');
      fs.writeFileSync(filePath, raw, 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(changes, 0, 'no change reported for identical content');

      writer.revokeDevice(paired.id);
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(changes, 1, 'a real revocation still reports exactly once');
      assert.equal(typeof device(reader, paired.id).revokedAt, 'number', 'and propagated to the snapshot');
    } finally {
      stop();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The sibling pairings-seen.json (display-only telemetry) is written from the request path and shares
// the directory being watched; on inotify its writes surface as events on that directory.
test('a write to a sibling file in the watched directory reports no change', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-pairings-sibling-'));
  const filePath = path.join(dir, 'pairings.json');
  try {
    const writer = createPairingsStore({ filePath });
    writer.mintPending({ name: 'phone' });

    const reader = createPairingsStore({ filePath });
    let changes = 0;
    const stop = reader.watch(() => { changes += 1; });
    try {
      const seen = createSeenStore({ filePath: path.join(dir, 'pairings-seen.json'), throttleMs: 0 });
      seen.touch('device-1');
      await seen.pending;
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(changes, 0, 'a seen-store write must not look like a device-list change');
    } finally {
      stop();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the propagation figure the CLI quotes matches the reload interval', () => {
  assert.equal(REVOCATION_PROPAGATION_SECONDS, Math.ceil(SNAPSHOT_RELOAD_MS / 1000));
});

test('a write refuses rather than racing while another process holds the lock', () => {
  withTempStore(({ store, filePath, warnings }) => {
    const paired = redeemedDevice(store, mintedToken(store, 'phone').token);
    const before = fs.readFileSync(filePath, 'utf8');

    // Exactly what a concurrent CLI would leave behind mid-write.
    fs.writeFileSync(`${filePath}.lock`, '', 'utf8');
    try {
      assert.deepEqual(store.revokeDevice(paired.id), { ok: false, reason: 'write-failed' });
      assert.equal(fs.readFileSync(filePath, 'utf8'), before, 'the contended write touched nothing');
      assert.equal(warnings.some((message) => /lock/i.test(message)), true);
    } finally {
      fs.unlinkSync(`${filePath}.lock`);
    }
  });
});

test('an abandoned lock is swept, so a crashed writer cannot wedge pairing forever', () => {
  withTempStore(({ store, filePath }) => {
    const lockPath = `${filePath}.lock`;
    fs.writeFileSync(lockPath, '', 'utf8');
    const longAgo = new Date(Date.now() - 60000);
    fs.utimesSync(lockPath, longAgo, longAgo);

    assert.equal(typeof mintedToken(store, 'phone').token, 'string', 'the stale lock was removed and the write proceeded');
    assert.equal(fs.existsSync(lockPath), false, 'and the lock is released afterwards');
  });
});

test('the lock is released after every write, including a declined one', () => {
  withTempStore(({ store, filePath }) => {
    store.mintPending({ name: 'phone' });
    assert.equal(fs.existsSync(`${filePath}.lock`), false);
    store.redeem('not-a-real-token');
    assert.equal(fs.existsSync(`${filePath}.lock`), false, 'a declined write must not leak the lock');
    store.revokeDevice('no-such-device');
    assert.equal(fs.existsSync(`${filePath}.lock`), false);
  });
});

test('pairing files are created 0600 on posix', { skip: process.platform === 'win32' ? 'posix modes only' : false }, () => {
  withTempStore(({ store, filePath }) => {
    store.mintPending({ name: 'phone' });
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  });
});

test('default paths sit beside the config file', () => {
  const configPath = path.join(os.tmpdir(), 'glissa-cfg', 'config.json');
  assert.equal(defaultPairingsPath(configPath), path.join(os.tmpdir(), 'glissa-cfg', 'pairings.json'));
  assert.equal(defaultSeenPath(configPath), path.join(os.tmpdir(), 'glissa-cfg', 'pairings-seen.json'));
});

test('the seen store is throttled, separate, and never consulted for auth', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-seen-'));
  const filePath = path.join(dir, 'pairings-seen.json');
  let clockValue = 1000;
  try {
    const seen = createSeenStore({ filePath, throttleMs: 60000, now: () => clockValue });
    seen.touch('device-1');
    await seen.pending;
    assert.equal(readSeen(filePath)['device-1'], 1000);

    clockValue = 2000;
    seen.touch('device-1');
    await seen.pending;
    assert.equal(readSeen(filePath)['device-1'], 1000, 'throttled inside the window');

    clockValue = 1000 + 60001;
    seen.touch('device-1');
    await seen.pending;
    assert.equal(readSeen(filePath)['device-1'], clockValue);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
