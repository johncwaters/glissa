'use strict';

/*
 * M12b of docs/plan-visions-3.md: the long-term memory tenant of the machine-wide database. It owns the
 * DDL, the prepared statements and the row-to-record mapping, and nothing else: every decision about
 * what may be remembered, what a forget expunges and how a record is ranked stays in
 * server/core/memory-core.js, and the shell that applies those decisions is server/memory-store.js.
 *
 * The canon is append-only in the same sense the JSONL segments were: rows are inserted, never rewritten,
 * except by the one sanctioned expunge. `validTo` is derived at read time from the supersession chain.
 */

const { applySchema, dataVersion, openDatabase } = require('./glissa-db');
const core = require('./core/memory-core');

const SCHEMA = Object.freeze([
  `CREATE TABLE IF NOT EXISTS memory_records (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    segment_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    layer TEXT NOT NULL,
    project TEXT,
    source_kind TEXT NOT NULL,
    source_vendor TEXT NOT NULL,
    source_session_id TEXT,
    body TEXT NOT NULL,
    valid_from INTEGER NOT NULL,
    valid_to INTEGER,
    supersedes TEXT,
    lineage TEXT NOT NULL,
    locked INTEGER NOT NULL,
    sig TEXT,
    seq INTEGER
  )`,
  'CREATE INDEX IF NOT EXISTS memory_records_segment ON memory_records (segment_key)',
  'CREATE INDEX IF NOT EXISTS memory_records_ts ON memory_records (ts)',
  'CREATE INDEX IF NOT EXISTS memory_records_seq ON memory_records (seq)',
  `CREATE TABLE IF NOT EXISTS memory_tail_state (
    path TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    mtime_ms REAL NOT NULL,
    read_offset INTEGER NOT NULL,
    ts INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS memory_delivered_hashes (
    hash TEXT PRIMARY KEY,
    seq INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS memory_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  // Derived and rebuildable: any doubt about its consistency with memory_records is answered by a rebuild.
  'CREATE VIRTUAL TABLE IF NOT EXISTS memory_records_fts USING fts5(id UNINDEXED, body)',
]);

const LAST_APPEND_KEY = 'memory.lastAppendAt';
const PROJECT_TAG_SCHEMA_KEY = 'memory.schema.projectTags';
const PROJECT_TAG_SCHEMA_VERSION = 2;
const DISTILL_CURSOR_KEY = 'memory.distill.cursorSeq';
const DISTILL_FAILURE_KEY = 'memory.distill.failures';
// A high water mark prevents a forgotten newest row from letting a new record fall behind the cursor.
const SEQ_HIGH_KEY = 'memory.seq.high';

function recordToRow(record) {
  return {
    id: record.id,
    ts: record.ts,
    segment_key: core.segmentKeyForTs(record.ts),
    kind: record.kind,
    layer: record.layer,
    project: record.project ?? null,
    source_kind: record.source.kind,
    source_vendor: record.source.vendor,
    source_session_id: record.source.sessionId ?? null,
    body: record.text,
    valid_from: record.validFrom,
    valid_to: record.validTo ?? null,
    supersedes: record.supersedes ?? null,
    lineage: record.lineage,
    locked: record.locked === true ? 1 : 0,
    sig: record.sig ?? null,
  };
}

// Deliberately unvalidated: the caller runs it through validateMemoryRecord and verifyOrDemote, exactly
// as it ran a canon LINE through them, so a row a local process wrote by hand is trusted no further.
function rowToRecord(row) {
  return {
    id: row.id,
    ts: row.ts,
    kind: row.kind,
    layer: row.layer,
    project: row.project,
    source: { kind: row.source_kind, vendor: row.source_vendor, sessionId: row.source_session_id },
    text: row.body,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    supersedes: row.supersedes,
    lineage: row.lineage,
    locked: row.locked === 1,
    sig: row.sig,
    seq: Number.isInteger(row.seq) ? row.seq : null,
  };
}

// Terms are [a-z0-9]+ from the pure tokenizer, so quoting each one leaves FTS5 no operator to read.
// The doubled quote is belt and braces: it keeps the escaping correct here if that tokenizer ever widens.
function ftsMatchExpression(terms) {
  if (!Array.isArray(terms) || terms.length === 0) return null;
  return terms.map((term) => `"${String(term).replace(/"/g, '""')}"`).join(' OR ');
}

