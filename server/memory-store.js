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
const distillCore = require('./core/memory-distill-core');

const MEMORY_DIR_NAME = 'memory';
const HMAC_KEY_FILE = 'hmac-key';
const DIST_DIR_NAME = 'dist';
const CURRENT_DIR_NAME = 'current';
const PREVIOUS_DIR_NAME = 'previous';
const TMP_DIR_PREFIX = 'tmp-';
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
// Comfortably inside LOCK_STALE_MS, so a long pass keeps a lock nobody may treat as abandoned.
const LOCK_REFRESH_MS = 1500;
const MAX_DELIVERED_HASHES = 2000;
const CANON_WATCH_DEBOUNCE_MS = 200;
// The longest an unbroken event stream may defer the trailing refresh; without it a storm defers forever.
const CANON_WATCH_MAX_WAIT_MS = 1000;

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
  const currentDir = path.join(distDir, CURRENT_DIR_NAME);
  const previousDir = path.join(distDir, PREVIOUS_DIR_NAME);
  const pendingDir = path.join(dir, distillCore.PENDING_DIR_NAME);

  let signingKey = null;
  let records = [];
  let stopped = false;
  let mutationChain = Promise.resolve();
  let projectionChain = Promise.resolve();
  let projectionTimer = null;
  let projectionDirty = false;
  let lastAppendAt = 0;

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
  let canonLockDepth = 0;

  function readLockNonce() {
    try {
      return fs.readFileSync(lockPath, 'utf8');
    } catch {
      return null;
    }
  }

  /*
   * Real wall clock, not the injected now(): this is compared against a filesystem mtime. The nonce is
   * what makes the removal safe under a race: two processes can both judge one lock stale, and without
   * re-reading, the second unlink deletes the FRESH lock the first had just taken. Only the exact holder
   * judged stale is removed, and a lock whose nonce or mtime moved in between is left alone.
   */
  function removeStaleLock() {
    const nonce = readLockNonce();
    if (nonce === null) return true;
    let staleAtMs = 0;
    try {
      const stat = fs.statSync(lockPath);
      if (Date.now() - stat.mtimeMs <= LOCK_STALE_MS) return false;
      staleAtMs = stat.mtimeMs;
    } catch {
      return true;
    }
    try {
      if (readLockNonce() !== nonce) return false;
      if (fs.statSync(lockPath).mtimeMs !== staleAtMs) return false;
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
        const handle = fs.openSync(lockPath, 'wx', FILE_MODE);
        // The holder's identity, so a stale-lock removal can prove it is deleting the lock it judged.
        fs.writeSync(handle, `${process.pid}:${randomBytes(8).toString('hex')}\n`);
        fs.closeSync(handle);
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

  async function writeOutputs(targetDir, outputs) {
    for (const file of outputs) {
      const destination = path.join(targetDir, file.relPath);
      await fsPromises.mkdir(path.dirname(destination), { recursive: true, mode: DIR_MODE });
      await fsPromises.writeFile(destination, file.content, { encoding: 'utf8', mode: FILE_MODE });
    }
  }

  async function clearStaleTmpDirs() {
    let entries = [];
    try {
      entries = await fsPromises.readdir(distDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(TMP_DIR_PREFIX)) continue;
      await fsPromises.rm(path.join(distDir, entry.name), { recursive: true, force: true });
    }
  }

  async function readCurrentFile(relPath) {
    try {
      return await fsPromises.readFile(path.join(currentDir, relPath), 'utf8');
    } catch {
      return null;
    }
  }

  async function readPublishedManifest() {
    const raw = await readCurrentFile(core.PROJECTION_MANIFEST_FILE);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async function readPublishedDocuments(manifest) {
    const documents = [];
    for (const file of Array.isArray(manifest?.files) ? manifest.files : []) {
      if (file.relPath === core.PROJECTION_MANIFEST_FILE) continue;
      const text = await readCurrentFile(file.relPath);
      if (text !== null) documents.push(text);
    }
    return documents;
  }

  /*
   * The mill's publish, on the projection: tmp sibling, rotate current to previous, rename in. An
   * unchanged version rewrites manifest.json alone, so a build whose bytes did not move still records
   * the watermark it was measured at instead of re-running on every tick.
   */
  async function publishProjection({
    files, source = 'trivial', verdict = null, distilledAt = null, recordCount = 0, claimCount = null,
    watermark = null,
  }) {
    const plan = core.planProjectionBuild({
      files, watermark, builtAt: now(), source, verdict, distilledAt, recordCount, claimCount,
    });
    const published = await readPublishedManifest();
    if (published && published.version === plan.version) {
      await writeTextAtomic(path.join(currentDir, core.PROJECTION_MANIFEST_FILE), `${JSON.stringify(plan.manifest, null, 2)}\n`, {
        fsPromises, mkdir: true, mode: FILE_MODE,
      });
      return { published: false, unchanged: true, version: plan.version, manifest: plan.manifest };
    }
    await fsPromises.mkdir(distDir, { recursive: true, mode: DIR_MODE });
    await clearStaleTmpDirs();
    const tmpDir = path.join(distDir, `${TMP_DIR_PREFIX}${randomBytes(6).toString('hex')}`);
    await fsPromises.mkdir(tmpDir, { recursive: true, mode: DIR_MODE });
    await writeOutputs(tmpDir, plan.outputs);
    const hasCurrent = await fsPromises.stat(currentDir).then(() => true, () => false);
    if (hasCurrent) {
      await fsPromises.rm(previousDir, { recursive: true, force: true });
      await fsPromises.rename(currentDir, previousDir);
    }
    await fsPromises.rename(tmpDir, currentDir);
    return { published: true, unchanged: false, version: plan.version, manifest: plan.manifest };
  }

  // The locked-diff holding pen: never rotated and never read by a delivery, so an operator reviews it.
  async function publishPending({ files, watermark = null, recordCount = 0, claimCount = null }) {
    const plan = core.planProjectionBuild({
      files, watermark, builtAt: now(), source: 'distill', verdict: 'DISTILLED', recordCount, claimCount,
    });
    await fsPromises.rm(pendingDir, { recursive: true, force: true });
    await fsPromises.mkdir(pendingDir, { recursive: true, mode: DIR_MODE });
    await writeOutputs(pendingDir, plan.outputs);
    return { version: plan.version, dir: pendingDir };
  }

  function trivialFiles(valid) {
    const files = [{ relPath: core.GLOBAL_PROJECTION_FILE, content: core.renderProjection(valid, { project: null }) }];
    for (const tag of core.projectTagsOf(valid)) {
      files.push({
        relPath: `${core.PROJECTS_DIR_NAME}/${core.projectFileSlug(tag)}.md`,
        content: core.renderProjection(valid, { project: tag }),
      });
    }
    return files;
  }

  /*
   * The day-one renderer, and now the FALLBACK: once the distill lane has published, its build owns
   * dist/ and an append must not overwrite it with raw records. A forget forces its way through, since
   * expunged text may not survive in a published file until the next distill run.
   */
  async function writeProjection({ force = false } = {}) {
    projectionDirty = false;
    const valid = core.selectValidRecords(records, { now: now() });
    const published = await readPublishedManifest();
    if (!force && published && published.source === 'distill') {
      log.debugNote(() => 'a distilled projection is published: the fallback renderer wrote nothing');
      return { published: false, unchanged: true, skipped: true };
    }
    const outcome = await publishProjection({
      files: trivialFiles(valid),
      source: 'trivial',
      watermark: core.canonWatermark(valid),
      recordCount: valid.length,
    });
    log.debugNote(() => `projection ${outcome.published ? 'published' : 'unchanged'} at ${outcome.version.slice(0, 12)}`);
    return outcome;
  }

  function scheduleProjection() {
    projectionDirty = true;
    if (projectionTimer) return;
    projectionTimer = setTimeoutFn(() => {
      projectionTimer = null;
      projectionChain = queue(() => writeProjection()).catch(() => log.warn('projection write failed'));
    }, projectionDebounceMs);
    if (projectionTimer && typeof projectionTimer.unref === 'function') projectionTimer.unref();
  }

  async function appendSigned(record) {
    await appendJsonLine(canonPath(core.segmentKeyForTs(record.ts)), record, {
      fsPromises, mkdir: true, mode: FILE_MODE,
    });
    lastAppendAt = now();
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
        now: now(), maxChars: config.maxRecordChars, retainDays: config.retainDays,
      });
      if (!built.ok) {
        log.debugNote(() => `record rejected: ${built.reason}`);
        return null;
      }
      // The id is the moment plus the text, so a re-read of the same transcript bytes is idempotent.
      if (records.some((record) => record.id === built.record.id)) {
        log.debugNote(() => 'record already remembered');
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
      await writeProjection({ force: true });
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
    let deferringSince = 0;

    function stopWatch() {
      clearTimeout(timer);
      if (!watcher) return;
      try {
        watcher.close();
      } catch {}
      watcher = null;
    }

    // A removed watch target storms change events on Windows rather than erroring, so it ends the watch.
    function closeIfCanonGone() {
      if (fs.existsSync(canonicalizePath(dir))) return;
      log.warn('the canon directory is gone: the watch is closed');
      stopWatch();
    }

    function refresh() {
      deferringSince = 0;
      closeIfCanonGone();
      if (!watcher) return;
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
        const at = Date.now();
        if (!deferringSince) deferringSince = at;
        if (at - deferringSince < CANON_WATCH_MAX_WAIT_MS) return;
        // An unbroken stream re-arms the debounce forever, so the vanished-target check gets its own beat.
        deferringSince = at;
        closeIfCanonGone();
      });
    } catch (error) {
      log.warn(`could not watch the canon directory: ${error.message}`);
    }

    return stopWatch;
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

  // Echo suppression's delivery half: M16 registers what it hands out, the ingest consumer drops those lines.
  const deliveredHashes = new Set();

  function noteDelivered(text) {
    for (const hash of core.deliveredLineHashes(text)) {
      deliveredHashes.delete(hash);
      deliveredHashes.add(hash);
    }
    while (deliveredHashes.size > MAX_DELIVERED_HASHES) {
      const oldest = deliveredHashes.values().next().value;
      deliveredHashes.delete(oldest);
    }
    return deliveredHashes.size;
  }

  /*
   * Held for a whole pass, mtime refreshed, so the staleness rule cannot hand the lock to a second copy.
   * `reentrant` piggybacks on a hold this process already has, which is what lets a tail-state write
   * inside a backfill take the same lock the backfill is holding without deadlocking on it. Only the
   * short writes pass it: a long pass always takes a REAL lock, so it can never inherit one that a
   * millisecond-long write is about to release.
   */
  async function withCanonLock(work, { reentrant = false } = {}) {
    if (reentrant && canonLockDepth > 0) return { locked: true, result: await work() };
    if (!await acquireCanonLock()) return { locked: false, result: null };
    canonLockDepth += 1;
    const refresh = setInterval(() => {
      try {
        const at = new Date();
        fs.utimesSync(lockPath, at, at);
      } catch (error) {
        // A lock that vanished mid-pass means a second process may already be reading; codes only, never content.
        log.debugNote(() => `canon lock refresh failed on ${lockPath}: ${error.code || 'unknown'}`);
      }
    }, LOCK_REFRESH_MS);
    if (typeof refresh.unref === 'function') refresh.unref();
    try {
      return { locked: true, result: await work() };
    } finally {
      canonLockDepth -= 1;
      clearInterval(refresh);
      releaseCanonLock();
    }
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
    currentDir,
    deliveredHashes: () => deliveredHashes,
    dir,
    distDir,
    flushProjection,
    forget,
    lastAppendAt: () => lastAppendAt,
    noteDelivered,
    pendingDir,
    projectionPath: path.join(currentDir, core.GLOBAL_PROJECTION_FILE),
    // Queued like every other write, so a distill publish and a fallback render can never interleave.
    publishPending: (args) => queue(() => publishPending(args)),
    publishProjection: (args) => queue(() => publishProjection(args)),
    readPublishedDocuments,
    readPublishedManifest,
    records: () => records.slice(),
    retrieve: (options) => core.retrieveMemories(records, { now: now(), ...options }),
    stats,
    stop,
    validRecords: () => core.selectValidRecords(records, { now: now() }),
    watermark: () => core.canonWatermark(core.selectValidRecords(records, { now: now() })),
    withCanonLock,
  };
}

module.exports = { createMemoryStore, defaultMemoryDir, MEMORY_DIR_NAME };
