import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_STALE_MS,
  applyInvestigationActivity,
  applyInvestigationFinished,
  findIssueInSnapshot,
  formatTrailOffset,
  healthAnomalyRows,
  finishedViewOf,
  investigationViewOf,
  isOpenInvestigationFrame,
  issueSummaryText,
  latestTrailLabel,
  hostsDiffer,
  investigationRows,
  needsActionPrRows,
  opsRows,
  partitionRadarProjects,
  radarAttentionCount,
  radarAttentionSignature,
  radarDisplayName,
  radarPlaceholder,
  retainKnownInvestigationIds,
  severityFor,
  shortHost,
  shortSha,
  sortIssuesByAttention,
  sparklinePoints,
  summarizeIssues,
  trailContentKey,
  trailStatusText,
  trailStepRows,
  updateAvailableRow,
  updateBannerText,
  verdictLabel,
} from '../public/radar-core.ts';

const changesOf = (issues: { change?: string }[]): (string | undefined)[] => issues.map((issue) => issue.change);

test('radarPlaceholder: waits for an initial server status', () => {
  assert.equal(radarPlaceholder(null), 'Waiting for PostHog monitoring status from the server.');
  assert.equal(radarPlaceholder(undefined), 'Waiting for PostHog monitoring status from the server.');
});

test('radarPlaceholder: reports a misconfigured lane with the reason', () => {
  assert.equal(
    radarPlaceholder({ configured: false, reason: 'apiKey missing' }),
    'PostHog monitoring is misconfigured: apiKey missing. Open Settings and its PostHog tab.',
  );
});

test('radarPlaceholder: reports a disabled lane without a reason', () => {
  assert.equal(
    radarPlaceholder({ configured: false, reason: '' }),
    'PostHog monitoring is off. Open Settings and its PostHog tab to switch it on.',
  );
});

test('radarPlaceholder: reports configured or legacy statuses as waiting for first poll', () => {
  assert.equal(radarPlaceholder({ configured: true }), 'PostHog monitoring is on. Waiting for the first poll.');
  assert.equal(radarPlaceholder({}), 'PostHog monitoring is on. Waiting for the first poll.');
});

test('sortIssuesByAttention: orders spiking, regressed, worsened, new, quiet', () => {
  const issues = [
    { issueId: 'a', change: 'quiet' },
    { issueId: 'b', change: 'new' },
    { issueId: 'c', change: 'regressed' },
    { issueId: 'd', change: 'worsened' },
    { issueId: 'e', change: 'spiking' },
  ];
  assert.deepEqual(changesOf(sortIssuesByAttention(issues)), ['spiking', 'regressed', 'worsened', 'new', 'quiet']);
});

test('sortIssuesByAttention: does not mutate the input array', () => {
  const issues = [{ change: 'quiet' }, { change: 'spiking' }];
  const sorted = sortIssuesByAttention(issues);
  assert.deepEqual(changesOf(issues), ['quiet', 'spiking']);
  assert.deepEqual(changesOf(sorted), ['spiking', 'quiet']);
});

