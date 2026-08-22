'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// radar-core is ESM (.mjs); dynamic-import it from this CJS test file.
const importCore = () => import('../public/radar-core.mjs');

const changesOf = (issues) => issues.map((i) => i.change);

test('radarPlaceholder: waits for an initial server status', async () => {
  const { radarPlaceholder } = await importCore();
  assert.equal(radarPlaceholder(null), 'Waiting for PostHog monitoring status from the server.');
  assert.equal(radarPlaceholder(undefined), 'Waiting for PostHog monitoring status from the server.');
});

test('radarPlaceholder: reports a misconfigured lane with the reason', async () => {
  const { radarPlaceholder } = await importCore();
  assert.equal(
    radarPlaceholder({ configured: false, reason: 'apiKey missing' }),
    'PostHog monitoring is misconfigured: apiKey missing. Open Settings and its PostHog tab.',
  );
});

test('radarPlaceholder: reports a disabled lane without a reason', async () => {
  const { radarPlaceholder } = await importCore();
  assert.equal(
    radarPlaceholder({ configured: false, reason: '' }),
    'PostHog monitoring is off. Open Settings and its PostHog tab to switch it on.',
  );
});

test('radarPlaceholder: reports configured or legacy statuses as waiting for first poll', async () => {
  const { radarPlaceholder } = await importCore();
  assert.equal(radarPlaceholder({ configured: true }), 'PostHog monitoring is on. Waiting for the first poll.');
  assert.equal(radarPlaceholder({}), 'PostHog monitoring is on. Waiting for the first poll.');
});

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

// ── Quiet vs loud projects ───────────────────────────────────
const NOW = 1_700_000_000_000;
const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const quietProject = (over = {}) => ({ projectId: 1, name: 'web', host: 'https://ph.test', lastTickAt: NOW, issues: [], ...over });
const namesOf = (entries) => entries.map((entry) => entry.project.projectId);

test('partitionRadarProjects: a healthy project is quiet, any active issue makes it loud', async () => {
  const { partitionRadarProjects } = await importCore();
  const projects = [
    quietProject({ projectId: 1 }),
    quietProject({ projectId: 2, issues: [{ issueId: 'a', change: 'quiet' }] }),
  ];
  const { loud, quiet } = partitionRadarProjects(projects, NOW, { intervalMs: FIFTEEN_MIN_MS });
  assert.deepEqual(namesOf(quiet), [1]);
  assert.deepEqual(namesOf(loud), [2]);
});

test('partitionRadarProjects: a spiking issue is loud on its own', async () => {
  const { partitionRadarProjects } = await importCore();
  const projects = [quietProject({ issues: [{ issueId: 'a', change: 'spiking' }] })];
  const { loud, quiet } = partitionRadarProjects(projects, NOW, { intervalMs: FIFTEEN_MIN_MS });
  assert.equal(quiet.length, 0);
  assert.equal(loud[0].counts.spiking, 1);
});

test('partitionRadarProjects: a poll error is loud with zero issues, and carries the reason', async () => {
  const { partitionRadarProjects } = await importCore();
  const projects = [quietProject({ error: 'HTTP 401' })];
  const { loud } = partitionRadarProjects(projects, NOW, { intervalMs: FIFTEEN_MIN_MS });
  assert.equal(loud.length, 1);
  assert.equal(loud[0].error, 'HTTP 401');
  assert.equal(loud[0].counts.active, 0);
});

test('partitionRadarProjects: staleness is two poll intervals, exclusive at the edge', async () => {
  const { partitionRadarProjects } = await importCore();
  const opts = { intervalMs: FIFTEEN_MIN_MS };
  const atEdge = [quietProject({ lastTickAt: NOW - 2 * FIFTEEN_MIN_MS })];
  assert.equal(partitionRadarProjects(atEdge, NOW, opts).quiet.length, 1, 'exactly two intervals is not yet stale');
  const past = [quietProject({ lastTickAt: NOW - 2 * FIFTEEN_MIN_MS - 1 })];
  const { loud } = partitionRadarProjects(past, NOW, opts);
  assert.equal(loud.length, 1);
  assert.equal(loud[0].staleMs, 2 * FIFTEEN_MIN_MS + 1);
});

