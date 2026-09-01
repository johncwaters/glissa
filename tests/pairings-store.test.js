'use strict';

// Round-trips the pairings file in a temp dir. Never touches ~/.glissa.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createPairingsStore, createSeenStore, defaultPairingsPath, defaultSeenPath, pairingsSignature,
  SNAPSHOT_RELOAD_MS, REVOCATION_PROPAGATION_SECONDS,
} = require('../server/pairings-store.ts');
const { hashSecret } = require('../server/core/pairing-token.ts');

function withTempStore(run, { clock } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-pairings-'));
  const filePath = path.join(dir, 'pairings.json');
  const warnings = [];
  try {
    const store = createPairingsStore({
      filePath,
      now: clock || Date.now,
      warn: (msg) => warnings.push(msg),
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
    const minted = store.mintPending({ name: 'phone' });
    assert.equal(typeof minted.token, 'string');
    const raw = fs.readFileSync(filePath, 'utf8');
    assert.equal(raw.includes(minted.token), false, 'the plaintext token is never persisted');
    const doc = JSON.parse(raw);
    assert.equal(doc.version, 1);
    assert.equal(doc.pending.length, 1);
    assert.equal(doc.pending[0].tokenHash, hashSecret(minted.token));
    assert.equal(doc.pending[0].name, 'phone');
    assert.equal(doc.pending[0].usedAt, null);
  });
});

test('no temp file is left behind by a write', () => {
  withTempStore(({ store, dir }) => {
    store.mintPending({ name: 'phone' });
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp.'));
    assert.deepEqual(leftovers, []);
  });
});

test('redeem mints a device, marks the token used, and is single use', () => {
  withTempStore(({ store, filePath }) => {
    const minted = store.mintPending({ name: 'phone' });
    const first = store.redeem(minted.token);
    assert.equal(first.ok, true);
    assert.equal(first.device.name, 'phone');
    assert.equal(typeof first.cookieValue, 'string');
    assert.equal(first.cookieValue.startsWith(`${first.device.id}.`), true);

    const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(typeof doc.pending[0].usedAt, 'number');
    assert.equal(doc.devices.length, 1);
    assert.equal(doc.devices[0].secretHash.length, 64);
    assert.equal(fs.readFileSync(filePath, 'utf8').includes(first.cookieValue), false, 'the cookie value is never persisted');

    const replay = store.redeem(minted.token);
    assert.deepEqual({ ok: replay.ok, reason: replay.reason }, { ok: false, reason: 'used' });
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).devices.length, 1, 'no second device from a replay');
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
    const minted = store.mintPending({ name: 'phone' });
    clockValue = minted.expiresAt + 1;
    const outcome = store.redeem(minted.token);
    assert.deepEqual({ ok: outcome.ok, reason: outcome.reason }, { ok: false, reason: 'expired' });
  }, { clock: () => clockValue });
});

test('redeem falls back to the user-agent name when the mint had none', () => {
  withTempStore(({ store }) => {
    const minted = store.mintPending({});
    const outcome = store.redeem(minted.token, { fallbackName: 'iPhone' });
    assert.equal(outcome.device.name, 'iPhone');
  });
});

test('findDevice reads the in-memory snapshot and revokeDevice updates it', () => {
  withTempStore(({ store }) => {
    const minted = store.mintPending({ name: 'phone' });
    const { device } = store.redeem(minted.token);
    assert.equal(store.findDevice(device.id).id, device.id);
    assert.equal(store.findDevice(device.id).revokedAt, null);

    assert.deepEqual(store.revokeDevice(device.id), { ok: true, reason: null });
    assert.equal(typeof store.findDevice(device.id).revokedAt, 'number');
    assert.deepEqual(store.revokeDevice('no-such-device'), { ok: false, reason: 'unknown' });
  });
});

test('a revoked device stays listed, so the operator can still see it', () => {
  withTempStore(({ store }) => {
    const minted = store.mintPending({ name: 'phone' });
    const { device } = store.redeem(minted.token);
    store.revokeDevice(device.id);
    const listed = store.listDevices();
    assert.equal(listed.length, 1);
    assert.equal(typeof listed[0].revokedAt, 'number');
  });
});

test('prunePending drops expired and used records, keeping live ones', () => {
  let clockValue = 1000;
  withTempStore(({ store, filePath }) => {
    const stale = store.mintPending({ name: 'stale' });
    clockValue = stale.expiresAt + 1;
    const fresh = store.mintPending({ name: 'fresh' });
    // The mint itself already prunes; assert the explicit call is idempotent and correct.
    assert.equal(store.prunePending(), 0);
    const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(doc.pending.length, 1);
    assert.equal(doc.pending[0].tokenHash, hashSecret(fresh.token));
  }, { clock: () => clockValue });
});

