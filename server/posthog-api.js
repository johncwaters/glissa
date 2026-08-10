'use strict';

/*
 * PostHog REST client for the monitoring lane. The IO sibling of server/pr-gh.js: it is the only
 * module in the lane that talks to PostHog, and like pr-gh it NEVER throws - every method resolves
 * to { ok, status, body } or { ok: false, error } so a poller tick can degrade instead of dying.
 *
 * v1 is READ-ONLY. Nothing here writes an issue status, assigns, or merges, and the lane's API key
 * therefore only ever needs PostHog READ scopes.
 *
 * TODO (live probe): the issues-query request body and the spike/recommendation endpoints below are
 * modeled on the PostHog MCP tool layer and have NOT been verified against a live instance or the
 * public REST docs. Everything that consumes a response goes through the defensive normalizers at
 * the bottom of this file, so an unexpected shape degrades to zeroes rather than a crash, but the
 * paths themselves need confirming before the lane is trusted unattended.
 */

const DEFAULT_ISSUE_LIMIT = 50;
const DEFAULT_DATE_RANGE_HOURS = 24;

function toCount(value, fallback = 0) {
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  return fallback;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

// Rows can arrive as objects (REST list endpoints) or as a HogQL-style { columns, results } matrix
// where each result is a positional array. Both are flattened to plain objects here so every
// normalizer below only ever sees one shape.
function extractRows(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body.filter((r) => r && typeof r === 'object');
  const results = body.results || body.issues || body.data;
  if (!Array.isArray(results)) return [];
  const columns = Array.isArray(body.columns) ? body.columns : null;
  return results
    .map((row) => {
      if (!Array.isArray(row)) return row;
      if (!columns) return null;
      const obj = {};
      columns.forEach((name, i) => { obj[String(name)] = row[i]; });
      return obj;
    })
    .filter((r) => r && typeof r === 'object');
}

/** Map one raw issue row into the lane's internal shape. Unknown numeric fields default to 0. */
function normalizeIssue(raw) {
  const row = raw && typeof raw === 'object' ? raw : {};
  const agg = (row.aggregations && typeof row.aggregations === 'object') ? row.aggregations : row;
  return {
    issueId: String(firstDefined(row.id, row.issue_id, row.issueId, '') ?? ''),
    title: String(firstDefined(row.name, row.title, row.description, '') ?? ''),
    status: String(firstDefined(row.status, 'active')),
    occurrences: toCount(firstDefined(agg.occurrences, agg.events, agg.count), 0),
    users: toCount(firstDefined(agg.users, agg.unique_users, agg.distinct_users), 0),
    firstSeen: firstDefined(row.first_seen, row.firstSeen, agg.first_seen) ?? null,
    lastSeen: firstDefined(row.last_seen, row.lastSeen, agg.last_seen) ?? null,
  };
}

function normalizeIssues(body) {
  return extractRows(body).map(normalizeIssue).filter((issue) => issue.issueId !== '');
}

/**
 * Issue ids named by spike events NEWER than sinceTs. A row must carry POSITIVE evidence of being
 * fresh: a missing or unparseable timestamp is dropped, not kept. The endpoint shape here is
 * unverified (see the TODO above), and "keep what we cannot date" turned an unexpected shape into a
 * permanent spike for every row, i.e. a Telegram ping plus a fresh Claude investigation every
 * interval forever. Missing one real spike costs a delay; that cost is bounded and this one was not.
 */
function parseSpikeIssueIds(body, sinceTs = 0) {
  const ids = new Set();
  for (const row of extractRows(body)) {
    const props = (row.properties && typeof row.properties === 'object') ? row.properties : {};
    const rawTs = firstDefined(row.timestamp, row.ts, row.created_at, row.time, props.timestamp);
    const ts = Date.parse(String(rawTs ?? ''));
    if (!Number.isFinite(ts)) continue;
    if (ts <= toCount(sinceTs, 0)) continue;
    const id = firstDefined(row.issue_id, row.issueId, props.issue_id, props.issueId, row.id);
    if (id === undefined) continue;
    ids.add(String(id));
  }
  return ids;
}

function createPosthogApi({ host, apiKey, fetchFn } = {}) {
  const base = String(host || '').replace(/\/+$/, '');
  const doFetch = fetchFn || ((url, init) => fetch(url, init));

  async function request(pathname, { method = 'GET', body } = {}) {
    try {
      const res = await doFetch(`${base}${pathname}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
      if (!res.ok) return { ok: false, status: res.status, body: parsed, error: `HTTP ${res.status}` };
      return { ok: true, status: res.status, body: parsed };
    } catch (err) {
      return { ok: false, error: String((err?.message) || err) };
    }
  }

  function listOrganizations() {
    return request('/api/organizations/');
  }

  function listProjects(orgId) {
    return request(`/api/organizations/${encodeURIComponent(orgId)}/projects/`);
  }

  function queryIssues(projectId, { dateRangeHours = DEFAULT_DATE_RANGE_HOURS, limit = DEFAULT_ISSUE_LIMIT } = {}) {
    return request(`/api/projects/${encodeURIComponent(projectId)}/error_tracking/query/issues/`, {
      method: 'POST',
      body: {
        orderBy: 'users',
        status: 'active',
        dateRange: { date_from: `-${toCount(dateRangeHours, DEFAULT_DATE_RANGE_HOURS)}h` },
        limit,
        volumeResolution: 0,
      },
    });
  }

  function listSpikeEvents(projectId) {
    return request(`/api/projects/${encodeURIComponent(projectId)}/error_tracking/spikes/`);
  }

  function listRecommendations(projectId) {
    return request(`/api/projects/${encodeURIComponent(projectId)}/error_tracking/recommendations/`);
  }

  return { host: base, listOrganizations, listProjects, queryIssues, listSpikeEvents, listRecommendations };
}

module.exports = {
  createPosthogApi,
  normalizeIssue,
  normalizeIssues,
  parseSpikeIssueIds,
  extractRows,
};
