'use strict';

// Lane attribution: which of Glissa's own automation lanes a Claude session belonged to. This is the one
// usage answer that requires having SPAWNED the session, so the join has to be exact: a lane row is only
// ever built from a spawn Glissa recorded, and anything else is `other`.
//
// Three layers here: the pure rollup, the durable ledger's capture-write-prune cycle against a temp dir, and
// the registerEphemeralSession seam every lane goes through.

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  INTERACTIVE_LANE,
  OTHER_LANE,
  laneMapFromLedger,
  laneRollup,
  normalizeLedger,
  pruneLedger,
} = require('../server/core/usage-lane-core.ts');
const { createLaneLedger } = require('../server/usage-lane-ledger');
const { registerEphemeralSession } = require('../server/ephemeral-session.ts');

const NOW = Date.parse('2026-08-19T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function entry({ sessionId, tokens = 100, costUSD = 1, vendor = undefined }) {
  const row = { sessionId, input: tokens, output: 0, cacheCreate: 0, cacheRead: 0, costUSD };
  if (vendor) row.vendor = vendor;
  return row;
}

async function makeTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'glissa-usage-lanes-'));
}

// ── The rollup ──

test('laneRollup joins entries to lanes and counts distinct sessions', () => {
  const lanes = laneMapFromLedger([
    { claudeSessionId: 'a', lane: 'pr-review', ts: 1 },
    { claudeSessionId: 'b', lane: 'pr-review', ts: 2 },
    { claudeSessionId: 'c', lane: INTERACTIVE_LANE, ts: 3 },
  ]);
  const rows = laneRollup([
    entry({ sessionId: 'a', tokens: 100, costUSD: 3 }),
    entry({ sessionId: 'a', tokens: 50, costUSD: 1.2 }),
    entry({ sessionId: 'b', tokens: 10, costUSD: 0.5 }),
    entry({ sessionId: 'c', tokens: 20, costUSD: 0.9 }),
  ], lanes);
  const byLane = new Map(rows.map((row) => [row.lane, row]));
  assert.equal(byLane.get('pr-review').costUSD, 4.7);
  assert.equal(byLane.get('pr-review').tokens, 160);
  // Two distinct ids in that lane, four entries across them: the count says which shape the work was.
  assert.equal(byLane.get('pr-review').sessions, 2);
  assert.equal(byLane.get(INTERACTIVE_LANE).sessions, 1);
  // Biggest spend first, so the expensive lane is the one read.
  assert.equal(rows[0].lane, 'pr-review');
});

// An id Glissa never recorded spawning is `other`, not a guess. Terminal sessions and direct claude runs live
// here, and so does anything from before the ledger existed.
test('an unknown session id is other, never inferred', () => {
  const lanes = laneMapFromLedger([{ claudeSessionId: 'known', lane: 'posthog', ts: 1 }]);
  const rows = laneRollup([
    entry({ sessionId: 'known', costUSD: 1 }),
    entry({ sessionId: 'a-terminal-session', costUSD: 2 }),
    entry({ sessionId: null, costUSD: 3 }),
  ], lanes);
  const byLane = new Map(rows.map((row) => [row.lane, row]));
  assert.equal(byLane.get('posthog').costUSD, 1);
  assert.equal(byLane.get(OTHER_LANE).costUSD, 5, 'both the unknown id and the id-less entry');
  // An entry with no id at all cannot contribute to a session COUNT, only to the totals.
  assert.equal(byLane.get(OTHER_LANE).sessions, 1);
});