test('partitionRadarProjects: an unknown interval falls back to the five minute default', async () => {
  const { partitionRadarProjects, DEFAULT_STALE_MS } = await importCore();
  assert.equal(DEFAULT_STALE_MS, 5 * 60 * 1000);
  const projects = [quietProject({ lastTickAt: NOW - DEFAULT_STALE_MS - 1 })];
  assert.equal(partitionRadarProjects(projects, NOW, {}).loud.length, 1);
  assert.equal(partitionRadarProjects([quietProject({ lastTickAt: NOW - DEFAULT_STALE_MS })], NOW, {}).quiet.length, 1);
});

test('partitionRadarProjects: a project that never polled is not called stale, only errored', async () => {
  const { partitionRadarProjects } = await importCore();
  assert.equal(partitionRadarProjects([quietProject({ lastTickAt: 0 })], NOW, {}).quiet.length, 1);
  assert.equal(partitionRadarProjects([quietProject({ lastTickAt: 0, error: 'no response' })], NOW, {}).loud.length, 1);
});

test('partitionRadarProjects: a malformed or absent list never throws', async () => {
  const { partitionRadarProjects } = await importCore();
  assert.deepEqual(partitionRadarProjects(undefined, NOW, {}), { loud: [], quiet: [] });
  const { quiet } = partitionRadarProjects([{}], NOW, {});
  assert.equal(quiet.length, 1);
});

test('radarDisplayName: a mapped path shows its last segment, a plain name shows itself', async () => {
  const { radarDisplayName } = await importCore();
  assert.equal(radarDisplayName({ name: '/home/jwaters/Projects/claude-setup' }), 'claude-setup');
  assert.equal(radarDisplayName({ name: 'C:\\code\\web-app\\' }), 'web-app');
  assert.equal(radarDisplayName({ name: 'Marketing site' }), 'Marketing site');
});

test('radarDisplayName: falls back to the raw project id when there is no name', async () => {
  const { radarDisplayName } = await importCore();
  assert.equal(radarDisplayName({ projectId: 7 }), '7');
  assert.equal(radarDisplayName({ projectId: 7, name: '   ' }), '7');
  assert.equal(radarDisplayName({ projectId: 7, name: '/' }), '7');
  assert.equal(radarDisplayName({}), 'project');
});

test('shortHost: keeps the hostname only', async () => {
  const { shortHost } = await importCore();
  assert.equal(shortHost('https://us.posthog.com'), 'us.posthog.com');
  assert.equal(shortHost('http://ph.local:8000/some/path'), 'ph.local');
  assert.equal(shortHost('eu.posthog.com'), 'eu.posthog.com');
  assert.equal(shortHost(''), '');
  assert.equal(shortHost(undefined), '');
});

