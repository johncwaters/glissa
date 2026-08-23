'use strict';

// M12 of docs/plan-visions-3.md: the thin IO shell around server/core/memory-core.js. Every decision it
// makes comes from that core; this file only reads, appends, projects and drains.

const nodeCrypto = require('node:crypto');
const nodeFs = require('node:fs');
const path = require('node:path');

const { canonicalizePath } = require('../shared/paths');
const { appendJsonLine, writeTextAtomic, writeTextAtomicSync } = require('./json-file');
const { createLaneLog } = require('./lane-log');
const core = require('./core/memory-core');

const MEMORY_DIR_NAME = 'memory';
const HMAC_KEY_FILE = 'hmac-key';
const DIST_DIR_NAME = 'dist';
const PROJECTS_DIR_NAME = 'projects';
const GLOBAL_PROJECTION_FILE = 'MEMORY.md';
const DEFAULT_PROJECTION_DEBOUNCE_MS = 500;
const HMAC_KEY_BYTES = 32;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// Cross-process write lock over the canon, mirroring server/pairings-store.js: the `glissa memory
// forget` CLI and a live server both rewrite these segments, and a rewrite is read-then-rename.
const CANON_LOCK_FILE = 'canon.lock';
const LOCK_RETRY_MS = 50;
const LOCK_MAX_ATTEMPTS = 10;
const LOCK_STALE_MS = 5000;
const CANON_WATCH_DEBOUNCE_MS = 200;

function defaultMemoryDir() {
  const { resolveConfigPath } = require('./config-store');
  const { configSiblingPath } = require('./pairings-store');
  return configSiblingPath(resolveConfigPath(), MEMORY_DIR_NAME);
}

