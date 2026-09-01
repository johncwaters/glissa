import path from 'node:path';
import fsPromisesDefault from 'node:fs/promises';
import {
  MillMetricEvent,
  MillMetricSessionRecord,
  MillMetricStore,
} from '../shared/contracts/mill-metrics.ts';
import type { MillMetricPack, MillMetricSession } from '../shared/contracts/mill-metrics.ts';
import {
  DEFAULT_MILL_METRICS_RETAIN_DAYS,
  mergeRecords,
  pruneRecords,
  utcDay,
} from './core/mill-metrics-core.ts';
import { cutoffDayKey } from './core/usage-warehouse-core.ts';
import { appendJsonLine, appendJsonLineIdle, createJsonStateWriter } from './json-file.ts';

type StoreFileSystem = Pick<
  typeof fsPromisesDefault,
  'appendFile' | 'mkdir' | 'readdir' | 'rename' | 'rm' | 'writeFile'
> & {
  readFile: (target: string, encoding: 'utf8') => Promise<string>;
};

const EVENT_FILE_PATTERN = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/;

type Logger = Pick<Console, 'warn'>;

type MillMetricsStoreOptions = {
  recordsPath: string;
  eventsDir: string;
  retainDays?: number;
  fsPromises?: StoreFileSystem;
  nowFn?: () => number;
  logger?: Logger | null;
};