// Existing tables need widening before the schema adds an index over the new column.
function ensureSeqColumn(db) {
  const columns = db.prepare('PRAGMA table_info(memory_records)').all();
  if (columns.length === 0 || columns.some((column) => column.name === 'seq')) return false;
  db.exec('ALTER TABLE memory_records ADD COLUMN seq INTEGER');
  db.exec('UPDATE memory_records SET seq = rowid');
  return true;
}

function createMemoryDb({ dbPath, busyTimeoutMs = undefined } = {}) {
  const db = openDatabase(dbPath, { busyTimeoutMs });
  ensureSeqColumn(db);
  applySchema(db, SCHEMA);

  const statements = {
    listRecords: db.prepare('SELECT * FROM memory_records ORDER BY ts, id'),
    listProjectRecords: db.prepare('SELECT * FROM memory_records WHERE project IS NOT NULL ORDER BY ts, id'),
    hasRecord: db.prepare('SELECT 1 AS present FROM memory_records WHERE id = ?'),
    insertRecord: db.prepare(`INSERT OR IGNORE INTO memory_records (
      id, ts, segment_key, kind, layer, project, source_kind, source_vendor, source_session_id,
      body, valid_from, valid_to, supersedes, lineage, locked, sig, seq
    ) VALUES (
      $id, $ts, $segment_key, $kind, $layer, $project, $source_kind, $source_vendor, $source_session_id,
      $body, $valid_from, $valid_to, $supersedes, $lineage, $locked, $sig, $seq
    )`),
    updateRecord: db.prepare('UPDATE memory_records SET body = ?, source_kind = ?, lineage = ?, locked = ?, sig = ? WHERE id = ?'),
    updateRecordProject: db.prepare('UPDATE memory_records SET project = ?, sig = ? WHERE id = ?'),
    deleteRecord: db.prepare('DELETE FROM memory_records WHERE id = ?'),
    countRecords: db.prepare('SELECT count(*) AS total FROM memory_records'),
    maxSeq: db.prepare('SELECT coalesce(max(seq), 0) AS high FROM memory_records'),
    segmentKeys: db.prepare('SELECT DISTINCT segment_key FROM memory_records'),
    deleteSegment: db.prepare('DELETE FROM memory_records WHERE segment_key = ?'),
    insertFts: db.prepare('INSERT INTO memory_records_fts (id, body) VALUES (?, ?)'),
    deleteFts: db.prepare('DELETE FROM memory_records_fts WHERE id = ?'),
    clearFts: db.prepare('DELETE FROM memory_records_fts'),
    // FTS5's own rebuild: it DISCARDS every segment and re-derives from the index's content rows, which
    // is what actually frees the term data a plain DELETE only tombstones.
    scrubFts: db.prepare("INSERT INTO memory_records_fts(memory_records_fts) VALUES('rebuild')"),
    countFts: db.prepare('SELECT count(*) AS total FROM memory_records_fts'),
    search: db.prepare(`SELECT id FROM memory_records_fts WHERE memory_records_fts MATCH ?
      ORDER BY bm25(memory_records_fts) LIMIT ?`),
    listTails: db.prepare('SELECT * FROM memory_tail_state'),
    saveTail: db.prepare(`INSERT INTO memory_tail_state (path, size, mtime_ms, read_offset, ts)
      VALUES ($path, $size, $mtime_ms, $read_offset, $ts)
      ON CONFLICT(path) DO UPDATE SET size = $size, mtime_ms = $mtime_ms, read_offset = $read_offset, ts = $ts`),
    deleteTail: db.prepare('DELETE FROM memory_tail_state WHERE path = ?'),
    pruneTails: db.prepare(`DELETE FROM memory_tail_state WHERE path NOT IN (
      SELECT path FROM memory_tail_state ORDER BY ts DESC, path LIMIT ?
    )`),
    listDelivered: db.prepare('SELECT hash FROM memory_delivered_hashes'),
    saveDelivered: db.prepare(`INSERT INTO memory_delivered_hashes (hash, seq) VALUES (?, ?)
      ON CONFLICT(hash) DO UPDATE SET seq = excluded.seq`),
    countDelivered: db.prepare('SELECT count(*) AS total FROM memory_delivered_hashes'),
    nextDeliveredSeq: db.prepare('SELECT coalesce(max(seq), 0) + 1 AS next FROM memory_delivered_hashes'),
    pruneDelivered: db.prepare(`DELETE FROM memory_delivered_hashes WHERE hash NOT IN (
      SELECT hash FROM memory_delivered_hashes ORDER BY seq DESC LIMIT ?
    )`),
    readMeta: db.prepare('SELECT value FROM memory_meta WHERE key = ?'),
    writeMeta: db.prepare(`INSERT INTO memory_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
  };

  function readMetaInteger(key) {
    const value = Number(statements.readMeta.get(key)?.value);
    return Number.isFinite(value) ? Math.floor(value) : 0;
  }

  // The write lock and row max keep hand-edited or pre-migration databases from receiving a dead seq.
  function allocateSeq() {
    const next = Math.max(readMetaInteger(SEQ_HIGH_KEY), Number(statements.maxSeq.get().high) || 0) + 1;
    statements.writeMeta.run(SEQ_HIGH_KEY, String(next));
    return next;
  }

  // Returns the ordinal it assigned rather than a bare true, so an in-memory copy can carry it too.
  function insertRecord(record) {
    const row = { ...recordToRow(record), seq: allocateSeq() };
    const outcome = statements.insertRecord.run(row);
    if (Number(outcome.changes) === 0) return false;
    statements.insertFts.run(row.id, row.body);
    return row.seq;
  }

  function updateRecordText(record) {
    statements.updateRecord.run(
      record.text, record.source.kind, record.lineage, record.locked === true ? 1 : 0, record.sig ?? null, record.id
    );
    statements.deleteFts.run(record.id);
    statements.insertFts.run(record.id, record.text);
  }

  function deleteRecord(id) {
    statements.deleteRecord.run(id);
    statements.deleteFts.run(id);
  }

  // A pre-M18 database carries backfilled ordinals with no high water mark, and a fresh one carries none.
  function ensureSeqHighWater() {
    const rowMax = Number(statements.maxSeq.get().high) || 0;
    if (rowMax <= readMetaInteger(SEQ_HIGH_KEY)) return;
    statements.writeMeta.run(SEQ_HIGH_KEY, String(rowMax));
  }

  function migrateProjectTags(migrateRecord) {
    const current = Number(statements.readMeta.get(PROJECT_TAG_SCHEMA_KEY)?.value || 0);
    if (current >= PROJECT_TAG_SCHEMA_VERSION) return { applied: false, examined: 0, remapped: 0 };
    return transaction(() => {
      let examined = 0;
      let remapped = 0;
      for (const row of statements.listProjectRecords.all()) {
        examined += 1;
        const record = rowToRecord(row);
        const migrated = migrateRecord(record);
        if (!migrated || migrated.project === record.project) continue;
        statements.updateRecordProject.run(migrated.project, migrated.sig ?? null, record.id);
        remapped += 1;
      }
      statements.writeMeta.run(PROJECT_TAG_SCHEMA_KEY, String(PROJECT_TAG_SCHEMA_VERSION));
      return { applied: true, examined, remapped };
    });
  }

  /*
   * A deleted or redacted row leaves its words in the index's existing SEGMENTS, which a DELETE only
   * marks rather than frees, so an expunged secret stays greppable in the database file. This is the
   * second of the three parts that close that (secure_delete and the WAL checkpoint are the others).
   */
  function scrubSearchIndex() {
    statements.scrubFts.run();
  }

  // Re-derived from the CANON, not from the index's own content rows, so it also repairs a divergence.
  function rebuildSearchIndex() {
    statements.clearFts.run();
    for (const row of statements.listRecords.all()) statements.insertFts.run(row.id, row.body);
    scrubSearchIndex();
    return Number(statements.countFts.get().total);
  }

  // Frees the WAL frames a committed expunge left behind; a reader holding the log only defers it.
  function checkpoint() {
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      return true;
    } catch {
      return false;
    }
  }

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // A rollback that cannot run leaves the failing error as the one worth reporting.
      }
      throw error;
    }
  }

  function searchIds(terms, limit) {
    const expression = ftsMatchExpression(terms);
    if (!expression) return null;
    return statements.search.all(expression, Math.max(1, Math.floor(limit))).map((row) => row.id);
  }

  function tailState() {
    const files = {};
    for (const row of statements.listTails.all()) {
      files[row.path] = {
        size: row.size, mtimeMs: row.mtime_ms, offset: row.read_offset, ts: row.ts,
      };
    }
    return { files };
  }

  function saveTailOffset(entry, { maxEntries = 0 } = {}) {
    transaction(() => {
      statements.saveTail.run({
        path: entry.path,
        size: Math.max(0, Math.floor(entry.size)),
        mtime_ms: Number(entry.mtimeMs) || 0,
        read_offset: Math.max(0, Math.floor(entry.offset)),
        ts: Math.floor(Number(entry.ts) || 0),
      });
      if (maxEntries > 0) statements.pruneTails.run(Math.floor(maxEntries));
    });
  }

  function forgetTails(paths) {
    transaction(() => {
      for (const filePath of paths) statements.deleteTail.run(filePath);
    });
  }

  /*
   * Mirrored in memory because the echo check runs once per LINE of every ingested event, on the one
   * event loop every session shares. The rows stay the durable copy; the mirror is dropped on write.
   */
  let deliveredCache = null;

  function deliveredSet() {
    if (!deliveredCache) deliveredCache = new Set(statements.listDelivered.all().map((row) => row.hash));
    return deliveredCache;
  }

  function noteDelivered(hashes, { maxHashes = 0 } = {}) {
    deliveredCache = null;
    transaction(() => {
      let seq = Number(statements.nextDeliveredSeq.get().next);
      for (const hash of hashes) {
        statements.saveDelivered.run(hash, seq);
        seq += 1;
      }
      if (maxHashes > 0) statements.pruneDelivered.run(Math.floor(maxHashes));
    });
    return Number(statements.countDelivered.get().total);
  }

  // The FTS table is derived, so a count that disagrees with the canon is answered by a rebuild, not a repair.
  function ensureSearchIndex() {
    const records = Number(statements.countRecords.get().total);
    if (records === Number(statements.countFts.get().total)) return 0;
    return rebuildSearchIndex();
  }

  ensureSeqHighWater();

  return {
    checkpoint,
    close: () => db.close(),
    dataVersion: () => dataVersion(db),
    dbPath,
    deleteRecord,
    // Retention drops remembered text too, so it scrubs exactly the way forget does.
    deleteSegments(keys) {
      let removed = 0;
      transaction(() => {
        for (const key of keys) {
          const outcome = statements.deleteSegment.run(key);
          removed += Number(outcome.changes);
        }
        rebuildSearchIndex();
      });
      checkpoint();
      return removed;
    },
    deliveredCount: () => Number(statements.countDelivered.get().total),
    distillCursorSeq: () => readMetaInteger(DISTILL_CURSOR_KEY),
    distillFailures: () => readMetaInteger(DISTILL_FAILURE_KEY),
    deliveredHas: (hash) => deliveredSet().has(hash),
    ensureSearchIndex,
    forgetTails,
    hasRecord: (id) => statements.hasRecord.get(id) !== undefined,
    insertRecord,
    lastAppendAt() {
      const row = statements.readMeta.get(LAST_APPEND_KEY);
      const value = row ? Number(row.value) : 0;
      return Number.isFinite(value) ? value : 0;
    },
    listRecords: () => statements.listRecords.all().map(rowToRecord),
    migrateProjectTags,
    noteDelivered,
    rebuildSearchIndex,
    recordCount: () => Number(statements.countRecords.get().total),
    saveTailOffset,
    scrubSearchIndex,
    searchIds,
    segmentKeys: () => statements.segmentKeys.all().map((row) => row.segment_key),
    setDistillCursorSeq: (seq) => { statements.writeMeta.run(DISTILL_CURSOR_KEY, String(Math.max(0, Math.floor(seq)))); },
    setDistillFailures: (count) => { statements.writeMeta.run(DISTILL_FAILURE_KEY, String(Math.max(0, Math.floor(count)))); },
    setLastAppendAt: (at) => { statements.writeMeta.run(LAST_APPEND_KEY, String(Math.floor(at))); },
    tailState,
    transaction,
    updateRecordText,
  };
}

module.exports = {
  DISTILL_CURSOR_KEY,
  DISTILL_FAILURE_KEY,
  LAST_APPEND_KEY,
  PROJECT_TAG_SCHEMA_KEY,
  PROJECT_TAG_SCHEMA_VERSION,
  SCHEMA,
  SEQ_HIGH_KEY,
  createMemoryDb,
  ftsMatchExpression,
  recordToRow,
  rowToRecord,
};
