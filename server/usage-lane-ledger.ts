import nodeFsPromises from 'node:fs/promises';

import { laneMapFromLedger, pruneLedger } from './core/usage-lane-core.ts';
import type { LaneLedgerEntry } from './core/usage-lane-core.ts';
import type { RecordLane } from './ephemeral-session.ts';
import { createJsonStateWriter } from './json-file.ts';

type LedgerFileSystem = Pick<typeof nodeFsPromises, 'readFile' | 'mkdir' | 'writeFile' | 'rename' | 'rm' | 'appendFile'>;

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
  let entries: LaneLedgerEntry[] = [];
  let opsChain: Promise<void> = Promise.resolve();
  let loadPromise: Promise<void> | null = null;

  function warn(message: string): void {
    if (!logger || typeof logger.warn !== 'function') return;
    logger.warn(`[usage-lanes] ${message}`);
  }

  function failureText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  const writer = ledgerPath
    ? createJsonStateWriter({
      filePath: ledgerPath,
      fsPromises,
      warn: (error: unknown) => warn(`write failed: ${failureText(error)}`),
    })
    : null;

  function load(): Promise<void> {
    if (!ledgerPath) return Promise.resolve();
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      let text: string | null = null;
      try {
        text = await fsPromises.readFile(ledgerPath, 'utf8');
      } catch {
        return;
      }
      try {
        const parsed: unknown = JSON.parse(text);
        const rawEntries = parsed && typeof parsed === 'object' ? (parsed as { entries?: unknown }).entries : null;
        entries = pruneLedger(Array.isArray(rawEntries) ? rawEntries : [], { now: nowFn(), retainDays });
      } catch (error) {
        warn(`ledger unreadable, starting empty: ${failureText(error)}`);
        entries = [];
      }
    })();
    return loadPromise;
  }

  async function persist(): Promise<void> {
    if (!writer) return;
    await writer.write(entries, () => `${JSON.stringify({ version: 1, updatedAt: new Date(nowFn()).toISOString(), entries }, null, 2)}\n`);
  }

  const record: RecordLane = (sessionId, lane, vendor = 'claude') => {
    if (!ledgerPath || !sessionId || !lane) return;

    opsChain = opsChain.then(async () => {
      await load();
      const existing = entries.find((entry) => entry.sessionId === sessionId && entry.vendor === vendor);
      if (existing && existing.lane === lane) return;
      entries = pruneLedger([...entries, { vendor, sessionId, lane, ts: nowFn() }], { now: nowFn(), retainDays });
      await persist();
    }).catch((error: unknown) => warn(`record failed: ${failureText(error)}`));
  };

  function whenIdle(): Promise<void> {
    return opsChain.then(() => (writer ? writer.idle() : undefined));
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