// Its own timer, never the injected one (that pair belongs to the projection debounce, which tests
// replace with a queue that never fires) and never unref'd: an awaited retry is work still in flight.
function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function createMemoryStore(deps = {}) {
  const {
    dir = defaultMemoryDir(),
    config = core.resolveMemoryConfig(null),
    fs = nodeFs,
    fsPromises = nodeFs.promises,
    now = () => Date.now(),
    randomBytes = (size) => nodeCrypto.randomBytes(size),
    logger = console,
    debug = false,
    projectionDebounceMs = DEFAULT_PROJECTION_DEBOUNCE_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    watchCanon = true,
  } = deps;

  const log = createLaneLog({ prefix: '[memory]', logger, debugFlag: debug });
  const distDir = path.join(dir, DIST_DIR_NAME);
  const projectsDir = path.join(distDir, PROJECTS_DIR_NAME);

  let signingKey = null;
  let records = [];
  let stopped = false;
  let mutationChain = Promise.resolve();
  let projectionChain = Promise.resolve();
  let projectionTimer = null;
  let projectionDirty = false;

  function canonPath(segmentKey) {
    return path.join(dir, core.segmentFileName(segmentKey));
  }

  // POSIX only: Windows reports no uid and no meaningful mode, so a planted key cannot be told apart
  // from a minted one there.
  function keyFileWasMintedHere(keyPath) {
    if (typeof process.getuid !== 'function') return true;
    try {
      const stat = fs.statSync(keyPath);
      if ((stat.mode & 0o777) !== FILE_MODE) return false;
      return stat.uid === process.getuid();
    } catch {
      return false;
    }
  }

  // Adopting whatever key file is already there hands the signing secret to whichever local process
  // planted it first, and that key mints operator/locked records.
  function readOrMintSigningKey() {
    const keyPath = path.join(dir, HMAC_KEY_FILE);
    let existing = '';
    try {
      existing = fs.readFileSync(keyPath, 'utf8').trim();
    } catch {}
    if (existing && keyFileWasMintedHere(keyPath)) return existing;
    if (existing) log.warn('refusing a signing key this store did not mint (mode or owner); minting a fresh one');
    const minted = randomBytes(HMAC_KEY_BYTES).toString('hex');
    writeTextAtomicSync(keyPath, `${minted}\n`, { mode: FILE_MODE, mkdir: true });
    log.note('minted a new signing key');
    return minted;
  }

  function segmentKeysFrom(names) {
    const keys = [];
    for (const name of Array.isArray(names) ? names : []) {
      const key = core.parseSegmentFileName(name);
      if (key) keys.push(key);
    }
    keys.sort();
    return keys;
  }

  function segmentKeysOnDisk() {
    try {
      return segmentKeysFrom(fs.readdirSync(dir));
    } catch {
      return [];
    }
  }

  async function segmentKeysOnDiskAsync() {
    try {
      return segmentKeysFrom(await fsPromises.readdir(dir));
    } catch {
      return [];
    }
  }

  function readSegmentLines(segmentKey) {
    try {
      return fs.readFileSync(canonPath(segmentKey), 'utf8').split('\n');
    } catch {
      return [];
    }
  }

  async function readSegmentLinesAsync(segmentKey) {
    try {
      return (await fsPromises.readFile(canonPath(segmentKey), 'utf8')).split('\n');
    } catch {
      return [];
    }
  }

  function verifiedRecordFromLine(line) {
    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      return null;
    }
    const shape = core.validateMemoryRecord(parsed, { maxChars: config.maxRecordChars });
    if (!shape.valid) return null;
    return core.verifyOrDemote(shape.record, signingKey);
  }

  function assembleRecords(lines) {
    const loaded = [];
    let invalid = 0;
    let demoted = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      const checked = verifiedRecordFromLine(line);
      if (!checked) {
        invalid += 1;
        continue;
      }
      if (checked.demoted) demoted += 1;
      loaded.push(checked.record);
    }
    const capped = core.enforceKindCaps(core.applySupersessions(loaded), { maxPerKind: config.maxRecordsPerKind });
    return {
      records: capped.records, dropped: capped.dropped, invalid, demoted,
    };
  }

  // Order-independent so an append and a reload of the same canon do not read as a change.
  function recordsSignature(list) {
    return JSON.stringify(
      list
        .map((record) => [record.id, record.text, record.validTo, record.source.kind, record.lineage, record.locked])
        .sort()
    );
  }

  // Boot only, a one-shot cold path: the whole canon is read once before the server serves anything.
  function loadSync() {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    signingKey = readOrMintSigningKey();
    const at = now();
    const keys = segmentKeysOnDisk();
    const expired = new Set(core.expiredSegmentKeys(keys, { now: at, retainDays: config.retainDays }));
    let droppedSegments = 0;
    for (const key of expired) {
      try {
        fs.rmSync(canonPath(key), { force: true });
        droppedSegments += 1;
      } catch {
        log.warn(`could not drop expired segment ${key}`);
      }
    }
    const live = keys.filter((key) => !expired.has(key));
    const lines = [];
    for (const key of live) lines.push(...readSegmentLines(key));
    const assembled = assembleRecords(lines);
    records = assembled.records;
    log.note(
      `loaded ${records.length} record(s) from ${live.length} segment(s): `
      + `${droppedSegments} expired segment(s) dropped, ${assembled.dropped} over cap, `
      + `${assembled.invalid} invalid, ${assembled.demoted} demoted`
    );
  }

  // The async twin of loadSync, for the watcher and for the reseal: another process rewriting the canon
  // under a live server must not leave it serving text that is no longer on disk.
  async function reloadFromDisk() {
    const lines = [];
    for (const key of await segmentKeysOnDiskAsync()) lines.push(...await readSegmentLinesAsync(key));
    const assembled = assembleRecords(lines);
    const before = recordsSignature(records);
    records = assembled.records;
    return { changed: recordsSignature(records) !== before, ...assembled };
  }

  const lockPath = path.join(dir, CANON_LOCK_FILE);

  // Real wall clock, not the injected now(): this is compared against a filesystem mtime.
  function removeStaleLock() {
    try {
      const stat = fs.statSync(lockPath);
      if (Date.now() - stat.mtimeMs <= LOCK_STALE_MS) return false;
      fs.unlinkSync(lockPath);
      log.warn('removed a stale canon write lock left by an earlier process');
      return true;
    } catch {
      return true;
    }
  }

  async function acquireCanonLock() {
    for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
      try {
        fs.closeSync(fs.openSync(lockPath, 'wx', FILE_MODE));
        return true;
      } catch (error) {
        if (error.code !== 'EEXIST') {
          log.warn(`could not take the canon write lock: ${error.code || error.message}`);
          return false;
        }
      }
      if (removeStaleLock()) continue;
      await delay(LOCK_RETRY_MS);
    }
    return false;
  }

  function releaseCanonLock() {
    try {
      fs.unlinkSync(lockPath);
    } catch {}
  }

  function queue(work) {
    if (stopped) return Promise.resolve(null);
    const next = mutationChain.then(() => work());
    mutationChain = next.then(() => {}, () => {});
    return next;
  }

  async function writeProjection() {
    projectionDirty = false;
    const at = now();
    const valid = core.selectValidRecords(records, { now: at });
    await writeTextAtomic(path.join(distDir, GLOBAL_PROJECTION_FILE), core.renderProjection(valid, { project: null }), {
      fsPromises, mkdir: true, mode: FILE_MODE,
    });
    const wanted = new Set();
    for (const tag of core.projectTagsOf(valid)) {
      const fileName = `${core.projectFileSlug(tag)}.md`;
      wanted.add(fileName);
      await writeTextAtomic(path.join(projectsDir, fileName), core.renderProjection(valid, { project: tag }), {
        fsPromises, mkdir: true, mode: FILE_MODE,
      });
    }
    await pruneStaleProjectFiles(wanted);
    log.debugNote(() => `projection written: 1 global file, ${wanted.size} project file(s)`);
  }

  // A forgotten project's file must not survive the records that justified it.
  async function pruneStaleProjectFiles(wanted) {
    let names = [];
    try {
      names = await fsPromises.readdir(projectsDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.md') || wanted.has(name)) continue;
      try {
        await fsPromises.rm(path.join(projectsDir, name), { force: true });
      } catch {
        log.warn('could not prune a stale project projection');
      }
    }
  }

  function scheduleProjection() {
    projectionDirty = true;
    if (projectionTimer) return;
    projectionTimer = setTimeoutFn(() => {
      projectionTimer = null;
      projectionChain = writeProjection().catch(() => log.warn('projection write failed'));
    }, projectionDebounceMs);
    if (projectionTimer && typeof projectionTimer.unref === 'function') projectionTimer.unref();
  }

  async function appendSigned(record) {
    await appendJsonLine(canonPath(core.segmentKeyForTs(record.ts)), record, {
      fsPromises, mkdir: true, mode: FILE_MODE,
    });
    records = core.applySupersessions([...records, record]);
    scheduleProjection();
  }

  // A supersession must carry its ancestry or the core refuses it; the store is the only place that can
  // resolve the superseded record's own rank, so a caller cannot skip the lineage cap by omission.
  function withResolvedAncestors(input) {
    const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const supersedes = typeof raw.supersedes === 'string' ? raw.supersedes.trim() : '';
    if (!supersedes || Array.isArray(raw.ancestorLineages)) return raw;
    const target = records.find((record) => record.id === supersedes);
    if (!target) return raw;
    return { ...raw, ancestorLineages: [core.effectiveRank(target)] };
  }

  // Trust fields come from the CALLING path, never from the remembered text.
  function append(input) {
    return queue(async () => {
      const built = core.buildMemoryRecord(withResolvedAncestors(input), {
        now: now(), maxChars: config.maxRecordChars,
      });
      if (!built.ok) {
        log.debugNote(() => `record rejected: ${built.reason}`);
        return null;
      }
      const signed = core.withSignature(built.record, signingKey);
      await appendSigned(signed);
      return signed;
    });
  }

  /*
   * Planned against the SEGMENT FILE, never against the in-memory set: a line the kind cap evicted, or
   * one written into a segment its ts does not name, is still text on disk that a later boot would
   * project. Every surviving record is re-signed from its VERIFIED (so possibly demoted) self, so an
   * unsigned forgery cannot be laundered into a signed operator record by an operator running forget.
   */
  async function rewriteSegmentForForget(segmentKey, matcher) {
    const kept = [];
    const removedIds = [];
    const redactedIds = [];
    let droppedLines = 0;
    for (const line of await readSegmentLinesAsync(segmentKey)) {
      if (!line.trim()) continue;
      const checked = verifiedRecordFromLine(line);
      if (!checked && !core.matchesForgetPattern(line, matcher)) {
        kept.push(line);
        continue;
      }
      if (!checked) {
        droppedLines += 1;
        continue;
      }
      const verdict = core.decideForget(checked.record, matcher);
      if (verdict.action === 'keep') {
        kept.push(line);
        continue;
      }
      if (verdict.action === 'remove') {
        removedIds.push(checked.record.id);
        continue;
      }
      redactedIds.push(checked.record.id);
      kept.push(JSON.stringify(core.withSignature({ ...checked.record, text: verdict.text }, signingKey)));
    }
    const changed = removedIds.length + redactedIds.length + droppedLines > 0;
    if (!changed) return { changed, removedIds, redactedIds, droppedLines };
    await writeTextAtomic(canonPath(segmentKey), kept.length === 0 ? '' : `${kept.join('\n')}\n`, {
      fsPromises, mkdir: true, mode: FILE_MODE,
    });
    return { changed, removedIds, redactedIds, droppedLines };
  }

  // The one sanctioned rewrite of an append-only canon; the tombstone is the audit trail.
  function forget(idOrPattern) {
    return queue(async () => {
      const nothing = {
        ok: false, reason: 'no-match', removed: 0, redacted: 0, segments: 0, tombstoneId: null,
      };
      const matcher = core.makeForgetMatcher(idOrPattern);
      if (!matcher) return nothing;
      if (!await acquireCanonLock()) {
        log.warn('another process holds the canon write lock: nothing was forgotten');
        return { ...nothing, reason: 'locked' };
      }
      const removedIds = [];
      const redactedIds = [];
      let segments = 0;
      let droppedLines = 0;
      try {
        for (const segmentKey of await segmentKeysOnDiskAsync()) {
          const outcome = await rewriteSegmentForForget(segmentKey, matcher);
          if (!outcome.changed) continue;
          segments += 1;
          droppedLines += outcome.droppedLines;
          removedIds.push(...outcome.removedIds);
          redactedIds.push(...outcome.redactedIds);
        }
      } finally {
        releaseCanonLock();
      }
      if (segments === 0) return nothing;
      await reloadFromDisk();
      const built = core.buildMemoryRecord({
        kind: 'tombstone',
        layer: 'episodic',
        project: null,
        source: { kind: 'operator', vendor: 'glissa', sessionId: null },
        text: core.tombstoneText([...removedIds, ...redactedIds]),
      }, { now: now(), maxChars: config.maxRecordChars });
      let tombstoneId = null;
      if (built.ok) {
        const signed = core.withSignature(built.record, signingKey);
        await appendSigned(signed);
        tombstoneId = signed.id;
      }
      if (!built.ok) log.warn(`tombstone rejected: ${built.reason}`);
      if (projectionTimer) clearTimeoutFn(projectionTimer);
      projectionTimer = null;
      await writeProjection();
      const removed = removedIds.length + droppedLines;
      log.note(`forget removed ${removed}, redacted ${redactedIds.length}, across ${segments} segment(s)`);
      return {
        ok: true,
        reason: null,
        removed,
        redacted: redactedIds.length,
        segments,
        tombstoneId,
      };
    });
  }

  /*
   * A `glissa memory forget` run against a LIVE server rewrites these files underneath it, and a server
   * still holding the old set would append it straight back into dist/ on its next write. The debounce
   * and the reload-then-compare mirror pairings-store.watch; verify-on-load already handles the trust
   * side, so a canon another process edited cannot promote anything by being reloaded.
   */
  function startCanonWatch() {
    let timer = null;
    let watcher = null;

    function refresh() {
      queue(async () => {
        const outcome = await reloadFromDisk();
        if (!outcome.changed) return null;
        log.note(`the canon changed under us: reloaded ${records.length} record(s), ${outcome.demoted} demoted`);
        await writeProjection();
        return null;
      }).catch(() => log.warn('reloading the canon failed'));
    }

    try {
      watcher = fs.watch(canonicalizePath(dir), (_event, filename) => {
        if (filename && !core.parseSegmentFileName(path.basename(String(filename)))) return;
        clearTimeout(timer);
        timer = setTimeout(refresh, CANON_WATCH_DEBOUNCE_MS);
        if (typeof timer.unref === 'function') timer.unref();
      });
    } catch (error) {
      log.warn(`could not watch the canon directory: ${error.message}`);
    }

    return function stopWatch() {
      clearTimeout(timer);
      if (!watcher) return;
      try {
        watcher.close();
      } catch {}
      watcher = null;
    };
  }

  function flushProjection() {
    return queue(async () => {
      if (projectionTimer) clearTimeoutFn(projectionTimer);
      projectionTimer = null;
      await writeProjection();
      return true;
    });
  }

  async function stop() {
    stopped = true;
    stopCanonWatch();
    if (projectionTimer) clearTimeoutFn(projectionTimer);
    projectionTimer = null;
    await mutationChain;
    await projectionChain;
    if (!projectionDirty) return;
    await writeProjection().catch(() => log.warn('projection write failed during shutdown'));
  }

  function stats() {
    const byKind = {};
    for (const record of records) byKind[record.kind] = (byKind[record.kind] || 0) + 1;
    return { dir, total: records.length, byKind };
  }

  loadSync();
  const stopCanonWatch = watchCanon ? startCanonWatch() : () => {};

  return {
    append,
    dir,
    distDir,
    flushProjection,
    forget,
    projectionPath: path.join(distDir, GLOBAL_PROJECTION_FILE),
    records: () => records.slice(),
    retrieve: (options) => core.retrieveMemories(records, { now: now(), ...options }),
    stats,
    stop,
  };
}

module.exports = { createMemoryStore, defaultMemoryDir, MEMORY_DIR_NAME };
