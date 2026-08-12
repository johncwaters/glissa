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

test('sparklinePoints: normalizes values into the requested box', async () => {
  const { sparklinePoints } = await importCore();
  assert.equal(sparklinePoints([0, 10, 5], 100, 10), '0,10 50,0 100,5');
});

test('sparklinePoints: renders flat lines through the vertical midpoint', async () => {
  const { sparklinePoints } = await importCore();
  assert.equal(sparklinePoints([7, 7, 7], 10, 10), '0,5 5,5 10,5');
});

test('sparklinePoints: requires at least two finite values', async () => {
  const { sparklinePoints } = await importCore();
  assert.equal(sparklinePoints([3], 64, 16), '');
  assert.equal(sparklinePoints([], 64, 16), '');
  assert.equal(sparklinePoints(undefined, 64, 16), '');
  assert.equal(sparklinePoints(['nope', null], 64, 16), '');
});

test('sparklinePoints: two points span the full width', async () => {
  const { sparklinePoints } = await importCore();
  assert.equal(sparklinePoints([1, 3], 64, 16), '0,16 64,0');
});

// ── Ops section ──────────────────────────────────────────────

test('healthAnomalyRows: only live anomalies produce rows', async () => {
  const { healthAnomalyRows } = await importCore();
  const snapshot = { anomalies: { listenerMismatch: true, orphanPty: false, destroyedReachable: true } };
  assert.deepEqual(healthAnomalyRows(snapshot).map((r) => r.key), ['listenerMismatch', 'destroyedReachable']);
});

test('healthAnomalyRows: an all-zero or absent snapshot renders nothing', async () => {
  const { healthAnomalyRows } = await importCore();
  assert.deepEqual(healthAnomalyRows({ anomalies: { listenerMismatch: false, orphanPty: false, destroyedReachable: false } }), []);
  assert.deepEqual(healthAnomalyRows({}), []);
  assert.deepEqual(healthAnomalyRows(null), []);
  assert.deepEqual(healthAnomalyRows(undefined), []);
});

test('healthAnomalyRows: labels match the health monitor wording', async () => {
  const { healthAnomalyRows } = await importCore();
  const rows = healthAnomalyRows({ anomalies: { orphanPty: true } });
  assert.deepEqual(rows, [{ key: 'orphanPty', label: 'Orphan PTY: session has live PTY but state is DONE/FAILED/DORMANT' }]);
});

test('updateAvailableRow: needs both versions, carries the command', async () => {
  const { updateAvailableRow } = await importCore();
  assert.deepEqual(
    updateAvailableRow({ current: '1.2.0', latest: '1.3.0', command: 'npm i -g glissa' }),
    { text: 'Update available: 1.2.0 -> 1.3.0', command: 'npm i -g glissa' },
  );
  assert.equal(updateAvailableRow({ current: '1.2.0' }), null);
  assert.equal(updateAvailableRow({ latest: '1.3.0' }), null);
  assert.equal(updateAvailableRow(null), null);
});

test('opsRows: the update line leads, then one row per live anomaly', async () => {
  const { opsRows } = await importCore();
  const rows = opsRows({
    update: { current: '1.0.0', latest: '1.1.0', command: 'npm i' },
    health: { anomalies: { orphanPty: true, destroyedReachable: true } },
  });
  assert.deepEqual(rows.map((r) => r.kind), ['update', 'anomaly', 'anomaly']);
  assert.deepEqual(rows.map((r) => r.key), ['update', 'orphanPty', 'destroyedReachable']);
  assert.equal(rows[0].tone, 'dim');
  assert.equal(rows[1].tone, 'warn');
});

test('opsRows: nothing to say renders no rows at all', async () => {
  const { opsRows } = await importCore();
  assert.deepEqual(opsRows({}), []);
  assert.deepEqual(opsRows(), []);
  assert.deepEqual(opsRows({ health: { anomalies: { orphanPty: false } } }), []);
});

// ── Pull requests section ────────────────────────────────────

