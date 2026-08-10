'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createPosthogApi,
  normalizeIssue,
  normalizeIssues,
  parseSpikeIssueIds,
} = require('../server/posthog-api');

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
