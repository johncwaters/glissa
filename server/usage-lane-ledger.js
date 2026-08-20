'use strict';

/*
 * Durable Claude-session-id to Glissa-lane ledger: the IO shell around server/core/usage-lane-core.js.
 *
 * Written from the ONE place every Claude session id becomes known, the `claude-session-id` event a Session
 * emits when a hook payload carries it (live-verified to fire in headless `-p` too, so the ephemeral lanes
 * are attributable and not just the interactive cards). Read by the usage scanner when it builds byLane.
 *
 * Deliberately not part of config.json: this is derived runtime state that can be rebuilt by observation,
 * and it grows per session rather than per project.
 */

const path = require('node:path');
const { laneMapFromLedger, pruneLedger } = require('./core/usage-lane-core');

function createLaneLedger({
  ledgerPath = null,
  fsPromises = require('node:fs/promises'),
  nowFn = Date.now,
  retainDays = 365,
  logger = null,
} = {}) {
  let entries = [];
  let signature = null;
  let writeChain = Promise.resolve();
  let loadPromise = null;

  function warn(message) {
    if (!logger || typeof logger.warn !== 'function') return;
    logger.warn(`[usage-lanes] ${message}`);
  }

  function load() {
    if (!ledgerPath) return Promise.resolve();
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      let text = null;
      try {
        text = await fsPromises.readFile(ledgerPath, 'utf8');
      } catch {
        // No file yet is the ordinary first-run case.
        return;
      }
      try {
        const parsed = JSON.parse(text);
        entries = pruneLedger(Array.isArray(parsed?.entries) ? parsed.entries : [], { now: nowFn(), retainDays });
      } catch (error) {
        // Starting empty costs attribution for old sessions, which then read as `other`. That is a visibly
        // degraded answer rather than a wrong one, and new spawns repopulate it.
        warn(`ledger unreadable, starting empty: ${error.message}`);
        entries = [];
      }
    })();
    return loadPromise;
  }

  /*
   * Record which lane spawned a Claude session. Fire and forget by design: this sits on the hook callback
   * path, which must never wait on a disk write, and a lost record costs one session's attribution rather
   * than any usage number.
   */
  function record(claudeSessionId, lane) {
    if (!ledgerPath || !claudeSessionId || !lane) return;
    void (async () => {
      await load();
      const existing = entries.find((entry) => entry.claudeSessionId === claudeSessionId);
      if (existing && existing.lane === lane) return;
      entries = pruneLedger([...entries, { claudeSessionId, lane, ts: nowFn() }], { now: nowFn(), retainDays });
      await persist();
    })().catch((error) => warn(`record failed: ${error.message}`));
  }

  async function persist() {
    const next = JSON.stringify(entries);
    if (next === signature) return;
    signature = next;
    const payload = `${JSON.stringify({ version: 1, updatedAt: new Date(nowFn()).toISOString(), entries }, null, 2)}\n`;
    writeChain = writeChain.then(() => writeFile(payload)).catch(() => {});
    await writeChain;
  }

  // tmp + rename, so a crash mid-write cannot leave a half-written ledger.
  async function writeFile(payload) {
    const tmpPath = `${ledgerPath}.tmp`;
    try {
      await fsPromises.mkdir(path.dirname(ledgerPath), { recursive: true });
      await fsPromises.writeFile(tmpPath, payload);
      await fsPromises.rename(tmpPath, ledgerPath);
    } catch (error) {
      warn(`write failed: ${error.message}`);
      signature = null;
    }
  }

  // Synchronous by design: the scanner calls it while assembling a report, and an empty map before the first
  // load simply means everything reads as `other` for that one report.
  function laneMap() {
    return laneMapFromLedger(entries);
  }

  function snapshot() {
    return entries.map((entry) => ({ ...entry }));
  }

  return { load, record, laneMap, snapshot };
}

module.exports = { createLaneLedger };
