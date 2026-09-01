/*
 * M12 of docs/plan-visions-3.md, on the M12b substrate: the thin IO shell around
 * server/core/memory-core.ts. Every decision it makes comes from that core; this file only reads,
 * appends, projects and drains.
 *
 * The canon lives in the machine-wide database (server/memory-db.ts), which is what retired the O_EXCL
 * lockfile and the fs.watch reload: SQLite arbitrates the CLI-vs-server race itself, and a write another
 * connection committed is noticed by `PRAGMA data_version` rather than by watching a directory. The
 * PROJECTION is still plain markdown on disk, published by the one mill-style versioned writer below.
 *
 * PRIVACY: remembered text never reaches a log line here. Counts, ids, paths and verdicts do.
 */

import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs';
import path from 'node:path';

import { HOME_DB_REFUSED_CODE } from './core/db-path-guard.ts';
import * as core from './core/memory-core.ts';
import type { MemoryConfig, MemoryRecord, ProjectionManifest } from './core/memory-core.ts';
import * as distillCore from './core/memory-distill-core.ts';
import { isBusyError } from './glissa-db.ts';
import { createLaneLog } from './lane-log.ts';
import { writeTextAtomic, writeTextAtomicSync } from './json-file.ts';
import { createMemoryDb } from './memory-db.ts';
import type { MemoryDb, TailEntry } from './memory-db.ts';

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
const MAX_DELIVERED_HASHES = 2000;
// The index narrows the field; the pure rules still rank it, so the candidate set is wider than the answer.
const SEARCH_CANDIDATE_FACTOR = 10;
const SEARCH_CANDIDATE_FLOOR = 100;

interface ProjectionFile {
  relPath: string;
  content: string;
}

interface CanonicalProjectPlan {
  canonical: string | null;
  configured?: string | null;
  normalized?: string | null;
  knownProjects?: unknown[];
}

interface CanonicalPlanInput {
  project: unknown;
  knownProjects: unknown[];
  hasCachedProject: boolean;
  cachedProject: string | null | undefined;
  hasResolver: boolean;
}

type ProjectResolver = (input: { cwd: string; knownProjects: unknown[] | undefined }) => unknown;

interface MemoryStoreOptions {
  dir?: string;
  dbPath?: string;
  config?: MemoryConfig;
  fs?: typeof nodeFs;
  fsPromises?: typeof nodeFs.promises;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  logger?: Pick<Console, 'log' | 'warn'>;
  debug?: boolean | (() => boolean);
  projectionDebounceMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutFn?: (handle: NodeJS.Timeout) => void;
  openDb?: typeof createMemoryDb;
  busyTimeoutMs?: number;
  knownProjects?: unknown[] | (() => unknown);
  resolveProjectPath?: ProjectResolver | null;
  resolveProjectPathSync?: ProjectResolver | null;
}

interface ForgetOutcome {
  removedIds: string[];
  redactedIds: string[];
  droppedRows: number;
  tombstoneId: string | null;
  segments: number;
  tombstoneReason: string | null;
}