// A supervised codex/grok card IS Glissa-spawned now (M5), so a vendor session recorded in the ledger
// attributes to its lane; the composite key is what keeps a codex id from colliding with a claude one. A
// vendor entry Glissa never recorded is `other`, exactly like a terminal claude run.
test('vendor entries attribute by their own composite key, unrecorded ones are other', () => {
  const lanes = laneMapFromLedger([
    { vendor: 'claude', sessionId: 'a', lane: 'pr-review', ts: 1 },
    { vendor: 'codex', sessionId: 'a', lane: INTERACTIVE_LANE, ts: 2 },
  ]);
  const rows = laneRollup([
    entry({ sessionId: 'a', costUSD: 1 }),
    // Same bare id 'a' as the claude one, but a different vendor: the composite key keeps them apart.
    entry({ sessionId: 'a', costUSD: 4, vendor: 'codex' }),
    entry({ sessionId: 'g', costUSD: 9, vendor: 'grok' }),
  ], lanes);
  const byLane = new Map(rows.map((row) => [row.lane, row]));
  assert.equal(byLane.get('pr-review').costUSD, 1);
  assert.equal(byLane.get(INTERACTIVE_LANE).costUSD, 4, 'the recorded codex session, not the claude one');
  // The grok entry was never recorded, so it is other rather than excluded.
  assert.equal(byLane.get(OTHER_LANE).costUSD, 9);
  // An explicit claude vendor still counts: absent and 'claude' mean the same thing.
  const withExplicit = laneRollup([entry({ sessionId: 'a', costUSD: 2, vendor: 'claude' })], lanes);
  assert.equal(withExplicit[0].costUSD, 2);
});

test('laneRollup with no ledger puts everything in other', () => {
  const rows = laneRollup([entry({ sessionId: 'a', costUSD: 1 })], new Map());
  assert.deepEqual(rows.map((row) => row.lane), [OTHER_LANE]);
  assert.deepEqual(laneRollup([], new Map()), []);
  assert.deepEqual(laneRollup(null, null), []);
});

test('normalizeLedger: one lane per id, newest record wins, junk dropped', () => {
  const normalized = normalizeLedger([
    { claudeSessionId: 'a', lane: 'pr-review', ts: 10 },
    { claudeSessionId: 'a', lane: 'interactive', ts: 20 },
    { claudeSessionId: 'b', lane: 'posthog', ts: 5 },
    { claudeSessionId: '', lane: 'posthog', ts: 5 },
    { claudeSessionId: 'c', lane: '', ts: 5 },
    null,
  ]);
  assert.deepEqual(normalized.map((e) => [e.sessionId, e.lane]), [['b', 'posthog'], ['a', 'interactive']]);
  // An older record cannot overwrite a newer one whatever order it arrives in.
  const reversed = normalizeLedger([
    { claudeSessionId: 'a', lane: 'interactive', ts: 20 },
    { claudeSessionId: 'a', lane: 'pr-review', ts: 10 },
  ]);
  assert.equal(reversed[0].lane, 'interactive');
  // Every normalized entry carries a vendor, defaulted to claude for a pre-M5 record.
  assert.ok(normalized.every((e) => e.vendor === 'claude'));
});

test('pruneLedger drops entries past retention but keeps unstamped ones', () => {
  const kept = pruneLedger([
    { claudeSessionId: 'fresh', lane: 'pr-review', ts: NOW - 3 * DAY_MS },
    { claudeSessionId: 'stale', lane: 'pr-review', ts: NOW - 400 * DAY_MS },
    { claudeSessionId: 'unstamped', lane: 'posthog' },
  ], { now: NOW, retainDays: 365 });
  const ids = kept.map((e) => e.sessionId).sort();
  assert.deepEqual(ids, ['fresh', 'unstamped'], 'losing an attribution is worse than keeping a stale one');
  // With no usable retention nothing is dropped: history is the unrecoverable thing here.
  assert.equal(pruneLedger([{ claudeSessionId: 'x', lane: 'y', ts: 1 }], {}).length, 1);
});

// ── The durable ledger ──