test('sortIssuesByAttention: same change ranks by users, then occurrences', () => {
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

test('sortIssuesByAttention: fully tied rows keep the order the backend sent', () => {
  const issues = [
    { issueId: 'first', change: 'new', users: 1, occurrences: 1 },
    { issueId: 'second', change: 'new', users: 1, occurrences: 1 },
    { issueId: 'third', change: 'new', users: 1, occurrences: 1 },
  ];
  assert.deepEqual(sortIssuesByAttention(issues).map((i) => i.issueId), ['first', 'second', 'third']);
});

test('sortIssuesByAttention: an unknown change sorts last rather than jumping the queue', () => {
  const issues = [
    { issueId: 'weird', change: 'sideways' },
    { issueId: 'calm', change: 'quiet' },
    { issueId: 'hot', change: 'spiking' },
  ];
  assert.deepEqual(sortIssuesByAttention(issues).map((i) => i.issueId), ['hot', 'calm', 'weird']);
});

test('sortIssuesByAttention: missing numbers count as zero and never throw', () => {
  const issues = [
    { issueId: 'unknown-counts', change: 'spiking' },
    { issueId: 'counted', change: 'spiking', users: 3, occurrences: 3 },
  ];
  assert.deepEqual(sortIssuesByAttention(issues).map((i) => i.issueId), ['counted', 'unknown-counts']);
});

test('sortIssuesByAttention: a non-array input returns an empty array', () => {
  assert.deepEqual(sortIssuesByAttention(undefined), []);
  assert.deepEqual(sortIssuesByAttention(null), []);
});

test('severityFor: crit for spiking and regressed, warn for worsened and new, dim otherwise', () => {
  assert.equal(severityFor('spiking'), 'crit');
  assert.equal(severityFor('regressed'), 'crit');
  assert.equal(severityFor('worsened'), 'warn');
  assert.equal(severityFor('new'), 'warn');
  assert.equal(severityFor('quiet'), 'dim');
  assert.equal(severityFor('sideways'), 'dim');
  assert.equal(severityFor(undefined), 'dim');
});

test('summarizeIssues: counts active issues, spiking changes and NEEDS_HUMAN verdicts', () => {
  const issues = [
    { issueId: 'a', change: 'spiking', verdict: 'NEEDS_HUMAN' },
    { issueId: 'b', change: 'spiking', verdict: null },
    { issueId: 'c', change: 'quiet', verdict: 'NEEDS_HUMAN' },
    { issueId: 'd', change: 'new', verdict: 'TRANSIENT' },
  ];
  assert.deepEqual(summarizeIssues(issues), { active: 4, spiking: 2, needsHuman: 2 });
});

test('summarizeIssues: a non-array or empty input summarizes to zeroes', () => {
  assert.deepEqual(summarizeIssues([]), { active: 0, spiking: 0, needsHuman: 0 });
  assert.deepEqual(summarizeIssues(undefined), { active: 0, spiking: 0, needsHuman: 0 });
  assert.deepEqual(summarizeIssues(null), { active: 0, spiking: 0, needsHuman: 0 });
});

test('summarizeIssues: malformed entries never throw', () => {
  assert.deepEqual(summarizeIssues([null, undefined, {}]), { active: 3, spiking: 0, needsHuman: 0 });
});

const NOW = 1_700_000_000_000;
const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const quietProject = (over = {}) => ({ projectId: 1, name: 'web', host: 'https://ph.test', lastTickAt: NOW, issues: [], ...over });
const namesOf = (entries: { project: { projectId?: unknown } }[]): unknown[] => entries.map((entry) => entry.project.projectId);

test('partitionRadarProjects: a healthy project is quiet, any active issue makes it loud', () => {
  const projects = [
    quietProject({ projectId: 1 }),
    quietProject({ projectId: 2, issues: [{ issueId: 'a', change: 'quiet' }] }),
  ];
  const { loud, quiet } = partitionRadarProjects(projects, NOW, { intervalMs: FIFTEEN_MIN_MS });
  assert.deepEqual(namesOf(quiet), [1]);
  assert.deepEqual(namesOf(loud), [2]);
});

test('partitionRadarProjects: a spiking issue is loud on its own', () => {
  const projects = [quietProject({ issues: [{ issueId: 'a', change: 'spiking' }] })];
  const { loud, quiet } = partitionRadarProjects(projects, NOW, { intervalMs: FIFTEEN_MIN_MS });
  assert.equal(quiet.length, 0);
  assert.equal(loud[0].counts.spiking, 1);
});

test('partitionRadarProjects: a poll error is loud with zero issues, and carries the reason', () => {
  const projects = [quietProject({ error: 'HTTP 401' })];
  const { loud } = partitionRadarProjects(projects, NOW, { intervalMs: FIFTEEN_MIN_MS });
  assert.equal(loud.length, 1);
  assert.equal(loud[0].error, 'HTTP 401');
  assert.equal(loud[0].counts.active, 0);
});

test('partitionRadarProjects: staleness is two poll intervals, exclusive at the edge', () => {
  const opts = { intervalMs: FIFTEEN_MIN_MS };
  const atEdge = [quietProject({ lastTickAt: NOW - 2 * FIFTEEN_MIN_MS })];
  assert.equal(partitionRadarProjects(atEdge, NOW, opts).quiet.length, 1, 'exactly two intervals is not yet stale');
  const past = [quietProject({ lastTickAt: NOW - 2 * FIFTEEN_MIN_MS - 1 })];
  const { loud } = partitionRadarProjects(past, NOW, opts);
  assert.equal(loud.length, 1);
  assert.equal(loud[0].staleMs, 2 * FIFTEEN_MIN_MS + 1);
});

test('partitionRadarProjects: an unknown interval falls back to the five minute default', () => {
  assert.equal(DEFAULT_STALE_MS, 5 * 60 * 1000);
  const projects = [quietProject({ lastTickAt: NOW - DEFAULT_STALE_MS - 1 })];
  assert.equal(partitionRadarProjects(projects, NOW, {}).loud.length, 1);
  assert.equal(partitionRadarProjects([quietProject({ lastTickAt: NOW - DEFAULT_STALE_MS })], NOW, {}).quiet.length, 1);
});

test('partitionRadarProjects: a project that never polled is not called stale, only errored', () => {
  assert.equal(partitionRadarProjects([quietProject({ lastTickAt: 0 })], NOW, {}).quiet.length, 1);
  assert.equal(partitionRadarProjects([quietProject({ lastTickAt: 0, error: 'no response' })], NOW, {}).loud.length, 1);
});

test('partitionRadarProjects: a malformed or absent list never throws', () => {
  assert.deepEqual(partitionRadarProjects(undefined, NOW, {}), { loud: [], quiet: [] });
  const { quiet } = partitionRadarProjects([{}], NOW, {});
  assert.equal(quiet.length, 1);
});

test('radarDisplayName: a mapped path shows its last segment, a plain name shows itself', () => {
  assert.equal(radarDisplayName({ name: '/home/jwaters/Projects/claude-setup' }), 'claude-setup');
  assert.equal(radarDisplayName({ name: 'C:\\code\\web-app\\' }), 'web-app');
  assert.equal(radarDisplayName({ name: 'Marketing site' }), 'Marketing site');
});

test('radarDisplayName: falls back to the raw project id when there is no name', () => {
  assert.equal(radarDisplayName({ projectId: 7 }), '7');
  assert.equal(radarDisplayName({ projectId: 7, name: '   ' }), '7');
  assert.equal(radarDisplayName({ projectId: 7, name: '/' }), '7');
  assert.equal(radarDisplayName({}), 'project');
});

test('shortHost: keeps the hostname only', () => {
  assert.equal(shortHost('https://us.posthog.com'), 'us.posthog.com');
  assert.equal(shortHost('http://ph.local:8000/some/path'), 'ph.local');
  assert.equal(shortHost('eu.posthog.com'), 'eu.posthog.com');
  assert.equal(shortHost(''), '');
  assert.equal(shortHost(undefined), '');
});

test('hostsDiffer: only a second distinct host earns the label', () => {
  const same = [quietProject({ projectId: 1 }), quietProject({ projectId: 2 })];
  assert.equal(hostsDiffer(same), false);
  assert.equal(hostsDiffer([quietProject({ projectId: 1, host: '' })]), false);
  const mixed = [quietProject({ projectId: 1 }), quietProject({ projectId: 2, host: 'https://eu.posthog.com' })];
  assert.equal(hostsDiffer(mixed), true);
  assert.equal(hostsDiffer(undefined), false);
});

test('sparklinePoints: normalizes values into the requested box', () => {
  assert.equal(sparklinePoints([0, 10, 5], 100, 10), '0,10 50,0 100,5');
});

test('sparklinePoints: renders flat lines through the vertical midpoint', () => {
  assert.equal(sparklinePoints([7, 7, 7], 10, 10), '0,5 5,5 10,5');
});

test('sparklinePoints: requires at least two finite values', () => {
  assert.equal(sparklinePoints([3], 64, 16), '');
  assert.equal(sparklinePoints([], 64, 16), '');
  assert.equal(sparklinePoints(undefined, 64, 16), '');
  assert.equal(sparklinePoints(['nope', null], 64, 16), '');
});

test('sparklinePoints: two points span the full width', () => {
  assert.equal(sparklinePoints([1, 3], 64, 16), '0,16 64,0');
});

test('healthAnomalyRows: only live anomalies produce rows', () => {
  const snapshot = { anomalies: { listenerMismatch: true, orphanPty: false, destroyedReachable: true } };
  assert.deepEqual(healthAnomalyRows(snapshot).map((r) => r.key), ['listenerMismatch', 'destroyedReachable']);
});

test('healthAnomalyRows: an all-zero or absent snapshot renders nothing', () => {
  assert.deepEqual(healthAnomalyRows({ anomalies: { listenerMismatch: false, orphanPty: false, destroyedReachable: false } }), []);
  assert.deepEqual(healthAnomalyRows({}), []);
  assert.deepEqual(healthAnomalyRows(null), []);
  assert.deepEqual(healthAnomalyRows(undefined), []);
});

test('healthAnomalyRows: labels match the health monitor wording', () => {
  const rows = healthAnomalyRows({ anomalies: { orphanPty: true } });
  assert.deepEqual(rows, [{ key: 'orphanPty', label: 'Orphan PTY: session has live PTY but state is DONE/FAILED/DORMANT' }]);
});

test('updateAvailableRow: needs both versions, carries the command', () => {
  assert.deepEqual(
    updateAvailableRow({ updateAvailable: true, current: '1.2.0', latest: '1.3.0', command: 'npm i -g glissa' }),
    { text: 'Update available: 1.2.0 -> 1.3.0', command: 'npm i -g glissa' },
  );
  assert.equal(updateAvailableRow({ updateAvailable: true, current: '1.2.0' }), null);
  assert.equal(updateAvailableRow({ updateAvailable: true, latest: '1.3.0' }), null);
  assert.equal(updateAvailableRow(null), null);
});

test('updateAvailableRow: an up-to-date status renders no row', () => {
  assert.equal(updateAvailableRow({ updateAvailable: false, current: '1.2.0', latest: '1.2.0', command: 'c' }), null);
  assert.equal(updateAvailableRow({ current: '1.2.0', latest: '1.3.0', command: 'c' }), null);
});

test('updateAvailableRow: ignores shas and renders the version pair', () => {
  assert.deepEqual(
    updateAvailableRow({
      updateAvailable: true,
      current: '1.2.0',
      latest: '1.3.0',
      currentSha: '0123456789abcdef0123456789abcdef01234567',
      latestSha: 'FEDCBA9876543210fedcba9876543210fedcba98',
      command: 'npm i -g glissa',
    }),
    { text: 'Update available: 1.2.0 -> 1.3.0', command: 'npm i -g glissa' },
  );
  const versionFallback = updateAvailableRow({ updateAvailable: true, current: '1.2.0', latest: '1.3.0', currentSha: 'not-a-sha', command: 'c' });
  assert.equal(versionFallback?.text, 'Update available: 1.2.0 -> 1.3.0');
});

test('updateBannerText: renders only the version pair', () => {
  const shas = {
    currentSha: '0123456789abcdef0123456789abcdef01234567',
    latestSha: 'fedcba9876543210fedcba9876543210fedcba98',
  };
  assert.equal(updateBannerText({ ...shas, current: '1.2.0', latest: '1.2.0' }), 'Update available: 1.2.0 -> 1.2.0');
  assert.equal(updateBannerText({ ...shas, current: '1.2.0', latest: '1.3.0' }), 'Update available: 1.2.0 -> 1.3.0');
  assert.equal(updateBannerText({ current: '1.2.0', latest: '1.3.0' }), 'Update available: 1.2.0 -> 1.3.0');
});

test('a main-channel status without versions labels both sides with short shas', () => {
  const mainChannelStatus = {
    updateAvailable: true,
    channel: 'main',
    current: '0.24.2',
    latest: null,
    currentSha: '0123456789abcdef0123456789abcdef01234567',
    latestSha: 'FEDCBA9876543210fedcba9876543210fedcba98',
    command: 'git pull',
  };
  assert.deepEqual(
    updateAvailableRow(mainChannelStatus),
    { text: 'Update available: 0.24.2 -> fedcba9', command: 'git pull' },
  );
  assert.equal(updateBannerText(mainChannelStatus), 'Update available: 0.24.2 -> fedcba9');
  const withoutVersions = { ...mainChannelStatus, current: null };
  assert.equal(updateBannerText(withoutVersions), 'Update available: 0123456 -> fedcba9');
  assert.deepEqual(opsRows({ update: mainChannelStatus }), [
    { kind: 'update', key: 'update', text: 'Update available: 0.24.2 -> fedcba9', detail: 'git pull', tone: 'dim' },
  ]);
});

test('shortSha: 7 lowercase chars for a hex sha, empty string otherwise', () => {
  assert.equal(shortSha('0123456789ABCDEF0123456789abcdef01234567'), '0123456');
  assert.equal(shortSha('0123abc'), '0123abc');
  assert.equal(shortSha('main'), '');
  assert.equal(shortSha(null), '');
});

test('opsRows: the update line leads, then one row per live anomaly', () => {
  const rows = opsRows({
    update: { updateAvailable: true, current: '1.0.0', latest: '1.1.0', command: 'npm i' },
    health: { anomalies: { orphanPty: true, destroyedReachable: true } },
  });
  assert.deepEqual(rows.map((r) => r.kind), ['update', 'anomaly', 'anomaly']);
  assert.deepEqual(rows.map((r) => r.key), ['update', 'orphanPty', 'destroyedReachable']);
  assert.equal(rows[0].tone, 'dim');
  assert.equal(rows[1].tone, 'warn');
});

test('opsRows: nothing to say renders no rows at all', () => {
  assert.deepEqual(opsRows({}), []);
  assert.deepEqual(opsRows(), []);
  assert.deepEqual(opsRows({ health: { anomalies: { orphanPty: false } } }), []);
});

test('needsActionPrRows: keeps only attention-worthy PRs, flattened across projects', () => {
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

test('needsActionPrRows: rows within a project keep the PR attention order', () => {
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

test('needsActionPrRows: an empty, absent or healthy feed yields no rows', () => {
  assert.deepEqual(needsActionPrRows(undefined), []);
  assert.deepEqual(needsActionPrRows({ projects: [] }), []);
  assert.deepEqual(needsActionPrRows({ projects: [{ projectId: 'p', prs: [{ number: 1, phase: 'merged' }] }] }), []);
});

test('needsActionPrRows: malformed entries fall back rather than throwing', () => {
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

const posthogWith = (issues: { change?: string; verdict?: string }[]) => ({ projects: [{ projectId: 'ph', issues }] });

test('radarAttentionCount: PostHog spiking and needsHuman issues still count', () => {
  const posthog = posthogWith([
    { change: 'spiking', verdict: 'NEEDS_HUMAN' },
    { change: 'quiet', verdict: 'TRANSIENT' },
  ]);
  assert.equal(radarAttentionCount({ posthog }), 2);
});

test('radarAttentionCount: each live anomaly counts once', () => {
  assert.equal(radarAttentionCount({ health: { anomalies: { orphanPty: true, listenerMismatch: true } } }), 2);
  assert.equal(radarAttentionCount({ health: { anomalies: { orphanPty: false } } }), 0);
});

test('radarAttentionCount: the two sources sum', () => {
  const total = radarAttentionCount({
    posthog: posthogWith([{ change: 'spiking' }, { change: 'quiet', verdict: 'NEEDS_HUMAN' }]),
    health: { anomalies: { destroyedReachable: true } },
  });
  assert.equal(total, 3);
});

test('radarAttentionCount: every feed absent is zero, never a throw', () => {
  assert.equal(radarAttentionCount(), 0);
  assert.equal(radarAttentionCount({}), 0);
  assert.equal(radarAttentionCount({ posthog: null, health: null }), 0);
});

test('radarAttentionSignature: names each attention issue by project, id and why', () => {
  const posthog = { projects: [{ projectId: 'ph', issues: [
    { issueId: 'i1', change: 'spiking' },
    { issueId: 'i2', verdict: 'NEEDS_HUMAN' },
    { issueId: 'i3', change: 'quiet' },
  ] }] };
  assert.equal(radarAttentionSignature({ posthog }), 'issue:ph/i1:spiking|issue:ph/i2:needs-human');
});

test('radarAttentionSignature: one issue that is both spiking and needs-human names both facts', () => {
  const posthog = { projects: [{ projectId: 'ph', issues: [{ issueId: 'i1', change: 'spiking', verdict: 'NEEDS_HUMAN' }] }] };
  assert.equal(radarAttentionSignature({ posthog }), 'issue:ph/i1:needs-human|issue:ph/i1:spiking');
});

test('radarAttentionSignature: live anomalies are named by key, quiet ones are absent', () => {
  assert.equal(radarAttentionSignature({ health: { anomalies: { orphanPty: true, destroyedReachable: false } } }), 'health:orphanPty');
  assert.equal(radarAttentionSignature({ health: { anomalies: { orphanPty: false } } }), '');
});

test('radarAttentionSignature: feed order never changes it', () => {
  const posthog = { projects: [{ projectId: 'ph', issues: [{ issueId: 'i1', change: 'spiking' }] }] };
  assert.equal(
    radarAttentionSignature({ posthog, health: { anomalies: { orphanPty: true } } }),
    radarAttentionSignature({ health: { anomalies: { orphanPty: true } }, posthog }),
  );
});

test('radarAttentionSignature: quiet or absent feeds are the empty signature, never a throw', () => {
  assert.equal(radarAttentionSignature(), '');
  assert.equal(radarAttentionSignature({ posthog: null, health: null }), '');
  assert.equal(radarAttentionSignature({ posthog: posthogWith([{ change: 'quiet' }]) }), '');
});

test('radarAttentionSignature: an issue with no id still counts, keyed by title then position', () => {
  const posthog = { projects: [{ projectId: 'ph', issues: [
    { title: 'Cannot read length', change: 'spiking' },
    { change: 'spiking' },
  ] }] };
  assert.equal(radarAttentionCount({ posthog }), 2);
  assert.equal(radarAttentionSignature({ posthog }), 'issue:ph/#1:spiking|issue:ph/Cannot read length:spiking');
});

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

test('investigationRows: absent field renders nothing (older server payload)', () => {
  assert.deepEqual(investigationRows({ type: 'posthog-status', projects: [] }), []);
  assert.deepEqual(investigationRows(null), []);
  assert.deepEqual(investigationRows({ investigations: ['nope'] }), []);
});

test('investigationRows: drops archived records and orders newest first', () => {
  const rows = investigationRows({
    investigations: [
      investigationRecord({ id: 'a@100', at: 100 }),
      investigationRecord({ id: 'c@300', at: 300 }),
      investigationRecord({ id: 'b@200', at: 200, archived: true }),
    ],
  });
  assert.deepEqual(rows.map((row) => row.id), ['c@300', 'a@100']);
});

test('investigationRows: a locally archived id stays gone even when the payload still carries it', () => {
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

test('retainKnownInvestigationIds: forgets an id the payload no longer carries', () => {
  const ids = new Set(['a@100', 'b@200']);
  retainKnownInvestigationIds({ investigations: [investigationRecord({ id: 'a@100' })] }, ids);
  assert.deepEqual([...ids], ['a@100'], 'the server confirmed b, so the local guard drops it');

  retainKnownInvestigationIds({ investigations: [] }, ids);
  assert.deepEqual([...ids], [], 'the set can never grow for the life of the page');
  assert.doesNotThrow(() => retainKnownInvestigationIds(null, ids));
  assert.doesNotThrow(() => retainKnownInvestigationIds({ investigations: ['nope'] }, new Set(['x'])));
});

test('retainKnownInvestigationIds: an archived-but-still-sent record keeps its guard', () => {
  const ids = new Set(['a@100']);
  retainKnownInvestigationIds({ investigations: [investigationRecord({ id: 'a@100', archived: true })] }, ids);
  assert.deepEqual([...ids], ['a@100'], 'still on the wire, so the guard is still load-bearing');
});

test('investigationRows: normalizes one record into a renderable row', () => {
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

test('investigationRows: survives a partial record and skips one with no id', () => {
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

test('verdictLabel: every verdict has wording, including the auto-fix one', () => {
  assert.equal(verdictLabel('ROOT_CAUSE'), 'root cause');
  assert.equal(verdictLabel('NEEDS_HUMAN'), 'needs you');
  assert.equal(verdictLabel('TRANSIENT'), 'transient');
  assert.equal(verdictLabel('FIXED'), 'fixed');
  assert.equal(verdictLabel('ERROR'), 'error');
});

test('verdictLabel: an unknown verdict falls back to its own lowercased text', () => {
  assert.equal(verdictLabel('SOMETHING_NEW'), 'something_new');
  assert.equal(verdictLabel(undefined), '');
});

test('investigationRows: a fix record carries its mode and its pull request link', () => {
  const [row] = investigationRows({
    investigations: [investigationRecord({ verdict: 'FIXED', mode: 'fix', prUrl: 'https://github.com/o/r/pull/4' })],
  });
  assert.equal(row.mode, 'fix');
  assert.equal(row.prUrl, 'https://github.com/o/r/pull/4');
});

test('investigationRows: a non-https prUrl is dropped', () => {
  for (const prUrl of ['javascript:alert(1)', 'http://insecure/pr/1', 'https://x/1 with space', 42]) {
    const [row] = investigationRows({ investigations: [investigationRecord({ prUrl })] });
    assert.equal(row.prUrl, '', `dropped: ${String(prUrl)}`);
  }
});

test('investigationRows: an unarchived record never moves the attention count', () => {
  const posthog = { projects: [], investigations: [investigationRecord()] };
  assert.equal(investigationRows(posthog).length, 1);
  assert.equal(radarAttentionCount({ posthog }), 0, 'the inbox is quiet review material');
});

test('trailStepRows keeps only steps that name a tool and coerces the rest', () => {
  assert.deepEqual(trailStepRows([
    { at: 10, tool: 'Read', detail: 'a.ts' },
    { at: 'x', tool: 'Bash' },
    { at: 12, tool: '', detail: 'dropped' },
    null,
  ]), [
    { at: 10, tool: 'Read', detail: 'a.ts' },
    { at: 0, tool: 'Bash', detail: '' },
  ]);
  assert.deepEqual(trailStepRows(undefined), []);
});

test('latestTrailLabel names the newest step, tool first, and is empty without a trail', () => {
  assert.equal(latestTrailLabel({ trail: [{ at: 1, tool: 'Grep', detail: 'TypeError' }, { at: 2, tool: 'Read', detail: 'a.ts' }] }), 'Read a.ts');
  assert.equal(latestTrailLabel({ trail: [{ at: 1, tool: 'Task', detail: '' }] }), 'Task');
  assert.equal(latestTrailLabel({}), '');
});

test('applyInvestigationActivity patches the matching issue in place and reports whether anything matched', () => {
  const snapshot = { projects: [
    { projectId: 7, issues: [{ issueId: 'a', inFlight: true }, { issueId: 'b', inFlight: false, verdict: 'ROOT_CAUSE' }] },
    { projectId: 8, issues: [{ issueId: 'a', inFlight: false }] },
  ] };
  assert.equal(applyInvestigationActivity(snapshot, { projectId: '7', issueId: 'a', inFlight: true, startedAt: 500, trail: [{ at: 600, tool: 'Read', detail: 'x' }] }), true);
  assert.deepEqual(snapshot.projects[0].issues[0], { issueId: 'a', inFlight: true, startedAt: 500, trail: [{ at: 600, tool: 'Read', detail: 'x' }] });
  assert.deepEqual(snapshot.projects[1].issues[0], { issueId: 'a', inFlight: false }, 'the same issue id under another project is untouched');
  assert.equal(applyInvestigationActivity(snapshot, { projectId: 9, issueId: 'a', inFlight: true }), false);
  assert.equal(applyInvestigationActivity(null, { projectId: 7, issueId: 'a', inFlight: true }), false);
});

test('a finished frame flips the issue to its verdict and keeps the trail the frame carried', () => {
  const issue = { issueId: 'a', inFlight: true, startedAt: 500, trail: [{ at: 600, tool: 'Read', detail: 'x' }] };
  const snapshot = { projects: [{ projectId: 7, issues: [issue] }] };
  const trail = [{ at: 600, tool: 'Read', detail: 'x' }, { at: 700, tool: 'Bash', detail: 'npm test' }];
  assert.equal(applyInvestigationFinished(snapshot, { projectId: 7, issueId: 'a', startedAt: 500, trail, verdict: 'NEEDS_HUMAN', summaryLine: 'race in retry' }), true);
  assert.deepEqual(issue, { issueId: 'a', inFlight: false, startedAt: 500, trail, verdict: 'NEEDS_HUMAN', summaryLine: 'race in retry' });
  assert.equal(applyInvestigationFinished(snapshot, { projectId: 9, issueId: 'a', verdict: 'ERROR' }), false);
});

test('a finished frame without a summary clears the previous run summary instead of pairing it with the new verdict', () => {
  const issue = { issueId: 'a', inFlight: true, startedAt: 500, verdict: 'NEEDS_HUMAN', summaryLine: 'race in retry' };
  const snapshot = { projects: [{ projectId: 7, issues: [issue] }] };
  assert.equal(applyInvestigationFinished(snapshot, { projectId: 7, issueId: 'a', startedAt: 900, trail: [], verdict: 'TRANSIENT', summaryLine: null }), true);
  assert.deepEqual(issue, { issueId: 'a', inFlight: false, startedAt: 900, trail: [], verdict: 'TRANSIENT', summaryLine: '' });
});

test('a finished frame without a verdict clears the previous one, since the frame is the whole truth of the run', () => {
  const issue = { issueId: 'a', inFlight: true, startedAt: 500, verdict: 'ROOT_CAUSE', summaryLine: 'race in retry' };
  const snapshot = { projects: [{ projectId: 7, issues: [issue] }] };
  assert.equal(applyInvestigationFinished(snapshot, { projectId: 7, issueId: 'a', startedAt: 900, trail: [] }), true);
  assert.deepEqual(issue, { issueId: 'a', inFlight: false, startedAt: 900, trail: [], verdict: '', summaryLine: '' });
});

test('formatTrailOffset counts from the start in +m:ss and is empty without a start', () => {
  assert.equal(formatTrailOffset(1000, 1000), '+0:00');
  assert.equal(formatTrailOffset(1000, 6000), '+0:05');
  assert.equal(formatTrailOffset(1000, 61000), '+1:00');
  assert.equal(formatTrailOffset(1000, 130000), '+2:09');
  assert.equal(formatTrailOffset(1000, 725000), '+12:04');
  assert.equal(formatTrailOffset(1000, 500), '+0:00', 'a step stamped before the start never reads negative');
  assert.equal(formatTrailOffset(null, 6000), '');
});

test('trailContentKey changes when the last step changes and holds steady otherwise', () => {
  const view = { inFlight: true, startedAt: 500, steps: [{ at: 600, tool: 'Read', detail: 'a.ts' }], verdict: '', summaryLine: '' };
  const same = { ...view, steps: [{ at: 600, tool: 'Read', detail: 'b.ts' }] };
  const appended = { ...view, steps: [{ at: 600, tool: 'Read', detail: 'a.ts' }, { at: 700, tool: 'Bash', detail: 'npm test' }] };
  const retooled = { ...view, steps: [{ at: 600, tool: 'Grep', detail: 'a.ts' }] };
  assert.equal(trailContentKey(view), trailContentKey(same), 'only the count, stamp and tool of the last step address the rendered list');
  assert.notEqual(trailContentKey(view), trailContentKey(appended));
  assert.notEqual(trailContentKey(view), trailContentKey(retooled));
  assert.equal(trailContentKey({ ...view, steps: [] }), '0::0::');
});

test('trailStatusText counts steps in the singular while running and names the verdict once finished', () => {
  const running = { inFlight: true, startedAt: 500, steps: [{ at: 600, tool: 'Read', detail: 'a.ts' }], verdict: '', summaryLine: '' };
  assert.equal(trailStatusText(running, '2m ago'), 'investigating, started 2m ago, 1 step');
  assert.equal(trailStatusText({ ...running, steps: [...running.steps, { at: 700, tool: 'Bash', detail: 'npm test' }] }, '2m ago'), 'investigating, started 2m ago, 2 steps');
  assert.equal(trailStatusText({ ...running, startedAt: null, steps: [] }, 'never'), 'investigating, starting, 0 steps');
  assert.equal(trailStatusText({ ...running, inFlight: false, verdict: 'NEEDS_HUMAN' }, '2m ago'), 'finished: needs you');
  assert.equal(trailStatusText({ ...running, inFlight: false }, '2m ago'), 'finished');
});

test('findIssueInSnapshot walks project then issue and refuses a partial address', () => {
  const wanted = { issueId: 'a', inFlight: true };
  const snapshot = { projects: [
    { projectId: 7, issues: [{ issueId: 'b' }, wanted] },
    { projectId: 8, issues: [{ issueId: 'a' }] },
  ] };
  assert.equal(findIssueInSnapshot(snapshot, '7', 'a'), wanted);
  assert.equal(findIssueInSnapshot(snapshot, 7, 'a'), wanted);
  assert.equal(findIssueInSnapshot(snapshot, 7, 'zz'), null);
  assert.equal(findIssueInSnapshot(snapshot, 7, ''), null);
  assert.equal(findIssueInSnapshot(null, 7, 'a'), null);
});

test('issueSummaryText prefers the running trail label and falls back to the summary line', () => {
  const trail = [{ at: 1, tool: 'Read', detail: 'a.ts' }];
  assert.equal(issueSummaryText({ inFlight: true, trail, summaryLine: 'old verdict' }), 'Read a.ts');
  assert.equal(issueSummaryText({ inFlight: true, trail: [], summaryLine: 'old verdict' }), 'old verdict');
  assert.equal(issueSummaryText({ inFlight: false, trail, summaryLine: 'race in retry' }), 'race in retry');
  assert.equal(issueSummaryText(null), '');
});

test('investigationViewOf reads the dialog view off the issue and coerces every field', () => {
  assert.deepEqual(investigationViewOf({ inFlight: true, startedAt: 500, trail: [{ at: 600, tool: 'Read', detail: 'a.ts' }], verdict: 'NEEDS_HUMAN', summaryLine: '  race  ' }), {
    inFlight: true,
    startedAt: 500,
    steps: [{ at: 600, tool: 'Read', detail: 'a.ts' }],
    verdict: 'NEEDS_HUMAN',
    summaryLine: 'race',
  });
  assert.deepEqual(investigationViewOf(undefined), { inFlight: false, startedAt: null, steps: [], verdict: '', summaryLine: '' });
});

test('finishedViewOf builds the dialog view from a finished frame alone, so a vanished issue still closes out', () => {
  assert.deepEqual(finishedViewOf({ startedAt: 500, trail: [{ at: 600, tool: 'Read', detail: 'a.ts' }], verdict: 'ROOT_CAUSE', summaryLine: ' hydration race ' }), {
    inFlight: false,
    startedAt: 500,
    steps: [{ at: 600, tool: 'Read', detail: 'a.ts' }],
    verdict: 'ROOT_CAUSE',
    summaryLine: 'hydration race',
  });
  assert.deepEqual(finishedViewOf(null), { inFlight: false, startedAt: null, steps: [], verdict: '', summaryLine: '' });
});

test('isOpenInvestigationFrame matches a frame to the open dialog by project and issue id, coercing numbers', () => {
  const open = { projectId: '7', issueId: 'iss-1' };
  assert.equal(isOpenInvestigationFrame(open, { projectId: 7, issueId: 'iss-1' }), true);
  assert.equal(isOpenInvestigationFrame(open, { projectId: 8, issueId: 'iss-1' }), false);
  assert.equal(isOpenInvestigationFrame(open, { projectId: 7, issueId: 'iss-2' }), false);
  assert.equal(isOpenInvestigationFrame(null, { projectId: 7, issueId: 'iss-1' }), false);
});
