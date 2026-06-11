'use strict';

// Coverage for the per-client backfill substrate added to Session: the monotonic output
// total (_outputBufferTotal / getOutputOffset), the getBufferSince(offset) range accessor
// (all four branches + the boundary/null/surrogate edges), the push-before-emit ORDER
// CONTRACT that the ws-sender backfill relies on, and the start()-time 'rebaseline' signal
// that tells the backend to re-baseline live data-WS clients on an in-place restart.
//
// Sessions are exercised directly via _handlePtyData (the PTY-data hot path) with an
// injected fake PTY, so no real process launches.

const test = require('node:test');
const assert = require('node:assert/strict');

const { Session } = require('../sessions');

function fakePty() {
  return {
    pid: 2147483646, // non-existent -> destroy()'s taskkill is a harmless no-op
    onData() {},
    onExit() {},
    write() {},
    resize() {},
    kill() {},
  };
}

function newSession(opts = {}) {
  return new Session({
    id: 'buf-test',
    name: 'buf-test',
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: () => fakePty(),
    ...opts,
  });
}

test('getBufferSince: nothing-new branch (offset >= end) returns empty', () => {
  const s = newSession();
  s._handlePtyData('hello');
  assert.deepEqual(s.getBufferSince(5), { data: '', base: 0, end: 5, evicted: false });
  assert.equal(s.getBufferSince(99).data, '', 'offset past end is also empty');
});

test('getBufferSince: exact tail within the retained window (boundary + mid-chunk)', () => {
  const s = newSession();
  s._handlePtyData('aaaa');
  s._handlePtyData('bbbb');
  assert.equal(s.getOutputOffset(), 8);
  assert.equal(s.getBufferSince(0).data, 'aaaabbbb', 'from start');
  assert.equal(s.getBufferSince(4).data, 'bbbb', 'exact chunk-append boundary');
  assert.equal(s.getBufferSince(6).data, 'bb', 'mid-chunk slice');
  assert.equal(s.getBufferSince(8).data, '', 'at end');
});

test('getBufferSince: evicted branch (offset < base) returns full replay + evicted=true', () => {
  const s = newSession({ replayBufferKB: 0 }); // _outputBufferMax = 0 -> evict to 1 entry
  s._handlePtyData('aaaa');
  s._handlePtyData('bbbb'); // evicts 'aaaa'; retained = 'bbbb', base = 4
  const r = s.getBufferSince(0);
  assert.equal(r.evicted, true);
  assert.equal(r.data, 'bbbb', 'full current replay (retained tail)');
  assert.equal(r.base, 4);
  assert.equal(r.end, 8);
});

test('getBufferSince: tolerates a null hole in the retained range (defensive)', () => {
  const s = newSession();
  s._handlePtyData('aaaa');
  s._handlePtyData('bbbb');
  // Inject a defensive null between retained chunks (mirrors a transient eviction state).
  s._outputBuffer.splice(1, 0, null); // ['aaaa', null, 'bbbb'], size/total unchanged
  assert.equal(s.getBufferSince(0).data, 'aaaabbbb', 'null entry skipped; slice correct');
  assert.equal(s.getBufferSince(4).data, 'bbbb');
});

test('getBufferSince: offset on a chunk boundary never splits a surrogate pair', () => {
  const s = newSession();
  const hi = '\uD83D'; // high surrogate of an emoji
  const lo = '\uDE00'; // low surrogate
  s._handlePtyData(`x${hi}`); // chunk1 ends mid-emoji (append boundary at offset 2)
  s._handlePtyData(`${lo}y`); // chunk2 starts with the low surrogate
  const tail = s.getBufferSince(2).data;
  assert.equal(tail, `${lo}y`, 'slice starts cleanly at the chunk-append boundary');
  const full = `x${hi}${tail}`; // prefix already sent + backfilled tail
  assert.equal(full, 'x\u{1F600}y');
  assert.equal([...full].length, 3, 'x, emoji, y — one code point, not mojibake');
});

test('_outputBufferTotal increments on push and is exposed via getHealthStats', () => {
  const s = newSession();
  s._handlePtyData('abc');
  s._handlePtyData('de');
  assert.equal(s.getOutputOffset(), 5);
  assert.equal(s.getHealthStats().outputBufferTotal, 5);
});

test('ORDER CONTRACT: getOutputOffset already includes the just-emitted chunk inside a data listener', () => {
  const s = newSession();
  let offsetAtEmit = null;
  s.on('data', () => { offsetAtEmit = s.getOutputOffset(); });
  s._handlePtyData('hello'); // 5 bytes
  assert.equal(offsetAtEmit, 5, 'ring push + total increment happened BEFORE emit("data")');
});

test("start() resets the output total to 0 and emits 'rebaseline'", async () => {
  const s = newSession();
  s._handlePtyData('some prior output');
  assert.ok(s.getOutputOffset() > 0, 'precondition: total advanced');

  let rebaselined = 0;
  s.on('rebaseline', () => { rebaselined++; });
  try {
    await s.start(); // start() is async; awaiting re-bases (spawns the fake PTY)
    assert.equal(rebaselined, 1, "start() emitted 'rebaseline' exactly once");
    assert.equal(s.getOutputOffset(), 0, 'monotonic total reset to 0 on (re)start');
  } finally {
    s.destroy(); // release timers/PTY
  }
});
