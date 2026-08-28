'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// attention-core is ESM (.mjs); dynamic-import it from this CJS test file.
const importCore = () => import('../public/focus-view/attention-core.mjs');

test('orderRoster: non-dormant before dormant, alphabetical within each group', async () => {
  const { orderRoster } = await importCore();
  const out = orderRoster([
    { id: '1', name: 'zebra', isDormant: false },
    { id: '2', name: 'alpha', isDormant: true },
    { id: '3', name: 'mike', isDormant: false },
    { id: '4', name: 'bravo', isDormant: true },
  ]).map((s) => s.id);
  // active: mike(3), zebra(1); dormant: alpha(2), bravo(4)
  assert.deepEqual(out, ['3', '1', '2', '4']);
});

test('orderRoster: numeric, case-insensitive name order', async () => {
  const { orderRoster } = await importCore();
  const out = orderRoster([
    { id: 'a', name: 'Session 10', isDormant: false },
    { id: 'b', name: 'session 2', isDormant: false },
  ]).map((s) => s.id);
  assert.deepEqual(out, ['b', 'a']); // 2 before 10 (numeric), case-insensitive
});

test('orderRoster: stable under input permutation and ignores status fields', async () => {
  const { orderRoster } = await importCore();
  const base = [
    { id: '1', name: 'alpha', isDormant: false, state: 'RUNNING' },
    { id: '2', name: 'bravo', isDormant: false, state: 'WAITING' },
    { id: '3', name: 'charlie', isDormant: false, state: 'COMPLETE' },
  ];
  const a = orderRoster(base).map((s) => s.id);
  const b = orderRoster([base[2], base[0], base[1]]).map((s) => s.id);
  assert.deepEqual(a, ['1', '2', '3']);
  assert.deepEqual(b, ['1', '2', '3']); // same output regardless of input order or state
});

test('orderRoster: does not mutate its input', async () => {
  const { orderRoster } = await importCore();
  const input = [
    { id: '1', name: 'zebra', isDormant: false },
    { id: '2', name: 'alpha', isDormant: false },
  ];
  orderRoster(input);
  assert.deepEqual(input.map((s) => s.id), ['1', '2']); // input untouched
});

test('pickNextAttention: empty queue returns null', async () => {
  const { pickNextAttention } = await importCore();
  assert.equal(pickNextAttention([], 'x'), null);
});

test('pickNextAttention: advances and wraps around', async () => {
  const { pickNextAttention } = await importCore();
  assert.equal(pickNextAttention(['a', 'b', 'c'], 'a'), 'b');
  assert.equal(pickNextAttention(['a', 'b', 'c'], 'b'), 'c');
  assert.equal(pickNextAttention(['a', 'b', 'c'], 'c'), 'a'); // wrap
});

test('pickNextAttention: currentId absent starts at the front', async () => {
  const { pickNextAttention } = await importCore();
  assert.equal(pickNextAttention(['a', 'b'], 'zzz'), 'a');
  assert.equal(pickNextAttention(['a', 'b'], null), 'a');
});

test('pickNextAttention: single-element queue stays put', async () => {
  const { pickNextAttention } = await importCore();
  assert.equal(pickNextAttention(['only'], 'only'), 'only');
});

test('pickAdjacent: empty list returns null', async () => {
  const { pickAdjacent } = await importCore();
  assert.equal(pickAdjacent([], 'x', 1), null);
  assert.equal(pickAdjacent([], 'x', -1), null);
});

test('pickAdjacent: steps forward and backward', async () => {
  const { pickAdjacent } = await importCore();
  assert.equal(pickAdjacent(['a', 'b', 'c'], 'a', 1), 'b');
  assert.equal(pickAdjacent(['a', 'b', 'c'], 'b', 1), 'c');
  assert.equal(pickAdjacent(['a', 'b', 'c'], 'c', -1), 'b');
  assert.equal(pickAdjacent(['a', 'b', 'c'], 'b', -1), 'a');
});

test('pickAdjacent: wraps around both ends', async () => {
  const { pickAdjacent } = await importCore();
  assert.equal(pickAdjacent(['a', 'b', 'c'], 'c', 1), 'a'); // bottom -> top
  assert.equal(pickAdjacent(['a', 'b', 'c'], 'a', -1), 'c'); // top -> bottom
});

test('pickAdjacent: absent cursor starts at the correct end per direction', async () => {
  const { pickAdjacent } = await importCore();
  assert.equal(pickAdjacent(['a', 'b'], 'gone', 1), 'a'); // down -> top
  assert.equal(pickAdjacent(['a', 'b'], null, 1), 'a');
  assert.equal(pickAdjacent(['a', 'b'], 'gone', -1), 'b'); // up -> bottom
  assert.equal(pickAdjacent(['a', 'b'], null, -1), 'b');
});

