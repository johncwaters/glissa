import type { UsageEntryLike, UsageTotals } from './usage-entry-core.ts';
import { addEntryToTotals, dedupKeys, emptyTotals, totalTokensOf } from './usage-entry-core.ts';
import { safeNumber } from './usage-number-core.ts';

interface VendorTotals {
  tokens: number;
  costUSD: number;
}

interface ModelBucket extends UsageTotals {
  key: string;
  model: string;
  vendor: string;
  entries: number;
}

interface DailyBucket extends UsageTotals {
  day: string;
  entries: number;
  modelByName: Map<string, ModelBucket>;
  vendorSet: Set<string>;
}

interface SessionBucket extends UsageTotals {
  id: string;
  name: string;
  project: string | null;
  vendor: string;
  entries: number;
  lastTs: number | null;
}

interface KnownSession {
  name?: string;
}

interface SerializedDailyBucket extends UsageTotals {
  day: string;
  entries: number;
  models: ModelBucket[];
  vendors: string[];
  source?: string;
}

function buildUsageReport(
  entries: UsageEntryLike[] | null | undefined,
  {
    now = Date.now(),
    blockHours = 5,
    retainDays = 90,
    sessionsById = new Map<string, KnownSession>(),
    tz = null,
  }: {
    now?: number;
    blockHours?: number;
    retainDays?: number;
    sessionsById?: Map<string, KnownSession>;
    tz?: string | null;
  } = {},
) {
  const keptEntries = pruneEntries(entries, { now, retainDays }).kept;
  const totals = emptyTotals();
  const dailyByDay = new Map<string, DailyBucket>();
  const modelByName = new Map<string, ModelBucket>();
  const sessionById = new Map<string, SessionBucket>();

  const byVendor = new Map<string, VendorTotals>();

  for (const entry of keptEntries) {
    addEntryToTotals(totals, entry);
    addEntryToVendorTotals(byVendor, entry);
    const day = localDay(entry.timestampMs);
    addEntryToDailyBucket(dailyByDay, day, entry);
    addEntryToModelBucket(modelByName, entry.model || '<unknown>', entry);
    addEntryToSessionBucket(sessionById, entry, sessionsById);
  }

  return {
    ts: now,
    tz,
    blockHours,
    totals: { ...totals, byVendor: serializeVendorTotals(byVendor) },
    daily: Array.from(dailyByDay.values()).map(serializeDailyBucket).sort((a, b) => a.day.localeCompare(b.day)),
    models: Array.from(modelByName.values()).sort((a, b) => b.tokens - a.tokens),
    sessions: Array.from(sessionById.values()).sort((a, b) => b.tokens - a.tokens),
  };
}

function vendorOf(entry: { vendor?: unknown } | null | undefined): string {
  const vendor = typeof entry?.vendor === 'string' ? entry.vendor.trim() : '';
  return vendor || 'claude';
}

function addEntryToVendorTotals(map: Map<string, VendorTotals>, entry: UsageEntryLike): void {
  const vendor = vendorOf(entry);
  const bucket = map.get(vendor) || { tokens: 0, costUSD: 0 };
  bucket.tokens += totalTokensOf(entry);
  bucket.costUSD += safeNumber(entry.costUSD);
  map.set(vendor, bucket);
}

function serializeVendorTotals(map: Map<string, VendorTotals>): Record<string, VendorTotals> {
  const wire: Record<string, VendorTotals> = {};
  for (const vendor of Array.from(map.keys()).sort()) {
    const totals = map.get(vendor);
    if (totals) wire[vendor] = { ...totals };
  }
  return wire;
}

function pruneEntries(
  entries: UsageEntryLike[] | null | undefined,
  { now = Date.now(), retainDays = 90 }: { now?: number; retainDays?: number } = {},
): { kept: UsageEntryLike[]; removedKeys: string[] } {
  const cutoff = now - retainDays * 24 * 60 * 60 * 1000;
  const kept: UsageEntryLike[] = [];
  const removedKeys: string[] = [];
  for (const entry of entries || []) {
    if (entry.timestampMs >= cutoff) {
      kept.push(entry);
      continue;
    }
    const keys = dedupKeys(entry);
    if (keys.primary) removedKeys.push(keys.primary);
  }
  return { kept, removedKeys };
}

function addEntryToDailyBucket(map: Map<string, DailyBucket>, day: string, entry: UsageEntryLike): void {
  const bucket: DailyBucket = map.get(day) || {
    day,
    ...emptyTotals(),
    entries: 0,
    modelByName: new Map<string, ModelBucket>(),
    vendorSet: new Set<string>(),
  };
  addEntryToTotals(bucket, entry);
  bucket.entries += 1;
  bucket.vendorSet.add(vendorOf(entry));
  addEntryToModelBucket(bucket.modelByName, entry.model || '<unknown>', entry);
  map.set(day, bucket);
}

function addEntryToModelBucket(map: Map<string, ModelBucket>, model: string, entry: UsageEntryLike): void {
  const bucket: ModelBucket = map.get(model) || { key: model, model, vendor: vendorOf(entry), ...emptyTotals(), entries: 0 };
  addEntryToTotals(bucket, entry);
  bucket.entries += 1;
  map.set(model, bucket);
}

function addEntryToSessionBucket(
  map: Map<string, SessionBucket>,
  entry: UsageEntryLike,
  sessionsById: Map<string, KnownSession>,
): void {
  const key = entry.sessionId || '<unknown>';
  const knownSession = typeof sessionsById.get === 'function' ? sessionsById.get(key) : null;
  const entryProject = entry.cwd || entry.project || null;
  const bucket: SessionBucket = map.get(key) || {
    id: key,
    name: knownSession?.name || key,
    project: null,
    vendor: vendorOf(entry),
    ...emptyTotals(),
    entries: 0,
    lastTs: null,
  };
  if (bucket.project === null && entryProject) bucket.project = entryProject;
  addEntryToTotals(bucket, entry);
  bucket.entries += 1;
  bucket.lastTs = Math.max(bucket.lastTs || 0, entry.timestampMs);
  map.set(key, bucket);
}

function serializeDailyBucket(bucket: DailyBucket): SerializedDailyBucket {
  const { modelByName, vendorSet, ...wireBucket } = bucket;
  return {
    ...wireBucket,
    models: Array.from(modelByName.values()).sort((a, b) => b.tokens - a.tokens),
    vendors: Array.from(vendorSet || []).sort(),
  };
}

function localDay(timestampMs: number): string {
  const date = new Date(timestampMs);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export { buildUsageReport, pruneEntries, localDay as localDayKey, vendorOf };
