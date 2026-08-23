'use strict';

/*
 * The IO shell around notifications/core/outbox-core.js: one JSON file beside the resolved config
 * (tmp+rename, like every other durable sidecar), a serialized write chain, and a boot replay.
 *
 * The contract is at-least-once, deliberately not exactly-once: a crash between "Telegram accepted it"
 * and "the file no longer lists it" replays one ping. A duplicate phone ping is a shrug; a missing one
 * is the failure this exists to prevent.
 *
 * Every path here is best-effort about the FILE and strict about the SEND. An unwritable outbox costs
 * durability, never the ping itself: the send is attempted regardless and only the record is lost.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');

const { writeJsonAtomic } = require('../server/json-file');
const {
  normalizeOutbox, planEnqueue, planReplay, recordFailure, removeEntry,
  DEFAULT_MAX_AGE_MS, DEFAULT_MAX_ATTEMPTS, DEFAULT_MAX_ENTRIES,
} = require('./core/outbox-core');

const OUTBOX_VERSION = 1;

/**
 * @param {object} deps
 * @param {string} deps.filePath telegram-outbox.json beside the resolved config
 * @param {(entry: object) => Promise<{ok: boolean}>} deps.send performs one delivery
 */
function createTelegramOutbox({
  filePath,
  send,
  now = Date.now,
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  warn = console.warn,
  readFileSync = fs.readFileSync,
  writeJson = writeJsonAtomic,
} = {}) {
  let entries = [];
  let writeChain = Promise.resolve();
  let loaded = false;

  function load() {
    if (loaded) return;
    loaded = true;
    try {
      entries = normalizeOutbox(JSON.parse(readFileSync(filePath, 'utf8')));
    } catch (error) {
      // A missing file is the normal case on a fresh install and says nothing worth logging; a
      // corrupt one starts empty, which can only ever lose a queued ping, never invent one.
      if (error && error.code !== 'ENOENT') warn(`[telegram-outbox] unreadable, starting empty: ${error.message}`);
      entries = [];
    }
  }

  function persist() {
    const snapshot = { version: OUTBOX_VERSION, entries: entries.slice() };
    writeChain = writeChain
      .then(() => writeJson(filePath, snapshot, { mkdir: true }))
      .catch((error) => warn(`[telegram-outbox] write failed: ${error.message}`));
    return writeChain;
  }

  /** Record the ping, then attempt it. Recording FIRST is what makes a crash mid-send recoverable. */
  async function deliver(text) {
    load();
    const entry = { id: crypto.randomUUID(), text, queuedAt: now(), attempts: 0 };
    entries = planEnqueue(entries, entry, { maxEntries });
    await persist();
    await attempt(entry);
  }

  async function attempt(entry) {
    let ok = false;
    try {
      const result = await send(entry);
      ok = result?.ok === true;
    } catch (error) {
      warn(`[telegram-outbox] send threw: ${error.message}`);
    }
    if (ok) {
      entries = removeEntry(entries, entry.id);
      await persist();
      return;
    }
    const outcome = recordFailure(entries, entry.id, { maxAttempts });
    entries = outcome.entries;
    if (outcome.dropped) warn(`[telegram-outbox] giving up on a ping after ${maxAttempts} attempts`);
    await persist();
  }

  /**
   * Boot replay. Anything too old or too often failed is dropped rather than sent: a queue that
   * replays yesterday's completions on boot teaches the operator to ignore the channel.
   */
  async function replay() {
    load();
    const plan = planReplay(entries, { now: now(), maxAgeMs, maxAttempts });
    if (plan.expired.length > 0) {
      for (const entry of plan.expired) entries = removeEntry(entries, entry.id);
      await persist();
    }
    for (const entry of plan.send) {
      await attempt(entry);
    }
    return { sent: plan.send.length, expired: plan.expired.length };
  }

  return {
    deliver,
    replay,
    idle: () => writeChain,
    pending: () => { load(); return entries.slice(); },
  };
}

module.exports = { createTelegramOutbox, OUTBOX_VERSION };