test('a corrupt file fails CLOSED: no devices, and writes are refused rather than clobbering it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-pairings-bad-'));
  const filePath = path.join(dir, 'pairings.json');
  fs.writeFileSync(filePath, '{ this is not json', 'utf8');
  const warnings = [];
  try {
    const store = createPairingsStore({ filePath, warn: (m) => warnings.push(m) });
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
    const minted = store.mintPending({ name: 'phone' });
    assert.equal(typeof minted.token, 'string');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('save re-reads before writing, so a concurrent revocation is not clobbered by a stale snapshot', () => {
  withTempStore(({ store, filePath }) => {
    const minted = store.mintPending({ name: 'phone' });
    const { device } = store.redeem(minted.token);

    // Simulate the CLI revoking while the server holds an older snapshot in memory.
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    onDisk.devices[0].revokedAt = 12345;
    fs.writeFileSync(filePath, JSON.stringify(onDisk, null, 2), 'utf8');

    const second = store.mintPending({ name: 'laptop' });
    assert.equal(typeof second.token, 'string');
    const after = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(after.devices.find((d) => d.id === device.id).revokedAt, 12345, 'the external revocation survived');
  });
});

test('watch refreshes the snapshot after an external write and the closer stops it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-pairings-watch-'));
  const filePath = path.join(dir, 'pairings.json');
  try {
    const writer = createPairingsStore({ filePath });
    const minted = writer.mintPending({ name: 'phone' });
    const { device } = writer.redeem(minted.token);

    const reader = createPairingsStore({ filePath });
    assert.equal(reader.findDevice(device.id).revokedAt, null);

    const changed = new Promise((resolve) => {
      const stop = reader.watch(() => { stop(); resolve(); });
      setTimeout(() => writer.revokeDevice(device.id), 30);
    });
    await changed;
    assert.equal(typeof reader.findDevice(device.id).revokedAt, 'number', 'revocation propagated without a restart');
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
    const minted = writer.mintPending({ name: 'phone' });
    const { device } = writer.redeem(minted.token);

    const reader = createPairingsStore({ filePath });
    // Stopping the watcher reproduces the failure mode: the fast path is gone and the periodic
    // reload is the only thing left. The next test pins that the interval really is wired to load().
    const stop = reader.watch(() => {});
    stop();

    writer.revokeDevice(device.id);
    assert.equal(reader.findDevice(device.id).revokedAt, null, 'the stale snapshot still says active');
    reader.load();
    assert.equal(typeof reader.findDevice(device.id).revokedAt, 'number', 'a reload applies the revocation');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('watch installs one reload interval at SNAPSHOT_RELOAD_MS, unref-ed and cleared by the closer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-pairings-timers-'));
  const filePath = path.join(dir, 'pairings.json');
  const intervals = [];
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  global.setInterval = (fn, ms) => {
    const handle = realSetInterval(fn, ms);
    const entry = { ms, handle, callback: fn, unrefCalled: false, cleared: false };
    const realUnref = handle.unref.bind(handle);
    handle.unref = () => { entry.unrefCalled = true; return realUnref(); };
    intervals.push(entry);
    return handle;
  };
  global.clearInterval = (handle) => {
    const entry = intervals.find((c) => c.handle === handle);
    if (entry) entry.cleared = true;
    return realClearInterval(handle);
  };
  try {
    const writer = createPairingsStore({ filePath });
    const minted = writer.mintPending({ name: 'phone' });
    const { device } = writer.redeem(minted.token);

    const reader = createPairingsStore({ filePath });
    const stop = reader.watch(() => {});
    assert.equal(intervals.length, 1, 'exactly one reload interval');
    assert.equal(intervals[0].ms, SNAPSHOT_RELOAD_MS);
    assert.equal(intervals[0].unrefCalled, true, 'unref-ed so it never holds the process open');

    // Fire the interval body directly instead of waiting 30 seconds for it.
    writer.revokeDevice(device.id);
    intervals[0].callback();
    assert.equal(typeof reader.findDevice(device.id).revokedAt, 'number', 'the interval refreshes the snapshot');

    stop();
    assert.equal(intervals[0].cleared, true);
  } finally {
    global.setInterval = realSetInterval;
    global.clearInterval = realClearInterval;
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
    const minted = writer.mintPending({ name: 'phone' });
    const { device } = writer.redeem(minted.token);

    const reader = createPairingsStore({ filePath });
    let changes = 0;
    const stop = reader.watch(() => { changes += 1; });
    try {
      // A byte-identical rewrite of the same content, exactly what an interval tick sees.
      const raw = fs.readFileSync(filePath, 'utf8');
      fs.writeFileSync(filePath, raw, 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(changes, 0, 'no change reported for identical content');

      writer.revokeDevice(device.id);
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(changes, 1, 'a real revocation still reports exactly once');
      assert.equal(typeof reader.findDevice(device.id).revokedAt, 'number', 'and propagated to the snapshot');
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
    const minted = store.mintPending({ name: 'phone' });
    const { device } = store.redeem(minted.token);
    const before = fs.readFileSync(filePath, 'utf8');

    // Exactly what a concurrent CLI would leave behind mid-write.
    fs.writeFileSync(`${filePath}.lock`, '', 'utf8');
    try {
      assert.deepEqual(store.revokeDevice(device.id), { ok: false, reason: 'write-failed' });
      assert.equal(fs.readFileSync(filePath, 'utf8'), before, 'the contended write touched nothing');
      assert.equal(warnings.some((w) => /lock/i.test(w)), true);
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

    const minted = store.mintPending({ name: 'phone' });
    assert.equal(typeof minted.token, 'string', 'the stale lock was removed and the write proceeded');
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
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8'))['device-1'], 1000);

    clockValue = 2000;
    seen.touch('device-1');
    await seen.pending;
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8'))['device-1'], 1000, 'throttled inside the window');

    clockValue = 1000 + 60001;
    seen.touch('device-1');
    await seen.pending;
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8'))['device-1'], clockValue);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
