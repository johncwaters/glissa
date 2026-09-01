'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createReplayLog } = require('../server/control-replay-core.ts');

test('stamp assigns a monotonic seq to every broadcast, replayable or not', () => {
  const log = createReplayLog();
  const a = log.stamp({ type: 'session-changed' });
  const b = log.stamp({ type: 'notify' });
  const c = log.stamp({ type: 'health-snapshot' });
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  assert.equal(c.seq, 3);
  assert.equal(log.currentSeq(), 3);
});

test('entriesSince returns only replayable types, non-replayable types are stamped but never stored', () => {
  const log = createReplayLog();
  log.stamp({ type: 'session-changed', id: 'a' });
  const notify = log.stamp({ type: 'notify', message: 'hi' });
  log.stamp({ type: 'health-snapshot' });
  const postTurn = log.stamp({ type: 'post-turn-result', id: 'a' });
  log.stamp({ type: 'session-git', id: 'a' });

  const { entries, evicted } = log.entriesSince(0);
  assert.equal(evicted, false);
  assert.deepEqual(entries.map((e) => e.type), ['notify', 'post-turn-result']);
  assert.equal(entries[0], notify);
  assert.equal(entries[1], postTurn);
});

test('entriesSince covers the exact allowlist and nothing else: notify, session-error, post-turn-result', () => {
  const log = createReplayLog();
  log.stamp({ type: 'notify' });
  log.stamp({ type: 'session-error' });
  log.stamp({ type: 'post-turn-result' });
  // A near-miss type is not a prefix match away from replaying: the allowlist is exact.
  log.stamp({ type: 'notify-extra' });
  log.stamp({ type: 'session-agents' });

  const { entries } = log.entriesSince(0);
  assert.deepEqual(
    entries.map((e) => e.type),
    ['notify', 'session-error', 'post-turn-result'],
  );
});

test('entriesSince(since) returns only entries with seq > since, in seq order', () => {
  const log = createReplayLog();
  log.stamp({ type: 'notify', n: 1 });
  log.stamp({ type: 'notify', n: 2 });
  log.stamp({ type: 'notify', n: 3 });

  const { entries } = log.entriesSince(1);
  assert.deepEqual(entries.map((e) => e.n), [2, 3]);
});

test('eviction by maxEntries still replays surviving entries; evicted flags an older loss, not a replay gate', () => {
  const log = createReplayLog({ maxEntries: 2 });
  log.stamp({ type: 'notify', n: 1 }); // evicted once n:3 lands
  log.stamp({ type: 'notify', n: 2 });
  log.stamp({ type: 'notify', n: 3 });

  // since=0 predates the evicted n:1, but n:2 and n:3 are still retained and must still replay.
  const fresh = log.entriesSince(0);
  assert.equal(fresh.evicted, true);
  assert.deepEqual(fresh.entries.map((e) => e.n), [2, 3]);

  // A cursor at or past the last evicted seq (1) has not lost anything.
  const caughtUp = log.entriesSince(1);
  assert.equal(caughtUp.evicted, false);
  assert.deepEqual(caughtUp.entries.map((e) => e.n), [2, 3]);
});

test('eviction by maxAgeMs happens lazily, including on an entriesSince call with no new stamps', () => {
  const log = createReplayLog({ maxAgeMs: 1000 });
  log.stamp({ type: 'notify', n: 1 }, 0);
  log.stamp({ type: 'notify', n: 2 }, 500);

  // Neither stamp call is old enough yet to evict at t=500.
  assert.deepEqual(log.entriesSince(0, 500).entries.map((e) => e.n), [1, 2]);

  // At t=1600, entry n:1 (ts 0) is 1600ms old (> maxAgeMs) and ages out; n:2 (ts 500) is 1100ms
  // old and also ages out. No new stamp triggers this - entriesSince alone evicts lazily.
  const result = log.entriesSince(0, 1600);
  assert.deepEqual(result.entries, []);
  assert.equal(result.evicted, true);
});

test('entriesSince rejects a non-finite or negative since without flagging eviction', () => {
  const log = createReplayLog();
  log.stamp({ type: 'notify' });
  assert.deepEqual(log.entriesSince(NaN), { entries: [], evicted: false });
  assert.deepEqual(log.entriesSince(-1), { entries: [], evicted: false });
  assert.deepEqual(log.entriesSince(Infinity), { entries: [], evicted: false });
});

test('a since exactly at currentSeq replays nothing new and is not evicted', () => {
  const log = createReplayLog();
  log.stamp({ type: 'notify' });
  log.stamp({ type: 'notify' });
  const { entries, evicted } = log.entriesSince(log.currentSeq());
  assert.deepEqual(entries, []);
  assert.equal(evicted, false);
});
