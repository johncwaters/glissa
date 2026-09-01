'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createPosthogApi,
  normalizeIssue,
  normalizeIssues,
  parseSpikeIssueIds,
  clampBaselineDays,
  DEFAULT_BASELINE_DAYS,
  MAX_BASELINE_DAYS,
} = require('../server/posthog-api.ts');

// --- normalizeIssue: the shapes the query endpoint is known to return, plus defensive fallbacks ---

test('normalizeIssue maps a plain object row with nested aggregations', () => {
  const issue = normalizeIssue({
    id: 'iss-1',
    name: 'TypeError: boom',
    status: 'active',
    first_seen: '2026-08-01T00:00:00Z',
    last_seen: '2026-08-09T00:00:00Z',
    aggregations: { occurrences: 120, sessions: 40, users: 8 },
  });
  assert.deepEqual(issue, {
    issueId: 'iss-1',
    title: 'TypeError: boom',
    status: 'active',
    occurrences: 120,
    users: 8,
    firstSeen: '2026-08-01T00:00:00Z',
    lastSeen: '2026-08-09T00:00:00Z',
  });
});

test('normalizeIssue accepts issue_id and flat aggregates', () => {
  const issue = normalizeIssue({ issue_id: 'iss-2', title: 'boom', occurrences: 5, users: 2 });
  assert.equal(issue.issueId, 'iss-2');
  assert.equal(issue.title, 'boom');
  assert.equal(issue.occurrences, 5);
  assert.equal(issue.users, 2);
});

test('normalizeIssue defaults unknown numeric fields to 0 and status to active', () => {
  const issue = normalizeIssue({ id: 'iss-3' });
  assert.equal(issue.occurrences, 0);
  assert.equal(issue.users, 0);
  assert.equal(issue.status, 'active');
  assert.equal(issue.firstSeen, null);
});

test('normalizeIssue survives a null row', () => {
  const issue = normalizeIssue(null);
  assert.equal(issue.issueId, '');
  assert.equal(issue.occurrences, 0);
});

test('normalizeIssues reads a { results: [...] } object body', () => {
  const issues = normalizeIssues({ results: [{ id: 'a', users: 1 }, { id: 'b', users: 2 }] });
  assert.deepEqual(issues.map((i) => i.issueId), ['a', 'b']);
});

test('normalizeIssues reads a positional { columns, results } matrix', () => {
  const issues = normalizeIssues({
    columns: ['id', 'name', 'occurrences', 'users'],
    results: [['a', 'boom', 12, 3]],
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].issueId, 'a');
  assert.equal(issues[0].title, 'boom');
  assert.equal(issues[0].occurrences, 12);
  assert.equal(issues[0].users, 3);
});

test('normalizeIssues drops rows with no identifiable issue id', () => {
  assert.deepEqual(normalizeIssues({ results: [{ name: 'nameless' }] }), []);
});

test('normalizeIssues returns [] for an unusable body', () => {
  assert.deepEqual(normalizeIssues(null), []);
  assert.deepEqual(normalizeIssues({ nope: true }), []);
});

// --- parseSpikeIssueIds ---

test('parseSpikeIssueIds keeps only events newer than sinceTs', () => {
  const since = Date.parse('2026-08-09T12:00:00Z');
  const ids = parseSpikeIssueIds({
    results: [
      { issue_id: 'old', timestamp: '2026-08-09T11:00:00Z' },
      { issue_id: 'fresh', timestamp: '2026-08-09T13:00:00Z' },
    ],
  }, since);
  assert.deepEqual([...ids], ['fresh']);
});

test('parseSpikeIssueIds reads the id out of event properties', () => {
  const ids = parseSpikeIssueIds({ results: [{ timestamp: '2026-08-09T13:00:00Z', properties: { issue_id: 'p1' } }] }, 0);
  assert.deepEqual([...ids], ['p1']);
});

// A row must PROVE it is fresh. Keeping undatable rows meant an unexpected endpoint shape spiked
// every issue on every tick: a Telegram ping plus a fresh Claude investigation, every interval,
// forever.
test('parseSpikeIssueIds drops a row with an unparseable timestamp', () => {
  const ids = parseSpikeIssueIds({ results: [{ issue_id: 'x', timestamp: 'not-a-date' }] }, Date.now());
  assert.equal(ids.size, 0);
});

test('parseSpikeIssueIds drops a row carrying no timestamp at all', () => {
  const ids = parseSpikeIssueIds({ results: [{ issue_id: 'x' }] }, 0);
  assert.equal(ids.size, 0);
});

test('parseSpikeIssueIds returns an empty set for an unusable body', () => {
  assert.equal(parseSpikeIssueIds(null, 0).size, 0);
  assert.equal(parseSpikeIssueIds({ results: 'nope' }, 0).size, 0);
});

// --- createPosthogApi: request shape, happy path, error paths (fetchFn injected, no network) ---