test('hostsDiffer: only a second distinct host earns the label', async () => {
  const { hostsDiffer } = await importCore();
  const same = [quietProject({ projectId: 1 }), quietProject({ projectId: 2 })];
  assert.equal(hostsDiffer(same), false);
  assert.equal(hostsDiffer([quietProject({ projectId: 1, host: '' })]), false);
  const mixed = [quietProject({ projectId: 1 }), quietProject({ projectId: 2, host: 'https://eu.posthog.com' })];
  assert.equal(hostsDiffer(mixed), true);
  assert.equal(hostsDiffer(undefined), false);
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

test('updateAvailableRow: ignores shas and renders the version pair', async () => {
  const { updateAvailableRow } = await importCore();
  assert.deepEqual(
    updateAvailableRow({
      current: '1.2.0',
      latest: '1.3.0',
      currentSha: '0123456789abcdef0123456789abcdef01234567',
      latestSha: 'FEDCBA9876543210fedcba9876543210fedcba98',
      command: 'npm i -g glissa',
    }),
    { text: 'Update available: 1.2.0 -> 1.3.0', command: 'npm i -g glissa' },
  );
  const versionFallback = updateAvailableRow({ current: '1.2.0', latest: '1.3.0', currentSha: 'not-a-sha', command: 'c' });
  assert.equal(versionFallback.text, 'Update available: 1.2.0 -> 1.3.0');
});

test('updateBannerText: renders only the version pair', async () => {
  const { updateBannerText } = await importCore();
  const shas = {
    currentSha: '0123456789abcdef0123456789abcdef01234567',
    latestSha: 'fedcba9876543210fedcba9876543210fedcba98',
  };
  assert.equal(updateBannerText({ ...shas, current: '1.2.0', latest: '1.2.0' }), 'Update available: 1.2.0 -> 1.2.0');
  assert.equal(updateBannerText({ ...shas, current: '1.2.0', latest: '1.3.0' }), 'Update available: 1.2.0 -> 1.3.0');
  assert.equal(updateBannerText({ current: '1.2.0', latest: '1.3.0' }), 'Update available: 1.2.0 -> 1.3.0');
});

test('shortSha: 7 lowercase chars for a hex sha, empty string otherwise', async () => {
  const { shortSha } = await importCore();
  assert.equal(shortSha('0123456789ABCDEF0123456789abcdef01234567'), '0123456');
  assert.equal(shortSha('0123abc'), '0123abc');
  assert.equal(shortSha('main'), '');
  assert.equal(shortSha(null), '');
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
          { number: 5, title: 'Broken', phase: 'error', reason: 'checks failing' },
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
  assert.deepEqual(rows.map((r) => r.reason), ['checks failing', '']);
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
    reason: '',
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

test('radarAttentionCount: PR facts belong to the PRs surfaces and add nothing here', async () => {
  const { radarAttentionCount } = await importCore();
  const prs = { projects: [{ projectId: 'p', prs: [{ phase: 'error' }, { phase: 'done' }, { phase: 'awaiting-checks' }] }] };
  assert.equal(radarAttentionCount({ prs }), 0, 'one failing PR must raise one dot, not three');
});

test('radarAttentionCount: an available update is advisory and adds nothing', async () => {
  const { radarAttentionCount } = await importCore();
  const update = { current: '1.0.0', latest: '2.0.0', command: 'npm i' };
  assert.equal(radarAttentionCount({ update }), 0);
  assert.equal(radarAttentionCount({ posthog: posthogWith([{ change: 'spiking' }]), update }), 1);
});

test('radarAttentionCount: the two sources sum', async () => {
  const { radarAttentionCount } = await importCore();
  const total = radarAttentionCount({
    posthog: posthogWith([{ change: 'spiking' }, { change: 'quiet', verdict: 'NEEDS_HUMAN' }]),
    health: { anomalies: { destroyedReachable: true } },
    prs: { projects: [{ projectId: 'p', prs: [{ phase: 'conflicting' }] }] },
    update: { current: '1.0.0', latest: '2.0.0' },
  });
  assert.equal(total, 3);
});

test('radarAttentionCount: every feed absent is zero, never a throw', async () => {
  const { radarAttentionCount } = await importCore();
  assert.equal(radarAttentionCount(), 0);
  assert.equal(radarAttentionCount({}), 0);
  assert.equal(radarAttentionCount({ posthog: null, health: null, prs: null }), 0);
});

test('radarAttentionSignature: names each attention issue by project, id and why', async () => {
  const { radarAttentionSignature } = await importCore();
  const posthog = { projects: [{ projectId: 'ph', issues: [
    { issueId: 'i1', change: 'spiking' },
    { issueId: 'i2', verdict: 'NEEDS_HUMAN' },
    { issueId: 'i3', change: 'quiet' },
  ] }] };
  assert.equal(radarAttentionSignature({ posthog }), 'issue:ph/i1:spiking|issue:ph/i2:needs-human');
});

test('radarAttentionSignature: one issue that is both spiking and needs-human names both facts', async () => {
  const { radarAttentionSignature } = await importCore();
  const posthog = { projects: [{ projectId: 'ph', issues: [{ issueId: 'i1', change: 'spiking', verdict: 'NEEDS_HUMAN' }] }] };
  assert.equal(radarAttentionSignature({ posthog }), 'issue:ph/i1:needs-human|issue:ph/i1:spiking');
});

test('radarAttentionSignature: live anomalies are named by key, quiet ones are absent', async () => {
  const { radarAttentionSignature } = await importCore();
  assert.equal(radarAttentionSignature({ health: { anomalies: { orphanPty: true, destroyedReachable: false } } }), 'health:orphanPty');
  assert.equal(radarAttentionSignature({ health: { anomalies: { orphanPty: false } } }), '');
});

test('radarAttentionSignature: PR facts are absent, and feed order never changes it', async () => {
  const { radarAttentionSignature } = await importCore();
  const prs = { projects: [{ projectId: 'p', prs: [{ number: 7, phase: 'error' }] }] };
  const posthog = { projects: [{ projectId: 'ph', issues: [{ issueId: 'i1', change: 'spiking' }] }] };
  assert.equal(radarAttentionSignature({ prs }), '');
  assert.equal(
    radarAttentionSignature({ posthog, health: { anomalies: { orphanPty: true } }, prs }),
    radarAttentionSignature({ health: { anomalies: { orphanPty: true } }, posthog }),
  );
});

test('radarAttentionSignature: quiet or absent feeds are the empty signature, never a throw', async () => {
  const { radarAttentionSignature } = await importCore();
  assert.equal(radarAttentionSignature(), '');
  assert.equal(radarAttentionSignature({ posthog: null, health: null }), '');
  assert.equal(radarAttentionSignature({ posthog: posthogWith([{ change: 'quiet' }]) }), '');
});

test('radarAttentionSignature: an issue with no id still counts, keyed by title then position', async () => {
  const { radarAttentionCount, radarAttentionSignature } = await importCore();
  const posthog = { projects: [{ projectId: 'ph', issues: [
    { title: 'Cannot read length', change: 'spiking' },
    { change: 'spiking' },
  ] }] };
  assert.equal(radarAttentionCount({ posthog }), 2);
  assert.equal(radarAttentionSignature({ posthog }), 'issue:ph/#1:spiking|issue:ph/Cannot read length:spiking');
});

// --- Investigations inbox rows ---

const investigationRecord = (over = {}) => ({
  id: 'iss-1@1700',
  key: 'ph.test/1#iss-1',
  projectId: 1,
  projectName: 'web',
  host: 'https://ph.test',
  issueId: 'iss-1',
  title: 'TypeError: boom',
  url: 'https://ph.test/project/1/error_tracking/iss-1',
  verdict: 'ROOT_CAUSE',
  summaryLine: 'null deref in the retry path',
  at: 1700,
  archived: false,
  ...over,
});

test('investigationRows: absent field renders nothing (older server payload)', async () => {
  const { investigationRows } = await importCore();
  assert.deepEqual(investigationRows({ type: 'posthog-status', projects: [] }), []);
  assert.deepEqual(investigationRows(null), []);
  assert.deepEqual(investigationRows({ investigations: 'nope' }), []);
});

test('investigationRows: drops archived records and orders newest first', async () => {
  const { investigationRows } = await importCore();
  const rows = investigationRows({
    investigations: [
      investigationRecord({ id: 'a@100', at: 100 }),
      investigationRecord({ id: 'c@300', at: 300 }),
      investigationRecord({ id: 'b@200', at: 200, archived: true }),
    ],
  });
  assert.deepEqual(rows.map((row) => row.id), ['c@300', 'a@100']);
});

test('investigationRows: a locally archived id stays gone even when the payload still carries it', async () => {
  const { investigationRows } = await importCore();
  // Exactly the shape a cached/replayed snapshot has: the server built it before the archive, so the
  // record is present and unarchived. The row must not come back.
  const snapshot = {
    investigations: [
      investigationRecord({ id: 'a@100', at: 100 }),
      investigationRecord({ id: 'b@200', at: 200 }),
    ],
  };
  assert.deepEqual(investigationRows(snapshot, new Set(['b@200'])).map((row) => row.id), ['a@100']);
  assert.deepEqual(investigationRows(snapshot, new Set()).map((row) => row.id), ['b@200', 'a@100']);
  assert.deepEqual(investigationRows(snapshot).map((row) => row.id), ['b@200', 'a@100'], 'the argument is optional');
});

test('retainKnownInvestigationIds: forgets an id the payload no longer carries', async () => {
  const { retainKnownInvestigationIds } = await importCore();
  const ids = new Set(['a@100', 'b@200']);
  retainKnownInvestigationIds({ investigations: [investigationRecord({ id: 'a@100' })] }, ids);
  assert.deepEqual([...ids], ['a@100'], 'the server confirmed b, so the local guard drops it');

  retainKnownInvestigationIds({ investigations: [] }, ids);
  assert.deepEqual([...ids], [], 'the set can never grow for the life of the page');
  assert.doesNotThrow(() => retainKnownInvestigationIds(null, ids));
  assert.doesNotThrow(() => retainKnownInvestigationIds({ investigations: 'nope' }, new Set(['x'])));
});

test('retainKnownInvestigationIds: an archived-but-still-sent record keeps its guard', async () => {
  const { retainKnownInvestigationIds } = await importCore();
  const ids = new Set(['a@100']);
  retainKnownInvestigationIds({ investigations: [investigationRecord({ id: 'a@100', archived: true })] }, ids);
  assert.deepEqual([...ids], ['a@100'], 'still on the wire, so the guard is still load-bearing');
});

test('investigationRows: normalizes one record into a renderable row', async () => {
  const { investigationRows } = await importCore();
  const [row] = investigationRows({ investigations: [investigationRecord({ verdict: 'needs_human' })] });
  assert.deepEqual(row, {
    id: 'iss-1@1700',
    issueId: 'iss-1',
    projectId: 1,
    projectLabel: 'web',
    title: 'TypeError: boom',
    summaryLine: 'null deref in the retry path',
    url: 'https://ph.test/project/1/error_tracking/iss-1',
    verdict: 'NEEDS_HUMAN',
    mode: 'investigate',
    prUrl: '',
    at: 1700,
  });
});

test('investigationRows: survives a partial record and skips one with no id', async () => {
  const { investigationRows } = await importCore();
  const rows = investigationRows({
    investigations: [null, 'nope', { id: '' }, { id: 'x@1' }],
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    id: 'x@1',
    issueId: '',
    projectId: null,
    projectLabel: '',
    title: 'Untitled issue',
    summaryLine: '',
    url: '',
    verdict: 'ERROR',
    mode: 'investigate',
    prUrl: '',
    at: 0,
  });
});

test('verdictLabel: every verdict has wording, including the auto-fix one', async () => {
  const { verdictLabel } = await importCore();
  assert.equal(verdictLabel('ROOT_CAUSE'), 'root cause');
  assert.equal(verdictLabel('NEEDS_HUMAN'), 'needs you');
  assert.equal(verdictLabel('TRANSIENT'), 'transient');
  assert.equal(verdictLabel('FIXED'), 'fixed');
  assert.equal(verdictLabel('ERROR'), 'error');
});

test('verdictLabel: an unknown verdict falls back to its own lowercased text', async () => {
  const { verdictLabel } = await importCore();
  assert.equal(verdictLabel('SOMETHING_NEW'), 'something_new');
  assert.equal(verdictLabel(undefined), '');
});

test('investigationRows: a fix record carries its mode and its pull request link', async () => {
  const { investigationRows } = await importCore();
  const [row] = investigationRows({
    investigations: [investigationRecord({ verdict: 'FIXED', mode: 'fix', prUrl: 'https://github.com/o/r/pull/4' })],
  });
  assert.equal(row.mode, 'fix');
  assert.equal(row.prUrl, 'https://github.com/o/r/pull/4');
});

// The url is rendered as an href, so anything that is not plainly https is dropped here rather than
// handed to the DOM.
test('investigationRows: a non-https prUrl is dropped', async () => {
  const { investigationRows } = await importCore();
  for (const prUrl of ['javascript:alert(1)', 'http://insecure/pr/1', 'https://x/1 with space', 42]) {
    const [row] = investigationRows({ investigations: [investigationRecord({ prUrl })] });
    assert.equal(row.prUrl, '', `dropped: ${String(prUrl)}`);
  }
});

test('investigationRows: an unarchived record never moves the attention count', async () => {
  const { investigationRows, radarAttentionCount } = await importCore();
  const posthog = { projects: [], investigations: [investigationRecord()] };
  assert.equal(investigationRows(posthog).length, 1);
  assert.equal(radarAttentionCount({ posthog }), 0, 'the inbox is quiet review material');
});
