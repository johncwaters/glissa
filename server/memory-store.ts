
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
    if (error && errorCode(error) === HOME_DB_REFUSED_CODE) throw error;
    log.warn(`the memory lane stays off: ${errorMessage(error)}`);
    return null;
  }
  if (!db) return null;
  const openedDb = db;

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

  function refreshFromDb() {
    cachedDataVersion = openedDb.dataVersion();
    const assembled = assembleRecords(openedDb.listRecords());
    records = assembled.records;
    return assembled;
  }

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

  function withResolvedAncestors(input: unknown): Record<string, unknown> {
    const raw = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
    const supersedes = typeof raw.supersedes === 'string' ? raw.supersedes.trim() : '';
    if (!supersedes || Array.isArray(raw.ancestorLineages)) return raw;
    const target = records.find((record) => record.id === supersedes);
    if (!target) return raw;
    return { ...raw, ancestorLineages: [core.effectiveRank(target)] };
  }

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
          observedInside = openedDb.dataVersion();
          return out;
        });
      } catch (error) {
        if (!isBusyError(error)) throw error;
        log.warn('the memory database is busy: nothing was appended');
        return { records: list.map(() => null), refused: true };
      }
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

  function runForget(matcher: core.ForgetMatcher): ForgetOutcome | null {
    const removedIds: string[] = [];
    const redactedIds: string[] = [];
    const segments = new Set<string>();
    let droppedRows = 0;
    for (const raw of openedDb.listRecords()) {
      const checked = verifiedRecord(raw);
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
        log.warn('the memory database is busy: nothing was forgotten');
        return { ...nothing, reason: 'locked' };
      }
      if (!outcome) return nothing;
      if (!outcome.tombstoneId) log.warn(`tombstone rejected: ${outcome.tombstoneReason || 'not written'}`);
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

  const deliveredView = { has: (hash: string) => openedDb.deliveredHas(hash) };

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
    publishPending: (args: Parameters<typeof publishPending>[0]) => queue(() => publishPending(args)),
    publishProjection: (args: Parameters<typeof publishProjection>[0]) => queue(() => publishProjection(args)),
    readPublishedDocuments,
    readPublishedManifest,
    rebuildSearchIndex: () => openedDb.rebuildSearchIndex(),
    records: () => currentRecords().slice(),
    retrieve,
    saveTailOffset,
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
