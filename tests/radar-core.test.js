'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// radar-core is ESM (.mjs); dynamic-import it from this CJS test file.
const importCore = () => import('../public/radar-core.mjs');

const changesOf = (issues) => issues.map((i) => i.change);

test('sortIssuesByAttention: orders spiking, regressed, worsened, new, quiet', async () => {
  const { sortIssuesByAttention } = await importCore();
  const issues = [
    { issueId: 'a', change: 'quiet' },
    { issueId: 'b', change: 'new' },
    { issueId: 'c', change: 'regressed' },
    { issueId: 'd', change: 'worsened' },
    { issueId: 'e', change: 'spiking' },
  ];
  assert.deepEqual(changesOf(sortIssuesByAttention(issues)), ['spiking', 'regressed', 'worsened', 'new', 'quiet']);
});

test('sortIssuesByAttention: does not mutate the input array', async () => {
  const { sortIssuesByAttention } = await importCore();
  const issues = [{ change: 'quiet' }, { change: 'spiking' }];
  const sorted = sortIssuesByAttention(issues);
  assert.deepEqual(changesOf(issues), ['quiet', 'spiking']);
  assert.deepEqual(changesOf(sorted), ['spiking', 'quiet']);
});

test('sortIssuesByAttention: same change ranks by users, then occurrences', async () => {
  const { sortIssuesByAttention } = await importCore();
  const issues = [
    { issueId: 'few-users', change: 'spiking', users: 2, occurrences: 900 },
    { issueId: 'many-users', change: 'spiking', users: 40, occurrences: 41 },
    { issueId: 'tied-users', change: 'spiking', users: 40, occurrences: 500 },
  ];
  assert.deepEqual(
    sortIssuesByAttention(issues).map((i) => i.issueId),
    ['tied-users', 'many-users', 'few-users'],
  );
});

test('sortIssuesByAttention: fully tied rows keep the order the backend sent', async () => {
  const { sortIssuesByAttention } = await importCore();
  const issues = [
    { issueId: 'first', change: 'new', users: 1, occurrences: 1 },
    { issueId: 'second', change: 'new', users: 1, occurrences: 1 },
    { issueId: 'third', change: 'new', users: 1, occurrences: 1 },
  ];
  assert.deepEqual(sortIssuesByAttention(issues).map((i) => i.issueId), ['first', 'second', 'third']);
});

test('sortIssuesByAttention: an unknown change sorts last rather than jumping the queue', async () => {
  const { sortIssuesByAttention } = await importCore();
  const issues = [
    { issueId: 'weird', change: 'sideways' },
    { issueId: 'calm', change: 'quiet' },
    { issueId: 'hot', change: 'spiking' },
  ];
  assert.deepEqual(sortIssuesByAttention(issues).map((i) => i.issueId), ['hot', 'calm', 'weird']);
});

test('sortIssuesByAttention: missing numbers count as zero and never throw', async () => {
  const { sortIssuesByAttention } = await importCore();
  const issues = [
    { issueId: 'unknown-counts', change: 'spiking' },
    { issueId: 'counted', change: 'spiking', users: 3, occurrences: 3 },
  ];
  assert.deepEqual(sortIssuesByAttention(issues).map((i) => i.issueId), ['counted', 'unknown-counts']);
});

test('sortIssuesByAttention: a non-array input returns an empty array', async () => {
  const { sortIssuesByAttention } = await importCore();
  assert.deepEqual(sortIssuesByAttention(undefined), []);
  assert.deepEqual(sortIssuesByAttention(null), []);
});

test('severityFor: crit for spiking and regressed, warn for worsened and new, dim otherwise', async () => {
  const { severityFor } = await importCore();
  assert.equal(severityFor('spiking'), 'crit');
  assert.equal(severityFor('regressed'), 'crit');
  assert.equal(severityFor('worsened'), 'warn');
  assert.equal(severityFor('new'), 'warn');
  assert.equal(severityFor('quiet'), 'dim');
  assert.equal(severityFor('sideways'), 'dim');
  assert.equal(severityFor(undefined), 'dim');
});

test('summarizeIssues: counts active issues, spiking changes and NEEDS_HUMAN verdicts', async () => {
  const { summarizeIssues } = await importCore();
  const issues = [
    { issueId: 'a', change: 'spiking', verdict: 'NEEDS_HUMAN' },
    { issueId: 'b', change: 'spiking', verdict: null },
    { issueId: 'c', change: 'quiet', verdict: 'NEEDS_HUMAN' },
    { issueId: 'd', change: 'new', verdict: 'TRANSIENT' },
  ];
  assert.deepEqual(summarizeIssues(issues), { active: 4, spiking: 2, needsHuman: 2 });
});

test('summarizeIssues: a non-array or empty input summarizes to zeroes', async () => {
  const { summarizeIssues } = await importCore();
  assert.deepEqual(summarizeIssues([]), { active: 0, spiking: 0, needsHuman: 0 });
  assert.deepEqual(summarizeIssues(undefined), { active: 0, spiking: 0, needsHuman: 0 });
  assert.deepEqual(summarizeIssues(null), { active: 0, spiking: 0, needsHuman: 0 });
});

test('summarizeIssues: malformed entries never throw', async () => {
  const { summarizeIssues } = await importCore();
  assert.deepEqual(summarizeIssues([null, undefined, {}]), { active: 3, spiking: 0, needsHuman: 0 });
});