test('the ledger records a lane and persists it atomically', async () => {
  const root = await makeTempRoot();
  const ledgerPath = path.join(root, '.glissa', 'usage-lanes.json');
  const ledger = createLaneLedger({ ledgerPath, nowFn: () => NOW });
  ledger.record('claude-1', 'pr-review');
  ledger.record('claude-2', INTERACTIVE_LANE);
  // record() is fire and forget by design (it sits on the hook callback path); whenIdle is the settle seam.
  await ledger.whenIdle();

  const stored = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
  assert.equal(stored.version, 1);
  // The persisted shape is the M5 one: a vendor-stamped sessionId, never the pre-M5 claudeSessionId.
  assert.deepEqual(stored.entries.map((e) => [e.vendor, e.sessionId, e.lane]), [['claude', 'claude-1', 'pr-review'], ['claude', 'claude-2', INTERACTIVE_LANE]]);
  assert.equal(ledger.laneMap().get('claude:claude-1'), 'pr-review');
  // No tmp file left behind.
  assert.deepEqual(await fs.readdir(path.join(root, '.glissa')), ['usage-lanes.json']);
});

test('a fresh ledger reads what a previous process wrote', async () => {
  const root = await makeTempRoot();
  const ledgerPath = path.join(root, '.glissa', 'usage-lanes.json');
  const first = createLaneLedger({ ledgerPath, nowFn: () => NOW });
  first.record('claude-1', 'pack-distill');
  await first.whenIdle();

  const second = createLaneLedger({ ledgerPath, nowFn: () => NOW });
  await second.load();
  assert.equal(second.laneMap().get('claude:claude-1'), 'pack-distill');
});

test('re-recording the same id and lane does not rewrite the file', async () => {
  const root = await makeTempRoot();
  const ledgerPath = path.join(root, '.glissa', 'usage-lanes.json');
  const ledger = createLaneLedger({ ledgerPath, nowFn: () => NOW });
  ledger.record('claude-1', 'pr-review');
  await ledger.whenIdle();
  const before = await fs.readFile(ledgerPath, 'utf8');
  ledger.record('claude-1', 'pr-review');
  await ledger.whenIdle();
  assert.equal(await fs.readFile(ledgerPath, 'utf8'), before);
});

test('retention is applied on write, not just on read', async () => {
  const root = await makeTempRoot();
  const ledgerPath = path.join(root, '.glissa', 'usage-lanes.json');
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.writeFile(ledgerPath, JSON.stringify({
    version: 1,
    entries: [
      { claudeSessionId: 'ancient', lane: 'pr-review', ts: NOW - 400 * DAY_MS },
      { claudeSessionId: 'recent', lane: 'pr-review', ts: NOW - DAY_MS },
    ],
  }));
  const ledger = createLaneLedger({ ledgerPath, nowFn: () => NOW, retainDays: 365 });
  ledger.record('new-one', 'posthog');
  await ledger.whenIdle();
  const stored = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
  assert.deepEqual(stored.entries.map((e) => e.sessionId).sort(), ['new-one', 'recent']);
});

// A pre-M5 ledger file keyed `claudeSessionId` with no vendor field must keep working: it reads as vendor
// claude, and the next write re-persists it in the M5 shape. This is the migration path for every install
// that ran the ledger before M5.
test('an old-format ledger file round-trips as vendor claude', async () => {
  const root = await makeTempRoot();
  const ledgerPath = path.join(root, '.glissa', 'usage-lanes.json');
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.writeFile(ledgerPath, JSON.stringify({
    version: 1,
    entries: [
      { claudeSessionId: 'old-1', lane: 'pr-review', ts: NOW - DAY_MS },
      { claudeSessionId: 'old-2', lane: INTERACTIVE_LANE, ts: NOW - DAY_MS },
    ],
  }));
  const ledger = createLaneLedger({ ledgerPath, nowFn: () => NOW, retainDays: 365 });
  await ledger.load();
  // Read side: the composite key is namespaced under claude.
  assert.equal(ledger.laneMap().get('claude:old-1'), 'pr-review');
  assert.equal(ledger.laneMap().get('claude:old-2'), INTERACTIVE_LANE);
  // The snapshot is normalized to the M5 shape with a vendor.
  assert.ok(ledger.snapshot().every((e) => e.vendor === 'claude' && typeof e.sessionId === 'string'));

  // A fresh record rewrites the file in the M5 shape, and the migrated old entries persist beside it.
  ledger.record('new-codex', INTERACTIVE_LANE, 'codex');
  await ledger.whenIdle();
  const stored = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
  const byId = new Map(stored.entries.map((e) => [e.sessionId, e]));
  assert.equal(byId.get('old-1').vendor, 'claude');
  assert.equal(byId.get('new-codex').vendor, 'codex');
  assert.ok(stored.entries.every((e) => e.claudeSessionId === undefined), 'no entry keeps the pre-M5 field');
  // The codex record is namespaced away from a claude id of the same value.
  assert.equal(ledger.laneMap().get('codex:new-codex'), INTERACTIVE_LANE);
});