test('needsActionPrRows: keeps only attention-worthy PRs, flattened across projects', async () => {
  const { needsActionPrRows } = await importCore();
  const rows = needsActionPrRows({
    projects: [
      {
        projectId: 'p1',
        repoSlug: 'me/one',
        prs: [
          { number: 4, title: 'Healthy', phase: 'awaiting-checks' },
          { number: 5, title: 'Broken', phase: 'error' },
        ],
      },
      {
        projectId: 'p2',
        name: 'Two',
        prs: [{ number: 9, title: 'Conflicts', phase: 'conflicting' }],
      },
    ],
  });
  assert.deepEqual(rows.map((r) => r.number), [5, 9]);
  assert.deepEqual(rows.map((r) => r.projectLabel), ['me/one', 'Two']);
  assert.deepEqual(rows.map((r) => r.severity), ['crit', 'warn']);
  assert.equal(rows[1].phase, 'conflicting');
});

test('needsActionPrRows: rows within a project keep the PR attention order', async () => {
  const { needsActionPrRows } = await importCore();
  const rows = needsActionPrRows({
    projects: [{
      projectId: 'p1',
      prs: [
        { number: 1, title: 'Conflicting', phase: 'conflicting' },
        { number: 2, title: 'Errored', phase: 'error' },
      ],
    }],
  });
  assert.deepEqual(rows.map((r) => r.number), [2, 1]);
});

test('needsActionPrRows: an empty, absent or healthy feed yields no rows', async () => {
  const { needsActionPrRows } = await importCore();
  assert.deepEqual(needsActionPrRows(undefined), []);
  assert.deepEqual(needsActionPrRows({ projects: [] }), []);
  assert.deepEqual(needsActionPrRows({ projects: [{ projectId: 'p', prs: [{ number: 1, phase: 'merged' }] }] }), []);
});

test('needsActionPrRows: malformed entries fall back rather than throwing', async () => {
  const { needsActionPrRows } = await importCore();
  const rows = needsActionPrRows({ projects: [{ prs: [{ phase: 'error' }] }] });
  assert.deepEqual(rows, [{
    projectId: '',
    projectLabel: 'project',
    number: null,
    title: 'Untitled pull request',
    phase: 'error',
    severity: 'crit',
  }]);
});

// ── Attention count ──────────────────────────────────────────

const posthogWith = (issues) => ({ projects: [{ projectId: 'ph', issues }] });

test('radarAttentionCount: PostHog spiking and needsHuman issues still count', async () => {
  const { radarAttentionCount } = await importCore();
  const posthog = posthogWith([
    { change: 'spiking', verdict: 'NEEDS_HUMAN' },
    { change: 'quiet', verdict: 'TRANSIENT' },
  ]);
  assert.equal(radarAttentionCount({ posthog }), 2);
});

test('radarAttentionCount: each live anomaly counts once', async () => {
  const { radarAttentionCount } = await importCore();
  assert.equal(radarAttentionCount({ health: { anomalies: { orphanPty: true, listenerMismatch: true } } }), 2);
  assert.equal(radarAttentionCount({ health: { anomalies: { orphanPty: false } } }), 0);
});

test('radarAttentionCount: each needs-action PR counts once, healthy ones never', async () => {
  const { radarAttentionCount } = await importCore();
  const prs = { projects: [{ projectId: 'p', prs: [{ phase: 'error' }, { phase: 'done' }, { phase: 'awaiting-checks' }] }] };
  assert.equal(radarAttentionCount({ prs }), 2);
});

test('radarAttentionCount: an available update is advisory and adds nothing', async () => {
  const { radarAttentionCount } = await importCore();
  const update = { current: '1.0.0', latest: '2.0.0', command: 'npm i' };
  assert.equal(radarAttentionCount({ update }), 0);
  assert.equal(radarAttentionCount({ posthog: posthogWith([{ change: 'spiking' }]), update }), 1);
});

test('radarAttentionCount: the three sources sum', async () => {
  const { radarAttentionCount } = await importCore();
  const total = radarAttentionCount({
    posthog: posthogWith([{ change: 'spiking' }, { change: 'quiet', verdict: 'NEEDS_HUMAN' }]),
    health: { anomalies: { destroyedReachable: true } },
    prs: { projects: [{ projectId: 'p', prs: [{ phase: 'conflicting' }] }] },
    update: { current: '1.0.0', latest: '2.0.0' },
  });
  assert.equal(total, 4);
});

test('radarAttentionCount: every feed absent is zero, never a throw', async () => {
  const { radarAttentionCount } = await importCore();
  assert.equal(radarAttentionCount(), 0);
  assert.equal(radarAttentionCount({}), 0);
  assert.equal(radarAttentionCount({ posthog: null, health: null, prs: null }), 0);
});
