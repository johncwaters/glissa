'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// attention-ack-core is ESM (.mjs); dynamic-import it from this CJS test file.
const importCore = () => import('../public/attention-ack-core.mjs');

test('attentionSignature: sorts and dedupes, so the same facts in any order are one signature', async () => {
  const { attentionSignature } = await importCore();
  assert.equal(attentionSignature(['b', 'a']), 'a|b');
  assert.equal(attentionSignature(['a', 'b']), attentionSignature(['b', 'a']));
  assert.equal(attentionSignature(['a', 'a']), 'a');
});

test('attentionSignature: nothing to say is the empty signature, never a throw', async () => {
  const { attentionSignature } = await importCore();
  assert.equal(attentionSignature([]), '');
  assert.equal(attentionSignature(null), '');
  assert.equal(attentionSignature(undefined), '');
  assert.equal(attentionSignature(['', null, 3, {}, 'a']), 'a');
});

test('decideAttention: a fresh fact shows the dot and looking at it clears it', async () => {
  const { decideAttention } = await importCore();
  const first = decideAttention('a', '');
  assert.deepEqual(first, { shown: true, acknowledged: '' });
  assert.deepEqual(decideAttention('a', 'a'), { shown: false, acknowledged: 'a' });
});

test('decideAttention: a changed signature re-lights an acknowledged dot', async () => {
  const { decideAttention } = await importCore();
  assert.equal(decideAttention('a|b', 'a').shown, true);
  assert.equal(decideAttention('b', 'a').shown, true);
});

test('decideAttention: the condition clearing drops the dot AND the acknowledgement, so a recurrence re-arms', async () => {
  const { decideAttention } = await importCore();
  const cleared = decideAttention('', 'a');
  assert.deepEqual(cleared, { shown: false, acknowledged: '' });
  assert.equal(decideAttention('a', cleared.acknowledged).shown, true);
});

test('decideAttention: a missing or corrupt stored acknowledgement still shows a live fact', async () => {
  const { decideAttention } = await importCore();
  assert.equal(decideAttention('a', null).shown, true);
  assert.equal(decideAttention('a', undefined).shown, true);
  assert.equal(decideAttention('a', 42).shown, true);
  assert.deepEqual(decideAttention(null, 'a'), { shown: false, acknowledged: '' });
});