interface PublishOutcome {
  published: boolean;
  unchanged: boolean;
  skipped?: boolean;
  version?: string;
  manifest?: ProjectionManifest;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

function configuredProjectPathsSignature(knownProjects: unknown[]): string {
  return JSON.stringify(core.configuredProjectTags(knownProjects));
}

function planValueSignature(value: unknown): string {
  const type = value === null ? 'null' : typeof value;
  const text = String(value);
  return `${type}:${text.length}:${text}`;
}

function canonicalProjectPlanSignature(values: unknown[]): string {
  return values.map(planValueSignature).join('');
}

function createCanonicalProjectLookupPlanner(): (input: CanonicalPlanInput) => CanonicalProjectPlan | null {
  let memoizedProjectPathsSignature: string | null = null;
  let memoizedProjectTags: Set<string> | null = null;
  let memoizedPlanSignature: string | null = null;
  let memoizedPlan: CanonicalProjectPlan | null = null;
  return ({ project, knownProjects, hasCachedProject, cachedProject, hasResolver }) => {
    const projectPathsSignature = configuredProjectPathsSignature(knownProjects);
    if (projectPathsSignature !== memoizedProjectPathsSignature || !memoizedProjectTags) {
      memoizedProjectPathsSignature = projectPathsSignature;
      memoizedProjectTags = new Set(JSON.parse(projectPathsSignature));
    }
    const planSignature = canonicalProjectPlanSignature([
      project, projectPathsSignature, hasCachedProject, cachedProject, hasResolver,
    ]);
    if (planSignature === memoizedPlanSignature) return memoizedPlan;
    const normalized = core.normalizeProjectTag(project);
    const configured = core.canonicalProjectPath(normalized, knownProjects);
    let plan: CanonicalProjectPlan | null = null;
    if (!normalized || normalized !== configured || memoizedProjectTags.has(normalized)) {
      plan = { canonical: configured };
    }
    if (!plan && hasCachedProject) plan = { canonical: cachedProject ?? null };
    if (!plan && !hasResolver) plan = { canonical: configured };
    if (!plan) plan = { canonical: null, configured, normalized, knownProjects };
    memoizedPlan = plan;
    memoizedPlanSignature = planSignature;
    return memoizedPlan;
  };
}

function createMemoryStore(deps: MemoryStoreOptions = {}) {
  const {
    dir,
    dbPath,
    config = core.resolveMemoryConfig(null),
    fs = nodeFs,
    fsPromises = nodeFs.promises,
    now = () => Date.now(),
    randomBytes = (size: number) => nodeCrypto.randomBytes(size),
    logger = console,
    debug = false,
    projectionDebounceMs = DEFAULT_PROJECTION_DEBOUNCE_MS,
    setTimeoutFn = (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeoutFn = clearTimeout,
    openDb = createMemoryDb,
    busyTimeoutMs = undefined,
    knownProjects = [],
    resolveProjectPath = null,
    resolveProjectPathSync = null,
  } = deps;
  const buildCanonicalProjectLookupPlan = createCanonicalProjectLookupPlanner();

  if (typeof dir !== 'string' || !dir) throw new Error('createMemoryStore needs an explicit dir');
  if (typeof dbPath !== 'string' || !dbPath) throw new Error('createMemoryStore needs an explicit dbPath');

  const log = createLaneLog({ prefix: '[memory]', logger, debugFlag: debug });
  const distDir = path.join(dir, DIST_DIR_NAME);
  const currentDir = path.join(distDir, CURRENT_DIR_NAME);
  const previousDir = path.join(distDir, PREVIOUS_DIR_NAME);
  const pendingDir = path.join(dir, distillCore.PENDING_DIR_NAME);
  const hmacKeyPath = path.join(dir, HMAC_KEY_FILE);

  let signingKey: string | null = null;
  let records: MemoryRecord[] = [];
  let cachedDataVersion: number | null = null;
  let cachedLastAppendAt = 0;
  let stopped = false;
  let mutationChain: Promise<unknown> = Promise.resolve();
  let projectionChain: Promise<unknown> = Promise.resolve();
  let projectionTimer: NodeJS.Timeout | null = null;
  let projectionDirty = false;
  const canonicalProjectCache = new Map<string | null, string | null>();

  let db: MemoryDb | null = null;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    db = openDb({ dbPath, busyTimeoutMs });
  } catch (error) {
    // Never softened into a silent lane-off: the guard fires only in a test, where it must be loud.
    if (error && errorCode(error) === HOME_DB_REFUSED_CODE) throw error;
    log.warn(`the memory lane stays off: ${errorMessage(error)}`);
    return null;
  }
  if (!db) return null;
  const openedDb = db;

  // POSIX only: Windows reports no uid and no meaningful mode, so a planted key cannot be told apart
  // from a minted one there.
  function keyFileWasMintedHere(keyPath: string): boolean {
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
  function readOrMintSigningKey(): string {
    const keyPath = hmacKeyPath;
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

  // A row is trusted exactly as far as a canon LINE was: shape-checked, then verified or demoted.
  function verifiedRecord(raw: unknown): { record: MemoryRecord; demoted: boolean } | null {
    const shape = core.validateMemoryRecord(raw, { maxChars: config.maxRecordChars });
    if (!shape.valid) return null;
    return core.verifyOrDemote(shape.record, signingKey);
  }

  function canonicalProjectLookupPlan(project: unknown, resolver: ProjectResolver | null): CanonicalProjectPlan | null {
    const projects = core.readKnownProjects(knownProjects);
    const normalized = core.normalizeProjectTag(project);
    return buildCanonicalProjectLookupPlan({
      project,
      knownProjects: projects,
      hasCachedProject: canonicalProjectCache.has(normalized),
      cachedProject: canonicalProjectCache.get(normalized),
      hasResolver: typeof resolver === 'function',
    });
  }

  function canonicalProjectPathSync(project: unknown): string | null {
    const lookup = canonicalProjectLookupPlan(project, resolveProjectPathSync);
    if (!lookup || lookup.canonical !== null || !resolveProjectPathSync) return lookup?.canonical ?? null;
    // The only plan with a null canonical carries a non-empty tag, so this narrowing never fires.
    if (!lookup.normalized) return lookup.configured ?? null;
    const normalizedTag = lookup.normalized;
    try {
      const resolved = resolveProjectPathSync({ cwd: normalizedTag, knownProjects: lookup.knownProjects });
      const canonical = core.canonicalProjectPath(resolved, lookup.knownProjects) || lookup.configured || null;
      canonicalProjectCache.set(lookup.normalized ?? null, canonical);
      return canonical;
    } catch (error) {
      log.warn(`project path resolution failed for ${lookup.normalized}: ${errorMessage(error)}`);
      return lookup.configured ?? null;
    }
  }

  async function canonicalProjectPathForAppend(project: unknown): Promise<string | null> {
    const lookup = canonicalProjectLookupPlan(project, resolveProjectPath);
    if (!lookup || lookup.canonical !== null || !resolveProjectPath) return lookup?.canonical ?? null;
    if (!lookup.normalized) return lookup.configured ?? null;
    const normalizedTag = lookup.normalized;
    try {
      const resolved = await resolveProjectPath({ cwd: normalizedTag, knownProjects: lookup.knownProjects });
      const canonical = core.canonicalProjectPath(resolved, lookup.knownProjects) || lookup.configured || null;
      canonicalProjectCache.set(lookup.normalized ?? null, canonical);
      return canonical;
    } catch (error) {
      log.warn(`project path resolution failed for ${lookup.normalized}: ${errorMessage(error)}`);
      return lookup.configured ?? null;
    }
  }

  async function canonicalizeInputProject(input: unknown): Promise<unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
    const source = input as { project?: unknown };
    const project = await canonicalProjectPathForAppend(source.project);
    if (project === source.project) return input;
    return { ...source, project };
  }

  function assembleRecords(rawRecords: MemoryRecord[]) {
    const loaded: MemoryRecord[] = [];
    let invalid = 0;
    let demoted = 0;
    for (const raw of rawRecords) {
      const checked = verifiedRecord(raw);
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

  /*
   * The version is sampled BEFORE the read, never after: a commit landing between the two would
   * otherwise be stamped as already-loaded and swallowed forever. Sampling first can only cost a
   * redundant reload, which is the safe direction.
   */
  function refreshFromDb() {
    cachedDataVersion = openedDb.dataVersion();
    const assembled = assembleRecords(openedDb.listRecords());
    records = assembled.records;
    return assembled;
  }

  /*
   * The whole cross-process story after the lockfile. `PRAGMA data_version` moves only when ANOTHER
   * connection commits, so a `glissa memory forget` run against a live server is noticed on the next
   * read instead of being watched for, and this store can never serve text another process expunged.
   */
  function currentRecords(): MemoryRecord[] {
    if (stopped) return records;
    try {
      if (openedDb.dataVersion() === cachedDataVersion) return records;
    } catch {
      return records;
    }
    const assembled = refreshFromDb();
    log.note(`the canon changed under us: reloaded ${records.length} record(s), ${assembled.demoted} demoted`);
    return records;
  }

  // Boot only, a one-shot cold path: the whole canon is read once before the server serves anything.
  function load(): void {
    signingKey = readOrMintSigningKey();
    const projectTagMigration = openedDb.migrateProjectTags((record) => {
      const project = canonicalProjectPathSync(record.project);
      if (project === record.project) return record;
      const migrated = { ...record, project };
      if (!core.verifyRecordSignature(record, signingKey)) return migrated;
      return core.withSignature(migrated, signingKey);
    });
    if (projectTagMigration.applied) {
      log.note(`project tag migration remapped ${projectTagMigration.remapped} of ${projectTagMigration.examined} tagged record(s)`);
    }
    const expired = core.expiredSegmentKeys(openedDb.segmentKeys(), { now: now(), retainDays: config.retainDays });
    const droppedRows = expired.length === 0 ? 0 : openedDb.deleteSegments(expired);
    openedDb.ensureSearchIndex();
    const assembled = refreshFromDb();
    cachedLastAppendAt = openedDb.lastAppendAt();
    log.note(
      `loaded ${records.length} record(s): ${expired.length} expired segment(s) dropped `
      + `(${droppedRows} record(s)), ${assembled.dropped} over cap, `
      + `${assembled.invalid} invalid, ${assembled.demoted} demoted`,
    );
  }

  function queue<T>(work: () => Promise<T> | T): Promise<T | null> {
    if (stopped) return Promise.resolve(null);
    const next = Promise.resolve(mutationChain).then(() => work());
    mutationChain = next.then(() => {}, () => {});
    return next;
  }

  async function writeOutputs(targetDir: string, outputs: ProjectionFile[]): Promise<void> {
    for (const file of outputs) {
      const destination = path.join(targetDir, file.relPath);
      await fsPromises.mkdir(path.dirname(destination), { recursive: true, mode: DIR_MODE });
      await fsPromises.writeFile(destination, file.content, { encoding: 'utf8', mode: FILE_MODE });
    }
  }

  async function clearStaleTmpDirs(): Promise<void> {
    let entries: nodeFs.Dirent[] = [];
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

  async function readCurrentFile(relPath: string): Promise<string | null> {
    try {
      return await fsPromises.readFile(path.join(currentDir, relPath), 'utf8');
    } catch {
      return null;
    }
  }

  async function readPublishedManifest(): Promise<ProjectionManifest | null> {
    const raw = await readCurrentFile(core.PROJECTION_MANIFEST_FILE);
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as ProjectionManifest : null;
    } catch {
      return null;
    }
  }

  // manifest.json is as writable as any other file here, so its paths are treated as untrusted input.
  function isContainedRelPath(relPath: unknown): relPath is string {
    if (typeof relPath !== 'string' || !relPath) return false;
    if (path.isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)) return false;
    return !relPath.split(/[\\/]/).includes('..');
  }

  async function readPublishedDocuments(manifest: ProjectionManifest | null | undefined): Promise<string[]> {
    const documents: string[] = [];
    for (const file of Array.isArray(manifest?.files) ? manifest.files : []) {
      if (file.relPath === core.PROJECTION_MANIFEST_FILE) continue;
      if (!isContainedRelPath(file.relPath)) {
        log.warn('the published manifest names a file outside the build: it was skipped');
        continue;
      }
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
  }: {
    files: ProjectionFile[];
    source?: string;
    verdict?: string | null;
    distilledAt?: number | null;
    recordCount?: number;
    claimCount?: number | null;
    watermark?: { hash?: unknown } | null;
  }): Promise<PublishOutcome> {
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
  async function publishPending({ files, watermark = null, recordCount = 0, claimCount = null }: {
    files: ProjectionFile[];
    watermark?: { hash?: unknown } | null;
    recordCount?: number;
    claimCount?: number | null;
  }): Promise<{ version: string; dir: string }> {
    const plan = core.planProjectionBuild({
      files, watermark, builtAt: now(), source: 'distill', verdict: 'DISTILLED', recordCount, claimCount,
    });
    await fsPromises.rm(pendingDir, { recursive: true, force: true });
    await fsPromises.mkdir(pendingDir, { recursive: true, mode: DIR_MODE });
    await writeOutputs(pendingDir, plan.outputs);
    return { version: plan.version, dir: pendingDir };
  }

  function trivialFiles(valid: MemoryRecord[]): ProjectionFile[] {
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
  async function writeProjection({ force = false }: { force?: boolean } = {}): Promise<PublishOutcome> {
    projectionDirty = false;
    const valid = core.selectValidRecords(currentRecords(), { now: now() });
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
    log.debugNote(() => `projection ${outcome.published ? 'published' : 'unchanged'} at ${String(outcome.version).slice(0, 12)}`);
    return outcome;
  }

  function scheduleProjection(): void {
    projectionDirty = true;
    if (projectionTimer) return;
    projectionTimer = setTimeoutFn(() => {
      projectionTimer = null;
      projectionChain = queue(() => writeProjection()).catch(() => log.warn('projection write failed'));
    }, projectionDebounceMs);
    if (projectionTimer && typeof projectionTimer.unref === 'function') projectionTimer.unref();
  }

  // A supersession must carry its ancestry or the core refuses it; the store is the only place that can
  // resolve the superseded record's own rank, so a caller cannot skip the lineage cap by omission.
  function withResolvedAncestors(input: unknown): Record<string, unknown> {
    const raw = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
    const supersedes = typeof raw.supersedes === 'string' ? raw.supersedes.trim() : '';
    if (!supersedes || Array.isArray(raw.ancestorLineages)) return raw;
    const target = records.find((record) => record.id === supersedes);
    if (!target) return raw;
    return { ...raw, ancestorLineages: [core.effectiveRank(target)] };
  }

  // Trust fields come from the CALLING path, never from the remembered text.
  function buildForAppend(input: unknown): MemoryRecord | null {
    const built = core.buildMemoryRecord(withResolvedAncestors(input), {
      now: now(), maxChars: config.maxRecordChars, retainDays: config.retainDays,
    });
    if (!built.ok) {
      log.debugNote(() => `record rejected: ${built.reason}`);
      return null;
    }
    return core.withSignature(built.record, signingKey);
  }

  /*
   * One transaction per batch, because the M14 consumer hands this whole ticks' worth of records at once
   * and every session on this machine shares the event loop the commit runs on. The id is the moment plus
   * the text, so a re-read of the same transcript bytes is idempotent: the INSERT is ignored.
   *
   * `refused` separates a SUBSTRATE refusal from the gates refusing every record: they look identical in
   * the returned array, and a caller that reads them as the same advances its durable offset past a range
   * nothing remembered.
   */
  async function appendMany(inputs: unknown): Promise<{ records: (MemoryRecord | null)[]; refused: boolean }> {
    const outcome = await queue(async () => {
      const list = Array.isArray(inputs) ? inputs : [];
      if (list.length === 0) return { records: [], refused: false };
      const canonicalInputs: unknown[] = [];
      for (const input of list) canonicalInputs.push(await canonicalizeInputProject(input));
      currentRecords();
      const observedBefore = cachedDataVersion;
      const written: MemoryRecord[] = [];
      let observedInside = observedBefore;
      let stored: (MemoryRecord | null)[] = [];
      try {
        stored = openedDb.transaction(() => {
          const out: (MemoryRecord | null)[] = [];
          for (const input of canonicalInputs) {
            const signed = buildForAppend(input);
            const seq = signed === null ? false : openedDb.insertRecord(signed);
            if (!seq || signed === null) {
              log.debugNote(() => (signed === null ? 'record rejected' : 'record already remembered'));
              out.push(null);
              continue;
            }
            const stamped = { ...signed, seq };
            out.push(stamped);
            written.push(stamped);
          }
          if (written.length > 0) openedDb.setLastAppendAt(now());
          // Sampled under the write lock, so no other connection can commit between here and our COMMIT.
          observedInside = openedDb.dataVersion();
          return out;
        });
      } catch (error) {
        if (!isBusyError(error)) throw error;
        log.warn('the memory database is busy: nothing was appended');
        return { records: list.map(() => null), refused: true };
      }
      // A commit that landed between our last read and the transaction is one we never loaded.
      if (observedInside !== observedBefore) refreshFromDb();
      if (observedInside === observedBefore && written.length > 0) {
        records = core.applySupersessions([...records, ...written]);
        cachedDataVersion = observedInside;
      }
      if (written.length === 0) return { records: stored, refused: false };
      cachedLastAppendAt = openedDb.lastAppendAt();
      scheduleProjection();
      return { records: stored, refused: false };
    });
    if (!outcome) return { records: [], refused: false };
    return outcome;
  }

  function append(input: unknown): Promise<MemoryRecord | null> {
    return appendMany([input]).then((outcome) => outcome.records[0] || null);
  }

  /*
   * The one sanctioned rewrite of an append-only canon, and ONE transaction: the redactions, the removals
   * and the audit tombstone land together or not at all, so a concurrent append cannot interleave with a
   * half-applied expunge. Every survivor is re-signed from its VERIFIED (so possibly demoted) self, so an
   * unsigned forgery cannot be laundered into a signed operator record by an operator running forget.
   */
  function runForget(matcher: core.ForgetMatcher): ForgetOutcome | null {
    const removedIds: string[] = [];
    const redactedIds: string[] = [];
    const segments = new Set<string>();
    let droppedRows = 0;
    for (const raw of openedDb.listRecords()) {
      const checked = verifiedRecord(raw);
      // A row too malformed to become a record still holds its bytes, so the expunge judges it RAW.
      if (!checked) {
        if (!core.matchesForgetPattern(JSON.stringify(raw), matcher)) continue;
        openedDb.deleteRecord(raw.id);
        segments.add(core.segmentKeyForTs(raw.ts));
        droppedRows += 1;
        continue;
      }
      const verdict = core.decideForget(checked.record, matcher);
      if (verdict.action === 'keep') continue;
      segments.add(core.segmentKeyForTs(checked.record.ts));
      if (verdict.action === 'remove') {
        openedDb.deleteRecord(checked.record.id);
        removedIds.push(checked.record.id);
        continue;
      }
      openedDb.updateRecordText(core.withSignature({ ...checked.record, text: verdict.text }, signingKey));
      redactedIds.push(checked.record.id);
    }
    if (removedIds.length + redactedIds.length + droppedRows === 0) return null;
    const built = core.buildMemoryRecord({
      kind: 'tombstone',
      layer: 'episodic',
      project: null,
      source: { kind: 'operator', vendor: 'glissa', sessionId: null },
      text: core.tombstoneText([...removedIds, ...redactedIds]),
    }, { now: now(), maxChars: config.maxRecordChars });
    let tombstoneId: string | null = null;
    if (built.ok && built.record && openedDb.insertRecord(core.withSignature(built.record, signingKey))) {
      tombstoneId = built.record.id;
      openedDb.setLastAppendAt(now());
    }
    // Last inside the transaction: a deleted row's words survive in the index's segments until this runs.
    openedDb.scrubSearchIndex();
    return {
      removedIds,
      redactedIds,
      droppedRows,
      tombstoneId,
      segments: segments.size,
      tombstoneReason: built.ok ? null : built.reason,
    };
  }

  /*
   * The forget's own publish rotates the PRE-forget build into previous/, and a dist-pending/ build
   * predates the expunge by construction, so both hold the text that was just expunged. Neither is
   * delivered from, so dropping them costs a rollback slot and a review copy, not a projection.
   */
  async function discardSupersededBuilds(): Promise<void> {
    for (const target of [previousDir, pendingDir]) {
      await fsPromises.rm(target, { recursive: true, force: true })
        .catch((error: unknown) => log.warn(`could not drop a superseded build: ${errorMessage(error)}`));
    }
  }

  function forget(idOrPattern: unknown) {
    return queue(async () => {
      const nothing = {
        ok: false, reason: 'no-match', removed: 0, redacted: 0, segments: 0, tombstoneId: null as string | null,
      };
      const matcher = core.makeForgetMatcher(idOrPattern);
      if (!matcher) return nothing;
      let outcome: ForgetOutcome | null = null;
      try {
        outcome = openedDb.transaction(() => runForget(matcher));
      } catch (error) {
        if (!isBusyError(error)) throw error;
        // Reported as `locked` because that is what the operator is being told: another writer holds it.
        log.warn('the memory database is busy: nothing was forgotten');
        return { ...nothing, reason: 'locked' };
      }
      if (!outcome) return nothing;
      if (!outcome.tombstoneId) log.warn(`tombstone rejected: ${outcome.tombstoneReason || 'not written'}`);
      // The committed expunge is still readable in the write-ahead log until the frames are reclaimed.
      if (!openedDb.checkpoint()) log.debugNote(() => 'wal checkpoint refused: expunged frames linger until close');
      refreshFromDb();
      cachedLastAppendAt = openedDb.lastAppendAt();
      if (projectionTimer) clearTimeoutFn(projectionTimer);
      projectionTimer = null;
      await writeProjection({ force: true });
      await discardSupersededBuilds();
      const removed = outcome.removedIds.length + outcome.droppedRows;
      log.note(`forget removed ${removed}, redacted ${outcome.redactedIds.length}, across ${outcome.segments} segment(s)`);
      return {
        ok: true,
        reason: null,
        removed,
        redacted: outcome.redactedIds.length,
        segments: outcome.segments,
        tombstoneId: outcome.tombstoneId,
      };
    });
  }

  function flushProjection() {
    return queue(async () => {
      if (projectionTimer) clearTimeoutFn(projectionTimer);
      projectionTimer = null;
      await writeProjection();
      return true;
    });
  }

  // Latched BEFORE the drain, so a write racing shutdown is refused rather than queued behind it.
  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    if (projectionTimer) clearTimeoutFn(projectionTimer);
    projectionTimer = null;
    await mutationChain;
    await projectionChain;
    if (projectionDirty) await writeProjection().catch(() => log.warn('projection write failed during shutdown'));
    try {
      openedDb.close();
    } catch (error) {
      log.warn(`closing the memory database failed: ${errorMessage(error)}`);
    }
  }

  // One object rather than one per ingested event: this is read on the consumer's hot path.
  const deliveredView = { has: (hash: string) => openedDb.deliveredHas(hash) };

  // Echo suppression's delivery half: M16 registers what it hands out, the ingest consumer drops those lines.
  function noteDelivered(text: unknown): number {
    const hashes = core.deliveredLineHashes(text);
    if (hashes.length === 0) return openedDb.deliveredCount();
    try {
      return openedDb.noteDelivered(hashes, { maxHashes: MAX_DELIVERED_HASHES });
    } catch (error) {
      if (!isBusyError(error)) throw error;
      log.debugNote(() => 'the delivered-hash write was refused: the database is busy');
      return openedDb.deliveredCount();
    }
  }

  // The index narrows the candidates; the pure rules gate and rank them, so an unavailable index costs
  // relevance and never an answer.
  function searchMatches(terms: string[], limit: number): string[] | null {
    if (terms.length === 0) return null;
    try {
      return openedDb.searchIds(terms, Math.max(SEARCH_CANDIDATE_FLOOR, limit * SEARCH_CANDIDATE_FACTOR));
    } catch (error) {
      log.debugNote(() => `the search index is unavailable: ${String(errorCode(error) || 'unknown')}`);
      return null;
    }
  }

  function retrieve(options: { limit?: number; query?: string; [key: string]: unknown } = {}) {
    const list = currentRecords();
    const limit = Number.isFinite(options.limit) ? Number(options.limit) : core.DEFAULT_RETRIEVAL_LIMIT;
    const matchedIds = searchMatches(core.tokenizeQuery(options.query || ''), limit);
    return core.retrieveMemories(list, { now: now(), ...options, matchedIds });
  }

  /*
   * A refused offset write costs a re-read of that range, never the range itself, so nothing here throws:
   * this runs inside the ingest source's drain, and an unwritable offset must not cost the records.
   */
  function saveTailOffset(entry: TailEntry, options?: { maxEntries?: number }): boolean {
    try {
      openedDb.saveTailOffset(entry, options);
      return true;
    } catch (error) {
      if (isBusyError(error)) log.debugNote(() => 'a tail offset write was refused: the database is busy');
      if (!isBusyError(error)) log.warn(`a tail offset write failed: ${errorMessage(error)}`);
      return false;
    }
  }

  function forgetTails(paths: string[]): boolean {
    try {
      openedDb.forgetTails(paths);
      return true;
    } catch (error) {
      log.warn(`forgetting ${paths.length} tail offset(s) failed: ${errorMessage(error)}`);
      return false;
    }
  }

  function stats() {
    const byKind: Record<string, number> = {};
    for (const record of currentRecords()) byKind[record.kind] = (byKind[record.kind] || 0) + 1;
    return { dir, dbPath, total: records.length, byKind };
  }

  load();

  return {
    append,
    appendMany,
    // The third write of an expunge, exposed because a rebuild after one leaves fresh frames in the log.
    checkpoint: () => openedDb.checkpoint(),
    currentDir,
    dbPath,
    deliveredHashes: () => deliveredView,
    dir,
    distillCursorSeq: () => (stopped ? 0 : openedDb.distillCursorSeq()),
    distillFailures: () => (stopped ? 0 : openedDb.distillFailures()),
    distDir,
    flushProjection,
    forget,
    forgetTails,
    lastAppendAt: () => {
      if (stopped) return cachedLastAppendAt;
      cachedLastAppendAt = openedDb.lastAppendAt();
      return cachedLastAppendAt;
    },
    noteDelivered,
    pendingDir,
    projectionPath: path.join(currentDir, core.GLOBAL_PROJECTION_FILE),
    // Queued like every other write, so a distill publish and a fallback render can never interleave.
    publishPending: (args: Parameters<typeof publishPending>[0]) => queue(() => publishPending(args)),
    publishProjection: (args: Parameters<typeof publishProjection>[0]) => queue(() => publishProjection(args)),
    readPublishedDocuments,
    readPublishedManifest,
    rebuildSearchIndex: () => openedDb.rebuildSearchIndex(),
    records: () => currentRecords().slice(),
    retrieve,
    saveTailOffset,
    // Queued with the writes: a cursor advance may not interleave with the publish it is a receipt for.
    setDistillCursorSeq: (seq: number) => queue(async () => openedDb.setDistillCursorSeq(seq)),
    setDistillFailures: (count: number) => queue(async () => openedDb.setDistillFailures(count)),
    search: (query: unknown, { limit = SEARCH_CANDIDATE_FLOOR }: { limit?: number } = {}) => searchMatches(core.tokenizeQuery(query), limit),
    stats,
    stop,
    tailState: () => openedDb.tailState(),
    validRecords: () => core.selectValidRecords(currentRecords(), { now: now() }),
    watermark: () => core.canonWatermark(core.selectValidRecords(currentRecords(), { now: now() })),
  };
}

export { MEMORY_DIR_NAME, createCanonicalProjectLookupPlanner, createMemoryStore };
export type { MemoryStoreOptions, ProjectionFile };