function fakeResponse({ ok = true, status = 200, body = {} } = {}) {
  return { ok, status, text: async () => JSON.stringify(body) };
}

test('queryIssues POSTs the documented body with a bearer token', async () => {
  const calls = [];
  const api = createPosthogApi({
    host: 'https://eu.posthog.com/',
    apiKey: 'phx_secret',
    fetchFn: async (url, init) => { calls.push({ url, init }); return fakeResponse({ body: { results: [] } }); },
  });
  const res = await api.queryIssues(42, { dateRangeHours: 6 });

  assert.equal(res.ok, true);
  assert.equal(calls[0].url, 'https://eu.posthog.com/api/projects/42/error_tracking/query/issues/');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer phx_secret');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    orderBy: 'users',
    status: 'active',
    dateRange: { date_from: '-6h' },
    limit: 50,
    volumeResolution: 0,
  });
});

test('a non-2xx response resolves to { ok: false } with the status, never throws', async () => {
  const api = createPosthogApi({
    host: 'https://eu.posthog.com',
    apiKey: 'k',
    fetchFn: async () => fakeResponse({ ok: false, status: 401, body: { detail: 'nope' } }),
  });
  const res = await api.queryIssues(1);
  assert.equal(res.ok, false);
  assert.equal(res.status, 401);
  assert.match(res.error, /401/);
});

test('a thrown transport error resolves to { ok: false, error }, never throws', async () => {
  const api = createPosthogApi({
    host: 'https://eu.posthog.com',
    apiKey: 'k',
    fetchFn: async () => { throw new Error('ECONNREFUSED'); },
  });
  const res = await api.listOrganizations();
  assert.equal(res.ok, false);
  assert.match(res.error, /ECONNREFUSED/);
});

test('an unparseable response body degrades to a null body rather than throwing', async () => {
  const api = createPosthogApi({
    host: 'https://eu.posthog.com',
    apiKey: 'k',
    fetchFn: async () => ({ ok: true, status: 200, text: async () => '<html>gateway</html>' }),
  });
  const res = await api.listSpikeEvents(1);
  assert.equal(res.ok, true);
  assert.equal(res.body, null);
});

test('listProjects builds the organization-scoped path', async () => {
  const calls = [];
  const api = createPosthogApi({
    host: 'https://eu.posthog.com',
    apiKey: 'k',
    fetchFn: async (url) => { calls.push(url); return fakeResponse({ body: { results: [] } }); },
  });
  await api.listProjects('org-1');
  assert.equal(calls[0], 'https://eu.posthog.com/api/organizations/org-1/projects/');
});

// --- updateIssueStatus: the lane's ONE write (Radar's resolve/suppress row actions) ---

test('updateIssueStatus PATCHes the issue endpoint with the status body', async () => {
  const calls = [];
  const api = createPosthogApi({
    host: 'https://eu.posthog.com/',
    apiKey: 'phx_secret',
    fetchFn: async (url, init) => { calls.push({ url, init }); return fakeResponse({ body: { status: 'resolved' } }); },
  });

  const res = await api.updateIssueStatus(42, 'iss-1', 'resolved');

  assert.equal(res.ok, true);
  assert.equal(calls[0].url, 'https://eu.posthog.com/api/projects/42/error_tracking/issues/iss-1/');
  assert.equal(calls[0].init.method, 'PATCH');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer phx_secret');
  assert.deepEqual(JSON.parse(calls[0].init.body), { status: 'resolved' });
});

test('updateIssueStatus url-encodes both ids', async () => {
  const calls = [];
  const api = createPosthogApi({
    host: 'https://eu.posthog.com',
    apiKey: 'k',
    fetchFn: async (url) => { calls.push(url); return fakeResponse({}); },
  });
  await api.updateIssueStatus('a b', 'x/y', 'suppressed');
  assert.equal(calls[0], 'https://eu.posthog.com/api/projects/a%20b/error_tracking/issues/x%2Fy/');
});

test('updateIssueStatus reports an HTTP failure instead of throwing', async () => {
  const api = createPosthogApi({
    host: 'https://eu.posthog.com',
    apiKey: 'k',
    fetchFn: async () => fakeResponse({ ok: false, status: 403, body: { detail: 'no write scope' } }),
  });
  const res = await api.updateIssueStatus(1, 'iss-1', 'resolved');
  assert.equal(res.ok, false);
  assert.equal(res.status, 403);
  assert.equal(res.error, 'HTTP 403');
});

test('updateIssueStatus survives a transport error', async () => {
  const api = createPosthogApi({
    host: 'https://eu.posthog.com',
    apiKey: 'k',
    fetchFn: async () => { throw new Error('ECONNRESET'); },
  });
  const res = await api.updateIssueStatus(1, 'iss-1', 'suppressed');
  assert.equal(res.ok, false);
  assert.match(res.error, /ECONNRESET/);
});

// --- queryTrafficBuckets: the traffic spike lane's two read-only HogQL queries ---

