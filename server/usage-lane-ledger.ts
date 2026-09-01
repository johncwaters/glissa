/*
 * Durable session-id to Glissa-lane ledger: the IO shell around server/core/usage-lane-core.ts.
 *
 * Written from the ONE place a session id becomes known, the `claude-session-id` event a Session emits when
 * a hook payload carries it (event name kept for wire/back-compat; the payload now carries { vendor,
 * sessionId }). Live-verified to fire in headless `-p` too, so the ephemeral lanes are attributable and not
 * just the interactive cards. Read by the usage scanner when it builds byLane. Entries are keyed by the
 * vendor-namespaced composite so a codex session id cannot collide with a claude one; a pre-M5 file keyed
 * `claudeSessionId` round-trips as vendor `claude` (usage-lane-core normalizeLedgerEntry).
 *
 * Deliberately not part of config.json: this is derived runtime state that can be rebuilt by observation,
 * and it grows per session rather than per project.
 */

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

  // tmp + rename, so a crash mid-write cannot leave a half-written ledger.
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
        // No file yet is the ordinary first-run case.
        return;
      }
      try {
        const parsed: unknown = JSON.parse(text);
        const rawEntries = parsed && typeof parsed === 'object' ? (parsed as { entries?: unknown }).entries : null;
        entries = pruneLedger(Array.isArray(rawEntries) ? rawEntries : [], { now: nowFn(), retainDays });
      } catch (error) {
        // Starting empty costs attribution for old sessions, which then read as `other`. That is a visibly
        // degraded answer rather than a wrong one, and new spawns repopulate it.
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

  /*
   * Record which lane spawned a session. Fire and forget by design: this sits on the hook callback path,
   * which must never wait on a disk write, and a lost record costs one session's attribution rather than
   * any usage number. `vendor` defaults to claude, so a pre-M5 caller (the ephemeral lanes, all Claude)
   * records exactly as before.
   */
  const record: RecordLane = (sessionId, lane, vendor = 'claude') => {
    if (!ledgerPath || !sessionId || !lane) return;
    // Serialized so records apply in arrival order and whenIdle() has one chain to settle on.
    opsChain = opsChain.then(async () => {
      await load();
      const existing = entries.find((entry) => entry.sessionId === sessionId && entry.vendor === vendor);
      if (existing && existing.lane === lane) return;
      entries = pruneLedger([...entries, { vendor, sessionId, lane, ts: nowFn() }], { now: nowFn(), retainDays });
      await persist();
    }).catch((error: unknown) => warn(`record failed: ${failureText(error)}`));
  };

  // Test seam: settles once every record accepted so far is applied and its write has landed.
  function whenIdle(): Promise<void> {
    return opsChain.then(() => (writer ? writer.idle() : undefined));
  }

  // Synchronous by design: the scanner calls it while assembling a report; an empty map before the
  // first load hides the lanes section for that one report (buildLaneRows returns null on an empty map).
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
