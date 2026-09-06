const DEFAULT_MAX_ENTRIES = 50;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface OutboxEntry {
  id: string;
  text: string;
  queuedAt: number;
  attempts: number;
}

function isEntry(value: unknown): value is { id: string; text: string; queuedAt?: unknown; attempts?: unknown } {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === 'string'
    && entry.id !== ''
    && typeof entry.text === 'string'
    && entry.text !== '';
}

function normalizeOutbox(raw: unknown): OutboxEntry[] {
  if (!raw || typeof raw !== 'object' || !('entries' in raw)) return [];
  const list: unknown[] = Array.isArray(raw.entries) ? raw.entries : [];
  return list.filter(isEntry).map((entry) => ({
    id: entry.id,
    text: entry.text,
    queuedAt: Number.isFinite(entry.queuedAt) ? Number(entry.queuedAt) : 0,
    attempts: Number.isFinite(entry.attempts) && Number(entry.attempts) > 0 ? Number(entry.attempts) : 0,
  }));
}

function planEnqueue(
  entries: OutboxEntry[],
  entry: OutboxEntry,
  { maxEntries = DEFAULT_MAX_ENTRIES }: { maxEntries?: number } = {},
): OutboxEntry[] {
  const next = [...entries, entry];
  if (next.length <= maxEntries) return next;
  return next.slice(next.length - maxEntries);
}

function removeEntry<Entry extends { id: string }>(entries: Entry[], id: string): Entry[] {
  return entries.filter((entry) => entry.id !== id);
}

function recordFailure(
  entries: OutboxEntry[],
  id: string,
  { maxAttempts = DEFAULT_MAX_ATTEMPTS }: { maxAttempts?: number } = {},
): { entries: OutboxEntry[]; dropped: boolean } {
  const next: OutboxEntry[] = [];
  let dropped = false;
  for (const entry of entries) {
    if (entry.id !== id) {
      next.push(entry);
      continue;
    }
    const attempts = entry.attempts + 1;
    if (attempts >= maxAttempts) {
      dropped = true;
      continue;
    }
    next.push({ ...entry, attempts });
  }
  return { entries: next, dropped };
}

function planReplay(
  entries: OutboxEntry[],
  { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS, maxAttempts = DEFAULT_MAX_ATTEMPTS }:
    { now?: number; maxAgeMs?: number; maxAttempts?: number } = {},
): { send: OutboxEntry[]; expired: OutboxEntry[] } {
  const send: OutboxEntry[] = [];
  const expired: OutboxEntry[] = [];
  for (const entry of entries) {
    if (entry.attempts >= maxAttempts || now - entry.queuedAt > maxAgeMs) {
      expired.push(entry);
      continue;
    }
    send.push(entry);
  }
  return { send, expired };
}

export {
  normalizeOutbox, planEnqueue, planReplay, recordFailure, removeEntry,
  DEFAULT_MAX_AGE_MS, DEFAULT_MAX_ATTEMPTS, DEFAULT_MAX_ENTRIES,
};