test('pickAdjacent: single-element list stays put either direction', async () => {
  const { pickAdjacent } = await importCore();
  assert.equal(pickAdjacent(['only'], 'only', 1), 'only');
  assert.equal(pickAdjacent(['only'], 'only', -1), 'only');
});

// ── The shared "needs you" rule ──
// The desktop rail head and the phone Board both render this count under the same wording, so the rule
// lives in this one core and these tests are what keep the two surfaces honest.

const attentionRow = (id, state, unseen) => ({ id, state, unseen });

test('needsAttention: WAITING always qualifies, regardless of the unseen flag', async () => {
  const { needsAttention } = await importCore();
  assert.equal(needsAttention({ state: 'WAITING' }), true);
  assert.equal(needsAttention({ state: 'WAITING', unseen: false }), true);
});

test('needsAttention: COMPLETE qualifies only while it is unseen', async () => {
  const { needsAttention } = await importCore();
  assert.equal(needsAttention({ state: 'COMPLETE', unseen: true }), true);
  assert.equal(needsAttention({ state: 'COMPLETE', unseen: false }), false);
  // An absent flag is not an unseen flag: a caller that never tracked it must not inflate the count.
  assert.equal(needsAttention({ state: 'COMPLETE' }), false);
});

test('needsAttention: no other state qualifies, and the unseen flag cannot promote one', async () => {
  const { needsAttention } = await importCore();
  for (const state of ['RUNNING', 'FAILED', 'IDLE', 'DONE', 'DORMANT', 'STARTING', 'INITIALIZING']) {
    assert.equal(needsAttention({ state }), false, `${state} must not qualify`);
    assert.equal(needsAttention({ state, unseen: true }), false, `${state} must not qualify when unseen`);
  }
  assert.equal(needsAttention({}), false);
  assert.equal(needsAttention(), false);
});

test('countSessionsNeedingAttention: counts exactly the rows needsAttention accepts', async () => {
  const { countSessionsNeedingAttention } = await importCore();
  assert.equal(countSessionsNeedingAttention([
    attentionRow('a', 'WAITING'),
    attentionRow('b', 'FAILED'),
    attentionRow('c', 'COMPLETE', true),
    attentionRow('d', 'COMPLETE', false),
    attentionRow('e', 'RUNNING'),
    attentionRow('f', 'IDLE'),
  ]), 2);
  assert.equal(countSessionsNeedingAttention([attentionRow('a', 'RUNNING'), attentionRow('b', 'DORMANT')]), 0);
  assert.equal(countSessionsNeedingAttention([]), 0);
  assert.equal(countSessionsNeedingAttention(undefined), 0);
  assert.equal(countSessionsNeedingAttention([null, undefined]), 0);
});

test('attentionSummaryText: resting reads as a sentence, never an empty slot', async () => {
  const { attentionSummaryText } = await importCore();
  assert.equal(attentionSummaryText(0), 'ALL CLEAR');
  assert.equal(attentionSummaryText(-1), 'ALL CLEAR');
  assert.equal(attentionSummaryText(1), '1 NEEDS YOU');
  assert.equal(attentionSummaryText(4), '4 NEED YOU');
});

test('pickStrongestAttention: a raised hand outranks an arrival dot whatever the order', async () => {
  const { pickStrongestAttention } = await importCore();
  assert.equal(pickStrongestAttention(['unseen', 'hand']), 'hand');
  assert.equal(pickStrongestAttention(['hand', 'unseen']), 'hand');
  assert.equal(pickStrongestAttention([false, true, 'hand', false]), 'hand');
  assert.equal(pickStrongestAttention(['hand', true]), 'hand');
});

test('pickStrongestAttention: equal-rank levels resolve to the first one asking', async () => {
  const { pickStrongestAttention } = await importCore();
  assert.equal(pickStrongestAttention([false, 'unseen', true]), 'unseen');
  assert.equal(pickStrongestAttention([true, 'unseen']), true);
  assert.equal(pickStrongestAttention([false, true]), true);
});

test('pickStrongestAttention: nothing asking is false, never a stray truthy level', async () => {
  const { pickStrongestAttention } = await importCore();
  assert.equal(pickStrongestAttention([]), false);
  assert.equal(pickStrongestAttention([false, false]), false);
  assert.equal(pickStrongestAttention([null, undefined, '']), false);
  assert.equal(pickStrongestAttention(), false);
});

test('attentionRank: an unknown level still counts as asking, below a raised hand', async () => {
  const { attentionRank } = await importCore();
  assert.equal(attentionRank('hand'), 2);
  assert.equal(attentionRank('unseen'), 1);
  assert.equal(attentionRank('something-new'), 1);
  assert.equal(attentionRank(true), 1);
  assert.equal(attentionRank(false), 0);
  assert.equal(attentionRank(undefined), 0);
});
