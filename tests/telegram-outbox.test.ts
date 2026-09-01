// The durable Telegram outbox (2026-08 review, section 5, as narrowed by the operator's ruling: a
// lost browser notification on restart is acceptable, a lost phone ping is not). The contract is
// at-least-once - a crash between "Telegram accepted it" and "the file no longer lists it" replays
// one ping, and a duplicate phone ping is a shrug next to a missing one.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTelegramOutbox } from '../notifications/telegram-outbox.ts';
import {
  normalizeOutbox, planEnqueue, planReplay, recordFailure, removeEntry,
} from '../notifications/core/outbox-core.ts';
import type { OutboxEntry } from '../notifications/core/outbox-core.ts';

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-outbox-'));
  return { dir, filePath: path.join(dir, 'telegram-outbox.json') };
}

function readOutbox(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// --- pure rules ---

test('normalizeOutbox salvages what it can and discards the rest', () => {
  const entries = normalizeOutbox({
    entries: [
      { id: 'a', text: 'one', queuedAt: 5, attempts: 2 },
      { id: 'b', text: 'two' },
      { id: '', text: 'no id' },
      { id: 'c' },
      null,
      'nonsense',
    ],
  });
  assert.deepEqual(entries, [
    { id: 'a', text: 'one', queuedAt: 5, attempts: 2 },
    { id: 'b', text: 'two', queuedAt: 0, attempts: 0 },
  ]);
  assert.deepEqual(normalizeOutbox(null), []);
  assert.deepEqual(normalizeOutbox({ entries: 'nope' }), []);
});

test('the queue is capped oldest-first: an old ping is the one whose loss matters least', () => {
  let entries: OutboxEntry[] = [];
  for (let i = 0; i < 5; i += 1) {
    entries = planEnqueue(entries, { id: `e${i}`, text: `t${i}`, queuedAt: i, attempts: 0 }, { maxEntries: 3 });
  }
  assert.deepEqual(entries.map((e) => e.id), ['e2', 'e3', 'e4']);
});

test('a failure counts up and the entry is dropped once it has plainly stopped working', () => {
  const entries = [{ id: 'a', text: 'x', queuedAt: 0, attempts: 1 }];
  const once = recordFailure(entries, 'a', { maxAttempts: 3 });
  assert.equal(once.entries[0].attempts, 2);
  assert.equal(once.dropped, false);
  const again = recordFailure(once.entries, 'a', { maxAttempts: 3 });
  assert.deepEqual(again.entries, []);
  assert.equal(again.dropped, true);
});

test('a replay sends the fresh and expires the stale', () => {
  const now = 1_000_000;
  const plan = planReplay([
    { id: 'fresh', text: 'a', queuedAt: now - 1000, attempts: 0 },
    { id: 'old', text: 'b', queuedAt: now - 999_999_999, attempts: 0 },
    { id: 'exhausted', text: 'c', queuedAt: now, attempts: 9 },
  ], { now, maxAgeMs: 60_000, maxAttempts: 5 });
  assert.deepEqual(plan.send.map((e) => e.id), ['fresh']);
  assert.deepEqual(plan.expired.map((e) => e.id), ['old', 'exhausted']);
});

test('removeEntry leaves everything else alone', () => {
  const entries = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(removeEntry(entries, 'a'), [{ id: 'b' }]);
  assert.deepEqual(removeEntry(entries, 'missing'), entries);
});

// --- the shell ---

test('a confirmed send leaves nothing behind', async (t) => {
  const { dir, filePath } = tempFile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sent: string[] = [];
  const outbox = createTelegramOutbox({
    filePath,
    send: async (entry) => { sent.push(entry.text); return { ok: true }; },
  });

  await outbox.deliver('complete: build finished');
  await outbox.idle();

  assert.deepEqual(sent, ['complete: build finished']);
  assert.deepEqual(readOutbox(filePath).entries, [], 'the record exists only until the send is confirmed');
});

test('a failed send stays queued for the next boot', async (t) => {
  const { dir, filePath } = tempFile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outbox = createTelegramOutbox({ filePath, send: async () => ({ ok: false }) });

  await outbox.deliver('waiting: needs your input');
  await outbox.idle();

  const stored = readOutbox(filePath).entries;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].text, 'waiting: needs your input');
  assert.equal(stored[0].attempts, 1);
});

// The crash this exists for: the ping was recorded, the process died, and nothing else would ever
// have mentioned it again.
test('a ping queued by a dead process is replayed by the next one', async (t) => {
  const { dir, filePath } = tempFile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const crashed = createTelegramOutbox({ filePath, send: async () => { throw new Error('process died'); } });
  await crashed.deliver('complete: the one that mattered');
  await crashed.idle();
  assert.equal(readOutbox(filePath).entries.length, 1);

  const sent: string[] = [];
  const rebooted = createTelegramOutbox({
    filePath,
    send: async (entry) => { sent.push(entry.text); return { ok: true }; },
  });
  const result = await rebooted.replay();
  await rebooted.idle();

  assert.deepEqual(sent, ['complete: the one that mattered']);
  assert.deepEqual(result, { sent: 1, expired: 0 });
  assert.deepEqual(readOutbox(filePath).entries, []);
});

test('a replay drops what has gone stale rather than announcing yesterday on boot', async (t) => {
  const { dir, filePath } = tempFile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(filePath, JSON.stringify({
    version: 1,
    entries: [{ id: 'ancient', text: 'complete: last week', queuedAt: 0, attempts: 0 }],
  }), 'utf8');

  const sent: string[] = [];
  const outbox = createTelegramOutbox({
    filePath,
    send: async (entry) => { sent.push(entry.text); return { ok: true }; },
    now: () => 999_999_999_999,
  });
  const result = await outbox.replay();
  await outbox.idle();

  assert.deepEqual(sent, []);
  assert.deepEqual(result, { sent: 0, expired: 1 });
  assert.deepEqual(readOutbox(filePath).entries, []);
});

test('a corrupt outbox starts empty and warns, which can only ever lose a ping, never invent one', async (t) => {
  const { dir, filePath } = tempFile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(filePath, '{ not json', 'utf8');
  const warnings: string[] = [];
  const outbox = createTelegramOutbox({
    filePath, send: async () => ({ ok: true }), warn: (line) => warnings.push(line),
  });

  const result = await outbox.replay();
  assert.deepEqual(result, { sent: 0, expired: 0 });
  assert.equal(warnings.length, 1);
});

test('a missing outbox file is the normal fresh-install case and says nothing', async (t) => {
  const { dir, filePath } = tempFile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const warnings: string[] = [];
  const outbox = createTelegramOutbox({
    filePath, send: async () => ({ ok: true }), warn: (line) => warnings.push(line),
  });
  await outbox.replay();
  assert.deepEqual(warnings, []);
});

// An unwritable outbox costs durability, never the ping itself.
test('a write failure is warned about and the send still happens', async (t) => {
  const { dir, filePath } = tempFile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sent: string[] = [];
  const warnings: string[] = [];
  const outbox = createTelegramOutbox({
    filePath,
    send: async (entry) => { sent.push(entry.text); return { ok: true }; },
    writeJson: async () => { throw new Error('read-only filesystem'); },
    warn: (line) => warnings.push(line),
  });

  await outbox.deliver('complete: still delivered');
  await outbox.idle();

  assert.deepEqual(sent, ['complete: still delivered']);
  assert.equal(warnings.some((line) => line.includes('read-only filesystem')), true);
});
