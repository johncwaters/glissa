'use strict';

// Unit tests for the pure Headroom supervisor core (session-core/headroom-core.js): the
// lifecycle transition table, the detection candidate ordering, and the proxy arg builder.
// These are the rules the stateful service in headroom-service.js relies on; asserting them
// here means the service tests can focus on I/O orchestration only.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  nextState,
  candidateCommands,
  buildProxyArgs,
  summarizeStats,
  DEFAULT_HEADROOM_PORT,
} = require('../session-core/headroom-core');

test('happy path: detect-ok -> spawn -> ready -> stop -> stopped', () => {
  let s = 'not-installed';
  s = nextState(s, 'detect-ok');
  assert.equal(s, 'stopped');
  s = nextState(s, 'spawn');
  assert.equal(s, 'starting');
  s = nextState(s, 'ready');
  assert.equal(s, 'running');
  s = nextState(s, 'stop');
  assert.equal(s, 'stopping');
  s = nextState(s, 'stopped');
  assert.equal(s, 'stopped');
});

test('stop from running-external is forbidden (returns null)', () => {
  assert.equal(nextState('running-external', 'stop'), null);
});

test('spawn from running-external is forbidden (never shadow an external proxy)', () => {
  assert.equal(nextState('running-external', 'spawn'), null);
});

test('detect-missing yields not-installed, never failed', () => {
  assert.equal(nextState('not-installed', 'detect-missing'), 'not-installed');
  assert.equal(nextState('stopped', 'detect-missing'), 'not-installed');
  assert.equal(nextState('failed', 'detect-missing'), 'not-installed');
});

test('failed is reserved for a present binary that crashed or never became ready', () => {
  // early death during starting (clean or crash) is failed, not stopped
  assert.equal(nextState('starting', 'exit-clean'), 'failed');
  assert.equal(nextState('starting', 'exit-crash'), 'failed');
  // crash while running is failed; clean exit while running is stopped
  assert.equal(nextState('running', 'exit-crash'), 'failed');
  assert.equal(nextState('running', 'exit-clean'), 'stopped');
});

test('probe-external adopts a sibling proxy from stopped, starting, and failed', () => {
  // pre-spawn probe hit
  assert.equal(nextState('stopped', 'probe-external'), 'running-external');
  // EADDRINUSE race: spawn lost, re-probe answered
  assert.equal(nextState('starting', 'probe-external'), 'running-external');
  assert.equal(nextState('failed', 'probe-external'), 'running-external');
});

test('any exit while stopping resolves to stopped', () => {
  assert.equal(nextState('stopping', 'stopped'), 'stopped');
  assert.equal(nextState('stopping', 'exit-clean'), 'stopped');
  assert.equal(nextState('stopping', 'exit-crash'), 'stopped');
});

test('failed allows manual restart (spawn) and clearing (stop)', () => {
  assert.equal(nextState('failed', 'spawn'), 'starting');
  assert.equal(nextState('failed', 'stop'), 'stopped');
});

test('unknown states and events return null', () => {
  assert.equal(nextState('nonsense', 'spawn'), null);
  assert.equal(nextState('running', 'nonsense'), null);
  assert.equal(nextState('running', 'detect-missing'), null);
});

test('candidateCommands: PATH first, APPDATA Scripts (313 preferred), py launcher last', () => {
  const c = candidateCommands({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' });
  assert.equal(c[0].file, 'headroom');
  assert.deepEqual(c[0].args, []);
  assert.equal(
    c[1].file,
    'C:\\Users\\u\\AppData\\Roaming\\Python\\Python313\\Scripts\\headroom.exe',
  );
  const last = c[c.length - 1];
  assert.equal(last.file, 'py');
  assert.deepEqual(last.args, ['-3.13', '-m', 'headroom']);
  // all APPDATA candidates point at a headroom.exe under a Python3xx Scripts dir
  for (const cand of c.slice(1, -1)) {
    assert.match(cand.file, /\\Python\\Python3\d\d\\Scripts\\headroom\.exe$/);
  }
});

test('candidateCommands without APPDATA skips the Scripts candidates', () => {
  const c = candidateCommands({});
  assert.equal(c.length, 2);
  assert.equal(c[0].file, 'headroom');
  assert.equal(c[1].file, 'py');
});

test('buildProxyArgs coerces a valid integer port to a string argv', () => {
  assert.deepEqual(buildProxyArgs(8787), ['proxy', '--port', '8787']);
  assert.deepEqual(buildProxyArgs(1024), ['proxy', '--port', '1024']);
  assert.deepEqual(buildProxyArgs(65535), ['proxy', '--port', '65535']);
});

test('buildProxyArgs rejects non-integer and out-of-range values (falls back to default)', () => {
  const fallback = ['proxy', '--port', String(DEFAULT_HEADROOM_PORT)];
  assert.deepEqual(buildProxyArgs('8787; rm -rf /'), fallback);
  assert.deepEqual(buildProxyArgs(80), fallback);
  assert.deepEqual(buildProxyArgs(70000), fallback);
  assert.deepEqual(buildProxyArgs(8787.5), fallback);
  assert.deepEqual(buildProxyArgs(null), fallback);
  assert.deepEqual(buildProxyArgs(undefined), fallback);
});

// summarizeStats: the GET /stats payload reduced to the chip's numbers. The fixture mirrors
// the live v0.24.0 shape (only the fields the reducer reads).
const STATS_FIXTURE = {
  summary: {
    api_requests: 37,
    compression: { requests_compressed: 5, total_tokens_removed: 12345 },
    cost: {
      total_saved_usd: 1.23,
      savings_pct: 4.5,
      breakdown: { cache_savings_usd: 18.4 },
    },
  },
};

test('summarizeStats extracts the chip fields from a live-shaped payload', () => {
  assert.deepEqual(summarizeStats(STATS_FIXTURE), {
    requests: 37,
    compressedRequests: 5,
    tokensRemoved: 12345,
    savedUsd: 1.23,
    savingsPct: 4.5,
    cacheSavedUsd: 18.4,
  });
});

test('summarizeStats zero-fills missing or garbage fields (version drift degrades, never throws)', () => {
  assert.deepEqual(summarizeStats({ summary: {} }), {
    requests: 0,
    compressedRequests: 0,
    tokensRemoved: 0,
    savedUsd: 0,
    savingsPct: 0,
    cacheSavedUsd: 0,
  });
  const s = summarizeStats({
    summary: { api_requests: '37', compression: { total_tokens_removed: NaN }, cost: { breakdown: null } },
  });
  assert.equal(s.requests, 0);
  assert.equal(s.tokensRemoved, 0);
  assert.equal(s.cacheSavedUsd, 0);
});

test('summarizeStats zero-fills negative counters (never rendered as "-5 req")', () => {
  const s = summarizeStats({
    summary: { api_requests: -5, compression: { total_tokens_removed: -100 }, cost: { total_saved_usd: -0.5 } },
  });
  assert.equal(s.requests, 0);
  assert.equal(s.tokensRemoved, 0);
  assert.equal(s.savedUsd, 0);
});

test('summarizeStats returns null for a non-object, array, or summary-less payload', () => {
  assert.equal(summarizeStats(null), null);
  assert.equal(summarizeStats(undefined), null);
  assert.equal(summarizeStats('nope'), null);
  assert.equal(summarizeStats({}), null);
  assert.equal(summarizeStats({ summary: 'nope' }), null);
  assert.equal(summarizeStats([]), null);
  assert.equal(summarizeStats({ summary: [] }), null);
});
