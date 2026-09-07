import nodeFsPromises from 'node:fs/promises';

import { laneMapFromLedger, pruneLedger } from './core/usage-lane-core.ts';
import type { LaneLedgerEntry } from './core/usage-lane-core.ts';
import type { RecordLane } from './ephemeral-session.ts';
import { createJsonStateStore } from './json-file.ts';
import { createLaneLog } from './lane-log.ts';

type LedgerFileSystem = Pick<typeof nodeFsPromises, 'readFile' | 'mkdir' | 'writeFile' | 'rename' | 'rm' | 'appendFile'>;
type StoredLedgerEntries = NonNullable<Parameters<typeof pruneLedger>[0]>;

interface LaneLedgerOptions {
  ledgerPath?: string | null;
  fsPromises?: LedgerFileSystem;
  nowFn?: () => number;
  retainDays?: number;
  logger?: Pick<Console, 'warn'> | null;
}

interface LaneLedger {
  load(): Promise<void>;
  record: RecordLane;
  laneMap(): Map<string, string>;
  snapshot(): LaneLedgerEntry[];
  whenIdle(): Promise<void>;
}

function createLaneLedger({
  ledgerPath = null,
  fsPromises = nodeFsPromises,
  nowFn = Date.now,
  retainDays = 365,
  logger = null,
}: LaneLedgerOptions = {}): LaneLedger {
  const laneLog = createLaneLog({ prefix: '[usage]', logger });
  let entries: LaneLedgerEntry[] = [];
  let opsChain: Promise<void> = Promise.resolve();

  function failureText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  const store = createJsonStateStore<StoredLedgerEntries>({
    name: 'ledger',
    filePath: ledgerPath,
    fsPromises,
    nowMs: nowFn,
    warn: laneLog.warn,
    parse: (raw) => {
      const rawEntries = raw && typeof raw === 'object' ? (raw as { entries?: unknown }).entries : null;
      return Array.isArray(rawEntries) ? rawEntries : [];
    },
    adopt: (loadedEntries) => {
      entries = loadedEntries ? pruneLedger(loadedEntries, { now: nowFn(), retainDays }) : [];
    },
  });

  function load(): Promise<void> {
    return store.load();
  }

  async function persist(): Promise<void> {
    await store.write(entries, () => `${JSON.stringify({ version: 1, updatedAt: new Date(nowFn()).toISOString(), entries }, null, 2)}\n`);
  }

  const record: RecordLane = (sessionId, lane, vendor = 'claude') => {
    if (!ledgerPath || !sessionId || !lane) return;

    opsChain = opsChain.then(async () => {
      await load();
      const existing = entries.find((entry) => entry.sessionId === sessionId && entry.vendor === vendor);
      if (existing && existing.lane === lane) return;
      entries = pruneLedger([...entries, { vendor, sessionId, lane, ts: nowFn() }], { now: nowFn(), retainDays });
      await persist();
    }).catch((error: unknown) => laneLog.warn('ledger record failed', { error: failureText(error) }));
  };

  function whenIdle(): Promise<void> {
    return opsChain.then(() => store.idle());
  }

  function laneMap(): Map<string, string> {
    return laneMapFromLedger(entries);
  }

  function snapshot(): LaneLedgerEntry[] {
    return entries.map((entry) => ({ ...entry }));
  }

  return { load, record, laneMap, snapshot, whenIdle };
}

export { createLaneLedger };
export type { LaneLedger, LaneLedgerOptions };