function trafficFetch(calls, bodies) {
  return async (url, init) => {
    calls.push({ url, init });
    return fakeResponse({ body: bodies[calls.length - 1] });
  };
}

test('queryTrafficBuckets POSTs two HogQL queries to the query endpoint with a bearer token', async () => {
  const calls = [];
  const api = createPosthogApi({
    host: 'https://eu.posthog.com/',
    apiKey: 'phx_secret',
    fetchFn: trafficFetch(calls, [
      { columns: ['bucket', 'users'], results: [['2026-08-15T09:00:00Z', 12]] },
      { columns: ['users'], results: [[87]] },
    ]),
  });

  const res = await api.queryTrafficBuckets(42, { baselineDays: 7 });

  assert.equal(res.ok, true);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, 'https://eu.posthog.com/api/projects/42/query/');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.Authorization, 'Bearer phx_secret');
    assert.equal(JSON.parse(call.init.body).query.kind, 'HogQLQuery');
  }
  const baselineSql = JSON.parse(calls[0].init.body).query.query;
  assert.match(baselineSql, /toStartOfHour\(timestamp\) AS bucket/);
  assert.match(baselineSql, /count\(DISTINCT person_id\) AS users/);
  assert.match(baselineSql, /INTERVAL 7 DAY/);
  assert.match(baselineSql, /timestamp < toStartOfHour\(now\(\)\)/, 'the partial current hour is excluded');
  assert.match(JSON.parse(calls[1].init.body).query.query, /INTERVAL 60 MINUTE/);
});

test('queryTrafficBuckets parses the positional HogQL matrix into buckets and a current count', async () => {
  const api = createPosthogApi({
    host: 'https://eu.posthog.com',
    apiKey: 'k',
    fetchFn: trafficFetch([], [
      { columns: ['bucket', 'users'], results: [['h1', 3], ['h2', '9']] },
      { columns: ['users'], results: [[87]] },
    ]),
  });
  const res = await api.queryTrafficBuckets(1, {});
  assert.deepEqual(res.buckets, [{ bucket: 'h1', users: 3 }, { bucket: 'h2', users: 9 }]);
  assert.equal(res.currentUsers, 87);
});

test('queryTrafficBuckets degrades to zero rather than NaN on an unusable body', async () => {
  const api = createPosthogApi({
    host: 'https://eu.posthog.com',
    apiKey: 'k',
    fetchFn: async () => fakeResponse({ body: { nope: true } }),
  });
  const res = await api.queryTrafficBuckets(1, {});
  assert.equal(res.ok, true);
  assert.deepEqual(res.buckets, []);
  assert.equal(res.currentUsers, 0);
});

test('queryTrafficBuckets clamps baselineDays into 1..30 and never interpolates anything else', async () => {
  const cases = [
    [0, 1], [-5, 1], [1, 1], [30, 30], [365, 30], [7.9, 7],
    ['9', 9], [undefined, 7], [null, 7], [Number.NaN, 7],
    ['1 DAY UNION ALL SELECT 1', 7],
  ];
  for (const [input, expected] of cases) {
    const calls = [];
    const api = createPosthogApi({
      host: 'https://eu.posthog.com',
      apiKey: 'k',
      fetchFn: trafficFetch(calls, [{ results: [] }, { results: [] }]),
    });
    await api.queryTrafficBuckets(1, { baselineDays: input });
    const sql = JSON.parse(calls[0].init.body).query.query;
    assert.match(sql, new RegExp(`INTERVAL ${expected} DAY`), `baselineDays ${String(input)}`);
    assert.equal(sql.includes('UNION'), false, 'no caller text reaches the SQL');
  }
});

test('clampBaselineDays is the exported bound the query relies on', () => {
  assert.equal(clampBaselineDays(0), 1);
  assert.equal(clampBaselineDays(31), MAX_BASELINE_DAYS);
  assert.equal(clampBaselineDays('nope'), DEFAULT_BASELINE_DAYS);
});

test('queryTrafficBuckets reports a failed baseline query and never runs the second one', async () => {
  const calls = [];
  const api = createPosthogApi({
    host: 'https://eu.posthog.com',
    apiKey: 'k',
    fetchFn: async (url, init) => { calls.push({ url, init }); return fakeResponse({ ok: false, status: 403 }); },
  });
  const res = await api.queryTrafficBuckets(1, {});
  assert.equal(res.ok, false);
  assert.equal(res.error, 'HTTP 403');
  assert.equal(calls.length, 1);
});

test('queryTrafficBuckets survives a transport error', async () => {
  const api = createPosthogApi({
    host: 'https://eu.posthog.com',
    apiKey: 'k',
    fetchFn: async () => { throw new Error('ECONNREFUSED'); },
  });
  const res = await api.queryTrafficBuckets(1, {});
  assert.equal(res.ok, false);
  assert.match(res.error, /ECONNREFUSED/);
});
