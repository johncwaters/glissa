'use strict';

// The memory tenant of the machine-wide database (docs/plan-visions-3.md, M12b): an idempotent schema,
// the bounded bookkeeping tables that replaced tail-state.json and the in-memory echo set, and the
// derived FTS5 index that is rebuilt rather than repaired.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createMemoryDb, ftsMatchExpression, recordToRow } = require('../server/memory-db.ts');
const { SCHEMA_VERSION, isBusyError, isSqliteAvailable, openDatabase } = require('../server/glissa-db.ts');

const START = Date.UTC(2026, 7, 22, 12, 0, 0);
const opened = [];

function tempDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-memdb-')), 'glissa.db');
}

function openDb(dbPath) {
  const db = createMemoryDb({ dbPath });
  opened.push(db);
  return db;
}

test.afterEach(() => {
  for (const db of opened.splice(0)) {
    try {
      db.close();
    } catch {}
  }
});

function record(overrides = {}) {
  return {
    id: 'm-0000000000000001',
    ts: START,
    kind: 'knowledge',
    layer: 'semantic',
    project: '/repos/glissa',
    source: { kind: 'reported', vendor: 'claude', sessionId: 's-1' },
    text: 'the rebase gate refuses a dirty worktree',
    validFrom: START,
    validTo: null,
    supersedes: null,
    lineage: 'reported',
    locked: false,
    sig: 'abc',
    ...overrides,
  };
}

