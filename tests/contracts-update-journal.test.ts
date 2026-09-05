import test from 'node:test';
import assert from 'node:assert/strict';

import { UpdateJournal } from '../shared/contracts/index.ts';

const VALID_JOURNAL = {
  state: 'running',
  fromSha: '1111111111111111111111111111111111111111',
  toSha: '2222222222222222222222222222222222222222',
  toVersion: '0.25.0',
  channel: 'release',
  steps: [{
    id: 'fetch',
    status: 'running',
    startedAt: 1000,
    finishedAt: null,
    outputTail: ['fetching'],
  }],
  activeStep: 'fetch',
  reason: null,
  startedAt: 1000,
  finishedAt: null,
};

test('the update journal contract accepts every terminal state', () => {
  for (const state of ['idle', 'running', 'staged', 'succeeded', 'failed', 'discarded', 'interrupted']) {
    assert.equal(UpdateJournal.safeParse({ ...VALID_JOURNAL, state }).success, true, state);
  }
});

test('the update journal contract rejects unknown fields and invalid steps', () => {
  assert.equal(UpdateJournal.safeParse({ ...VALID_JOURNAL, extra: true }).success, false);
  assert.equal(UpdateJournal.safeParse({
    ...VALID_JOURNAL,
    steps: [{ ...VALID_JOURNAL.steps[0], id: 'checkout' }],
  }).success, false);
});
