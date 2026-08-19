'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  dedupKeys,
  expandAdvisorIterations,
  identityFromRelPath,
  parseUsageLine,
  shouldReplace,
  totalTokensOf,
} = require('../server/core/usage-entry-core');

function line(overrides = {}) {
  return JSON.stringify({
    timestamp: '2026-08-18T10:00:00.000Z',
    sessionId: 'session-a',
    requestId: 'request-a',
    cwd: 'C:/repo',
    version: '2.1.200',
    isSidechain: false,
    message: {
      id: 'message-a',
      model: 'claude-sonnet-4-20250514',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 2,
      },
    },
    ...overrides,
  });
}

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8').trim();
}

test('parseUsageLine filters non-usage lines, invalid JSON, bad timestamps and wrong versions', () => {
  assert.equal(parseUsageLine('{"message":{}}'), null);
  assert.equal(parseUsageLine('{"usage":{'), null);
  assert.equal(parseUsageLine(line({ timestamp: 'not-a-date' })), null);
  assert.equal(parseUsageLine(line({ version: 'banana' })), null);
  assert.equal(parseUsageLine(line({ version: undefined })).version, null);
  assert.equal(parseUsageLine(line({ version: '1.9.0' }), { versionPrefix: '2.' }), null);
  assert.equal(parseUsageLine(line({ version: '2.1.200' }), { versionPrefix: '2.' }).version, '2.1.200');
});

test('parseUsageLine rejects explicit nulls and present-but-empty identities', () => {
  assert.equal(parseUsageLine(fixture('usage-explicit-null-rejection.jsonl')), null);
  assert.equal(parseUsageLine(line({ costUSD: null })), null);
  assert.equal(parseUsageLine(line({ sessionId: '' })), null);
  assert.equal(parseUsageLine(line({ message: { id: '', model: 'claude-sonnet-4-20250514', usage: {} } })), null);
  assert.equal(parseUsageLine(line({ message: { id: 'message-a', model: '', usage: {} } })), null);
});

test('parseUsageLine accepts api error lines and top-level costUSD wins over nested usage cost', () => {
  const parsed = parseUsageLine(line({
    costUSD: 7,
    isApiErrorMessage: true,
    message: {
      id: 'message-a',
      model: 'claude-sonnet-4-20250514',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 2,
        costUSD: 3,
      },
    },
  }));
  assert.equal(parsed.isSidechain, false);
  assert.equal(parsed.costUSD, 7);
});

test('parseUsageLine handles cache_creation split, flat cache creation, synthetic model and fast label', () => {
  const nested = parseUsageLine(line({
    message: {
      id: 'message-a',
      model: 'claude-opus-4-20250514',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation: {
          ephemeral_5m_input_tokens: 7,
          ephemeral_1h_input_tokens: 11,
        },
        cache_read_input_tokens: 13,
        speed: 'fast',
      },
    },
  }));
  assert.equal(nested.cacheCreation5m, 7);
  assert.equal(nested.cacheCreation1h, 11);
  assert.equal(nested.cacheCreate, 18);
  assert.equal(nested.cacheRead, 13);
  assert.equal(nested.model, 'claude-opus-4-20250514-fast');

  const synthetic = parseUsageLine(line({
    message: {
      id: 'message-a',
      model: '<synthetic>',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 1 },
    },
  }));
  assert.equal(synthetic.model, null);
  assert.equal(totalTokensOf(synthetic), 4);
});

test('expandAdvisorIterations synthesizes advisor entries and ignores message mirrors', () => {
  const advisorEntry = parseUsageLine(fixture('usage-advisor-iterations.jsonl'));
  const advisorEntries = expandAdvisorIterations(advisorEntry);
  assert.equal(advisorEntries.length, 1);
  assert.equal(advisorEntries[0].messageId, 'message-1:advisor:0');
  assert.equal(advisorEntries[0].costUSD, null);
  assert.equal(totalTokensOf(advisorEntries[0]), 10);

  const mirroredEntry = parseUsageLine(fixture('usage-real-shape-iterations-mirror.jsonl'));
  assert.deepEqual(expandAdvisorIterations(mirroredEntry), []);
});

test('dedup keys, replacement preferences and sidechain collision behavior are deterministic', () => {
  const sidechain = { messageId: 'message-a', requestId: 'request-a', isSidechain: true, input: 10, output: 0 };
  const normal = { messageId: 'message-a', requestId: 'request-b', isSidechain: false, input: 5, output: 0 };
  assert.deepEqual(dedupKeys({ messageId: null }), { primary: null, collision: null });
  assert.deepEqual(dedupKeys(sidechain), { primary: 'message-a:request-a', collision: 'message-a' });
  assert.deepEqual(dedupKeys(normal), { primary: 'message-a:request-b', collision: 'message-a' });
  assert.equal(shouldReplace(sidechain, normal), true);
  assert.equal(shouldReplace(normal, sidechain), false);
  assert.equal(shouldReplace({ input: 1 }, { input: 2 }), true);
  assert.equal(shouldReplace({ input: 2 }, { input: 1 }), false);
  assert.equal(shouldReplace({ input: 2, speed: null }, { input: 2, speed: 'fast' }), true);
});

test('sidechain collision fixture dedups to the non-sidechain entry', () => {
  const entries = fixture('usage-dedup-collision.jsonl').split('\n').map((fixtureLine) => parseUsageLine(fixtureLine));
  const deduped = dedupUsageEntries(entries);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].requestId, 'request-b');
  assert.equal(deduped[0].isSidechain, false);
});

test('identityFromRelPath maps direct transcripts and subagent layouts to the parent session', () => {
  assert.deepEqual(identityFromRelPath('projects/C--repo/session-a.jsonl'), { project: 'C--repo', sessionId: 'session-a' });
  assert.deepEqual(identityFromRelPath('C--repo/session-a/subagents/agent-a.jsonl'), { project: 'C--repo', sessionId: 'session-a' });
});

function dedupUsageEntries(entries) {
  const byPrimary = new Map();
  const byCollision = new Map();
  const output = new Set();
  for (const entry of entries) {
    const keys = dedupKeys(entry);
    const existing = byPrimary.get(keys.primary) || byCollision.get(keys.collision);
    const isCollisionDuplicate = existing && (existing.isSidechain || entry.isSidechain);
    const duplicate = byPrimary.has(keys.primary) || isCollisionDuplicate;
    const winner = duplicate && !shouldReplace(existing, entry) ? existing : entry;
    if (!keys.primary) continue;
    output.delete(existing);
    output.add(winner);
    byPrimary.set(keys.primary, winner);
    byCollision.set(keys.collision, winner);
  }
  return Array.from(output);
}