test('the schema is created idempotently and stamps its shape', () => {
  const dbPath = tempDbPath();
  const first = openDb(dbPath);
  first.insertRecord(record());
  first.close();
  opened.pop();

  const second = openDb(dbPath);
  assert.equal(second.recordCount(), 1, 'a second open creates nothing and drops nothing');
  const raw = new DatabaseSync(dbPath);
  try {
    assert.equal(raw.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.equal(raw.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  } finally {
    raw.close();
  }
});

test('a record round-trips through its row unchanged', () => {
  const db = openDb(tempDbPath());
  const original = record();
  assert.equal(db.insertRecord(original), 1, 'the ordinal it assigned');
  assert.deepEqual(db.listRecords(), [{ ...original, seq: 1 }]);
  assert.equal(db.insertRecord(original), false, 'the same id is ignored, never doubled');
  assert.equal(db.recordCount(), 1);
});

test('a month is deleted by key, which is how append-only storage and pruning coexist', () => {
  const db = openDb(tempDbPath());
  db.insertRecord(record());
  db.insertRecord(record({ id: 'm-0000000000000002', ts: Date.UTC(2025, 0, 15), text: 'an older fact' }));
  assert.deepEqual(db.segmentKeys().sort(), ['202501', '202608']);
  assert.equal(db.deleteSegments(['202501']), 1);
  assert.deepEqual(db.listRecords().map((entry) => entry.id), ['m-0000000000000001']);
  assert.equal(db.searchIds(['older'], 10).length, 0, 'the index went with the month');
});

test('the search index is derived, so a count that disagrees with the canon is rebuilt', () => {
  const dbPath = tempDbPath();
  const db = openDb(dbPath);
  db.insertRecord(record());
  db.insertRecord(record({ id: 'm-0000000000000002', text: 'the poller ticks every 15 minutes' }));

  const raw = new DatabaseSync(dbPath);
  try {
    raw.exec('DELETE FROM memory_records_fts');
  } finally {
    raw.close();
  }
  assert.equal(db.searchIds(['poller'], 10).length, 0, 'the emptied index answers nothing');
  assert.equal(db.ensureSearchIndex(), 2, 'the mismatch is answered by a rebuild, not a repair');
  assert.deepEqual(db.searchIds(['poller'], 10), ['m-0000000000000002']);
  assert.equal(db.ensureSearchIndex(), 0, 'a consistent index is left alone');
});

// The three parts of the HIGH forget-residue fix, at the substrate seam: the pragma, the scrub, the checkpoint.
test('an expunged row leaves no readable trace once the index is scrubbed and the log reclaimed', () => {
  const dbPath = tempDbPath();
  const db = openDb(dbPath);
  const canary = 'zebrafishpassphrase';
  db.insertRecord(record({ text: `${canary} was pasted into the prompt` }));
  db.insertRecord(record({ id: 'm-0000000000000002', text: 'the poller ticks every 15 minutes' }));
  db.checkpoint();
  assert.equal(fs.readFileSync(dbPath).includes(canary), true, 'the canary is really in the file first');

  db.transaction(() => {
    db.deleteRecord('m-0000000000000001');
    db.scrubSearchIndex();
  });
  db.checkpoint();

  const dir = path.dirname(dbPath);
  const residue = fs.readdirSync(dir).filter((name) => fs.readFileSync(path.join(dir, name)).includes(canary));
  assert.deepEqual(residue, [], 'neither the row, the index segments, nor the WAL frames keep it');
  assert.deepEqual(db.searchIds(['poller'], 10), ['m-0000000000000002'], 'the surviving row is still indexed');
});

// Per CONNECTION, not stored in the file, so it is asserted on the handle the opener hands back.
test('secure_delete is on, which is what makes a freed row unreadable rather than merely unlinked', () => {
  const dbPath = tempDbPath();
  const db = openDatabase(dbPath);
  try {
    assert.equal(db.prepare('PRAGMA secure_delete').get().secure_delete, 1);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  } finally {
    db.close();
  }
});

test('the database file is created 0600, never widened by the umask in the window before a chmod', { skip: process.platform === 'win32' ? 'POSIX modes only' : false }, () => {
  const dbPath = tempDbPath();
  const previous = process.umask(0o000);
  try {
    openDb(dbPath);
    assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600);
  } finally {
    process.umask(previous);
  }
});

test('a redaction re-indexes the row it rewrote', () => {
  const db = openDb(tempDbPath());
  db.insertRecord(record());
  db.updateRecordText({ ...record(), text: 'the [forgotten] refuses a dirty worktree', sig: 'def' });
  assert.deepEqual(db.searchIds(['rebase'], 10), [], 'the expunged term is out of the index too');
  assert.deepEqual(db.searchIds(['worktree'], 10), ['m-0000000000000001']);
  assert.equal(db.listRecords()[0].sig, 'def');
});

test('an FTS expression quotes every term, so remembered text cannot carry an operator', () => {
  assert.equal(ftsMatchExpression(['merge', 'gate']), '"merge" OR "gate"');
  assert.equal(ftsMatchExpression(['a" OR body:x']), '"a"" OR body:x"', 'a quote is doubled, never closed');
  assert.equal(ftsMatchExpression([]), null);
});

test('tail offsets are per-transcript rows, bounded oldest-first', () => {
  const db = openDb(tempDbPath());
  for (let index = 0; index < 4; index += 1) {
    db.saveTailOffset({
      path: `/transcripts/${index}.jsonl`, size: 10, mtimeMs: 1.5, offset: index, ts: START + index,
    }, { maxEntries: 3 });
  }
  const state = db.tailState();
  assert.deepEqual(Object.keys(state.files).sort(), [
    '/transcripts/1.jsonl', '/transcripts/2.jsonl', '/transcripts/3.jsonl',
  ]);
  assert.deepEqual(state.files['/transcripts/3.jsonl'], { size: 10, mtimeMs: 1.5, offset: 3, ts: START + 3 });

  db.saveTailOffset({
    path: '/transcripts/3.jsonl', size: 20, mtimeMs: 2.5, offset: 20, ts: START + 9,
  }, { maxEntries: 3 });
  assert.equal(db.tailState().files['/transcripts/3.jsonl'].offset, 20, 'the same transcript updates in place');

  db.forgetTails(['/transcripts/3.jsonl']);
  assert.equal(db.tailState().files['/transcripts/3.jsonl'], undefined);
});

test('delivered hashes are bounded newest-first, which is what keeps the echo set from growing', () => {
  const db = openDb(tempDbPath());
  assert.equal(db.noteDelivered(['h1', 'h2', 'h3'], { maxHashes: 2 }), 2);
  assert.equal(db.deliveredHas('h1'), false, 'the oldest went');
  assert.equal(db.deliveredHas('h3'), true);
  db.noteDelivered(['h2'], { maxHashes: 2 });
  assert.equal(db.deliveredHas('h2'), true, 're-delivering refreshes rather than duplicates');
  assert.equal(db.deliveredCount(), 2);
});

test('the append watermark survives a reopen, so a distill quiet window spans processes', () => {
  const dbPath = tempDbPath();
  const db = openDb(dbPath);
  assert.equal(db.lastAppendAt(), 0);
  db.setLastAppendAt(START);
  db.close();
  opened.pop();
  assert.equal(openDb(dbPath).lastAppendAt(), START);
});

test('a rolled back transaction leaves neither the row nor its index entry', () => {
  const db = openDb(tempDbPath());
  assert.throws(() => db.transaction(() => {
    db.insertRecord(record());
    throw new Error('the write failed');
  }), /the write failed/);
  assert.equal(db.recordCount(), 0);
  assert.deepEqual(db.searchIds(['rebase'], 10), []);
});

test('another connection committing moves data_version, which is the reload signal', () => {
  const dbPath = tempDbPath();
  const reader = openDb(dbPath);
  const before = reader.dataVersion();
  reader.insertRecord(record());
  assert.equal(reader.dataVersion(), before, 'our own write is not news to us');

  const writer = openDb(dbPath);
  writer.insertRecord(record({ id: 'm-0000000000000002', text: 'a fact from another process' }));
  assert.notEqual(reader.dataVersion(), before, 'another connection committing is');
});

test('the feature detect and the busy classifier answer the two questions a caller has', () => {
  assert.equal(isSqliteAvailable(), true, 'this Node has node:sqlite; without it the lane stays off');
  assert.equal(isBusyError(new Error('database is locked')), true);
  assert.equal(isBusyError(new Error('no such table')), false);
  assert.equal(recordToRow(record()).locked, 0, 'a boolean is stored as the integer sqlite has');
});

test('an append ordinal never goes backwards, not even after the newest record is forgotten', () => {
  const dbPath = tempDbPath();
  const db = openDb(dbPath);
  assert.equal(db.insertRecord(record()), 1);
  assert.equal(db.insertRecord(record({ id: 'm-0000000000000002', text: 'the second fact' })), 2);
  db.transaction(() => db.deleteRecord('m-0000000000000002'));
  assert.equal(db.insertRecord(record({ id: 'm-0000000000000003', text: 'the third fact' })), 3);
  db.close();
  // A reopen re-reads the high water mark rather than re-deriving it from the rows that survived.
  const reopened = openDb(dbPath);
  assert.equal(reopened.insertRecord(record({ id: 'm-0000000000000004', text: 'the fourth fact' })), 4);
});

test('a pre-M18 database is widened in place and its records backfilled in insertion order', () => {
  const dbPath = tempDbPath();
  const seeded = openDb(dbPath);
  seeded.insertRecord(record());
  seeded.insertRecord(record({ id: 'm-0000000000000002', text: 'the second fact' }));
  seeded.close();
  const raw = new DatabaseSync(dbPath);
  try {
    raw.exec('DROP INDEX IF EXISTS memory_records_seq');
    raw.exec('ALTER TABLE memory_records DROP COLUMN seq');
    raw.exec("DELETE FROM memory_meta WHERE key = 'memory.seq.high'");
  } finally {
    raw.close();
  }
  const migrated = openDb(dbPath);
  assert.deepEqual(migrated.listRecords().map((entry) => entry.seq), [1, 2]);
  assert.equal(migrated.insertRecord(record({ id: 'm-0000000000000003', text: 'the third fact' })), 3);
});

test('the distill cursor and its failure counter round-trip through the meta table', () => {
  const db = openDb(tempDbPath());
  assert.equal(db.distillCursorSeq(), 0);
  assert.equal(db.distillFailures(), 0);
  db.setDistillCursorSeq(41);
  db.setDistillFailures(3);
  assert.equal(db.distillCursorSeq(), 41);
  assert.equal(db.distillFailures(), 3);
  db.setDistillCursorSeq(-9);
  assert.equal(db.distillCursorSeq(), 0);
});