function createMillMetricsStore({
  recordsPath,
  eventsDir,
  retainDays = DEFAULT_MILL_METRICS_RETAIN_DAYS,
  fsPromises = fsPromisesDefault,
  nowFn = Date.now,
  logger = null,
}: MillMetricsStoreOptions) {
  let sessionRecords: MillMetricSession[] = [];
  let queuedRecords: MillMetricSession[] = [];
  let recordsLoaded = false;
  let opsChain: Promise<void> = Promise.resolve();
  let loadPromise: Promise<void> | null = null;
  let lastEventPruneDay: string | null = null;
  const warnedEventKinds = new Set<string>();
  const eventPaths = new Set<string>();

  function warn(message: string): void {
    if (!logger || typeof logger.warn !== 'function') return;
    logger.warn(`[mill-metrics] ${message}`);
  }

  const writer = createJsonStateWriter({
    filePath: recordsPath,
    fsPromises,
    warn: (error: unknown) => warn(`write failed: ${error instanceof Error ? error.message : String(error)}`),
  });

  async function pruneEventFiles(timestamp = nowFn()): Promise<void> {
    const todayKey = utcDay(timestamp);
    if (!todayKey || todayKey === lastEventPruneDay) return;
    lastEventPruneDay = todayKey;
    const cutoffDay = cutoffDayKey(todayKey, retainDays);
    if (!cutoffDay) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsPromises.readdir(eventsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      warn(`event retention failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = EVENT_FILE_PATTERN.exec(entry.name);
      if (!match || match[1] >= cutoffDay) continue;
      try {
        await fsPromises.rm(path.join(eventsDir, entry.name), { force: true });
      } catch (error) {
        warn(`could not remove ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  function load(): Promise<void> {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      await pruneEventFiles();
      let text: string;
      try {
        text = await fsPromises.readFile(recordsPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          recordsLoaded = true;
          return;
        }
        warn(`records unreadable, will retry: ${error instanceof Error ? error.message : String(error)}`);
        loadPromise = null;
        return;
      }
      try {
        const parsed = MillMetricStore.safeParse(JSON.parse(text));
        if (!parsed.success) {
          warn(`records unreadable, starting empty: ${parsed.error.issues[0]?.message || 'invalid shape'}`);
          sessionRecords = [];
          recordsLoaded = true;
          return;
        }
        sessionRecords = pruneRecords(parsed.data.sessions, {
          retainDays,
          todayKey: utcDay(nowFn()) || undefined,
        });
        recordsLoaded = true;
      } catch (error) {
        warn(`records unreadable, starting empty: ${error instanceof Error ? error.message : String(error)}`);
        sessionRecords = [];
        recordsLoaded = true;
      }
    })();
    return loadPromise;
  }

  function scheduleEventPrune(): void {
    const todayKey = utcDay(nowFn());
    if (!todayKey || todayKey === lastEventPruneDay) return;
    opsChain = opsChain.then(() => pruneEventFiles()).catch((error: unknown) => {
      warn(`event retention failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  function appendEvent(event: unknown): void {
    const parsed = MillMetricEvent.safeParse(event);
    if (!parsed.success) {
      const kind = typeof (event as { kind?: unknown })?.kind === 'string'
        ? String((event as { kind: string }).kind)
        : 'unknown';
      if (warnedEventKinds.has(kind)) return;
      warnedEventKinds.add(kind);
      warn(`dropped invalid ${kind} event: ${parsed.error.issues[0]?.message || 'invalid shape'}`);
      return;
    }
    const eventDay = utcDay(parsed.data.ts);
    if (!eventDay) return;
    scheduleEventPrune();
    const eventPath = path.join(eventsDir, `events-${eventDay}.jsonl`);
    eventPaths.add(eventPath);
    void appendJsonLine(eventPath, parsed.data, { mkdir: true, fsPromises }).catch((error: unknown) => {
      warn(`event append failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  function keepPersistableRecords(): void {
    const kept: MillMetricSession[] = [];
    for (const record of sessionRecords) {
      const parsed = MillMetricSessionRecord.safeParse(record);
      if (parsed.success) {
        kept.push(parsed.data);
        continue;
      }
      warn(`dropped unpersistable record: ${parsed.error.issues[0]?.message || 'invalid shape'}`);
    }
    if (kept.length !== sessionRecords.length) sessionRecords = kept;
  }

  function persist(): Promise<void> {
    if (!recordsLoaded) {
      warn('records were never loaded, refusing to write');
      return Promise.resolve();
    }
    keepPersistableRecords();
    const payload = {
      version: 1 as const,
      updatedAt: new Date(nowFn()).toISOString(),
      sessions: sessionRecords,
    };
    return writer.write(sessionRecords, () => `${JSON.stringify(payload, null, 2)}\n`);
  }

  function scheduleMerge(incoming: MillMetricSession[]): void {
    if (incoming.length === 0) return;
    opsChain = opsChain.then(async () => {
      await load();
      const todayKey = utcDay(nowFn()) || undefined;
      if (!recordsLoaded) {
        queuedRecords = pruneRecords(mergeRecords(queuedRecords, incoming), { retainDays, todayKey });
        warn(`records still unreadable, holding ${queuedRecords.length} close(s) until a load succeeds`);
        return;
      }
      const fresh = queuedRecords.length > 0 ? [...queuedRecords, ...incoming] : incoming;
      queuedRecords = [];
      sessionRecords = pruneRecords(mergeRecords(sessionRecords, fresh), { retainDays, todayKey });
      await persist();
    }).catch((error: unknown) => {
      warn(`close failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  function closeSession(record: unknown): void {
    const parsed = MillMetricSessionRecord.safeParse(record);
    if (!parsed.success) {
      warn(`dropped invalid session record: ${parsed.error.issues[0]?.message || 'invalid shape'}`);
      return;
    }
    scheduleMerge([parsed.data]);
  }

  function takeQueuedRecords(): MillMetricSession[] {
    const stranded = queuedRecords;
    queuedRecords = [];
    return stranded;
  }

  function adoptQueuedRecords(adopted: MillMetricSession[]): void {
    scheduleMerge(adopted);
  }

  function records(): MillMetricSession[] {
    return sessionRecords.map((record) => ({
      ...record,
      prompts: { ...record.prompts },
      packs: record.packs.map((pack: MillMetricPack) => ({
        ...pack,
        files: [...pack.files],
      })),
    }));
  }

  async function flushQueuedRecords(): Promise<void> {
    if (recordsLoaded || queuedRecords.length === 0) return;
    await load();
    if (!recordsLoaded) {
      warn(`records still unreadable, ${queuedRecords.length} close(s) left unpersisted`);
      return;
    }
    const todayKey = utcDay(nowFn()) || undefined;
    sessionRecords = pruneRecords(mergeRecords(sessionRecords, queuedRecords), { retainDays, todayKey });
    queuedRecords = [];
    await persist();
  }

  async function whenIdle(): Promise<void> {
    opsChain = opsChain.then(flushQueuedRecords).catch((error: unknown) => {
      warn(`queued close flush failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    await opsChain;
    await writer.idle();
    const currentDay = utcDay(nowFn());
    const paths = new Set(eventPaths);
    if (currentDay) paths.add(path.join(eventsDir, `events-${currentDay}.jsonl`));
    await Promise.all(Array.from(paths, (eventPath) => appendJsonLineIdle(eventPath)));
  }

  return { adoptQueuedRecords, appendEvent, closeSession, load, records, takeQueuedRecords, whenIdle };
}

export type MillMetricsStoreInstance = ReturnType<typeof createMillMetricsStore>;

export { createMillMetricsStore };