test('a corrupt ledger starts empty, warns, and still records', async () => {
  const root = await makeTempRoot();
  const ledgerPath = path.join(root, '.glissa', 'usage-lanes.json');
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.writeFile(ledgerPath, '{ not json');
  const warnings = [];
  const ledger = createLaneLedger({ ledgerPath, nowFn: () => NOW, logger: { warn: (m) => warnings.push(m) } });
  await ledger.load();
  assert.deepEqual(ledger.snapshot(), []);
  assert.ok(warnings.some((m) => m.includes('unreadable')), `warned: ${warnings.join(' | ')}`);
  ledger.record('claude-1', 'pr-review');
  await ledger.whenIdle();
  assert.equal(ledger.laneMap().get('claude:claude-1'), 'pr-review');
});

test('an unwritable ledger degrades to a warning and keeps working in memory', async () => {
  const root = await makeTempRoot();
  const warnings = [];
  const ledger = createLaneLedger({
    ledgerPath: path.join(root, '.glissa', 'usage-lanes.json'),
    nowFn: () => NOW,
    logger: { warn: (m) => warnings.push(m) },
    fsPromises: { ...require('node:fs/promises'), writeFile: async () => { throw new Error('EACCES simulated'); } },
  });
  ledger.record('claude-1', 'pr-review');
  await ledger.whenIdle();
  assert.ok(warnings.some((m) => m.includes('write failed')), `warned: ${warnings.join(' | ')}`);
  // Attribution still works for this process; only durability was lost.
  assert.equal(ledger.laneMap().get('claude:claude-1'), 'pr-review');
});

test('no ledgerPath makes the whole feature inert', async () => {
  const ledger = createLaneLedger({});
  await ledger.load();
  ledger.record('claude-1', 'pr-review');
  assert.equal(ledger.laneMap().size, 0);
  assert.deepEqual(ledger.snapshot(), []);
});

// ── The seam every lane goes through ──
// registerEphemeralSession already names its lane (logPrefix), so it is the one place that knows both the
// lane and the Claude session id it spawned. Hooks were live-verified to fire for headless `-p` sessions.

test('registerEphemeralSession records the lane from its own logPrefix', () => {
  const recorded = [];
  const sess = new EventEmitter();
  sess.destroy = () => {};
  registerEphemeralSession({
    map: new Map(),
    id: 'ephemeral-1',
    sess,
    closeSessionDataClients: () => {},
    logPrefix: 'pr-review',
    name: 'pr-42',
    recordLane: (claudeSessionId, lane) => recorded.push([claudeSessionId, lane]),
  });
  sess.emit('claude-session-id', { id: 'claude-abc' });
  assert.deepEqual(recorded, [['claude-abc', 'pr-review']]);
});

test('registerEphemeralSession without a recorder behaves exactly as before', () => {
  const map = new Map();
  const sess = new EventEmitter();
  sess.destroy = () => {};
  registerEphemeralSession({ map, id: 'e1', sess, closeSessionDataClients: () => {}, logPrefix: 'posthog', name: 'n' });
  // The listener is simply not attached, and the registration itself is untouched.
  sess.emit('claude-session-id', { id: 'claude-abc' });
  assert.equal(map.get('e1'), sess);
  sess.emit('exit', {});
  assert.equal(map.has('e1'), false, 'the exit cleanup still runs');
});
