const DEFAULT_ISSUE_LIMIT = 50;
const DEFAULT_DATE_RANGE_HOURS = 24;
const DEFAULT_BASELINE_DAYS = 7;
const MAX_BASELINE_DAYS = 30;
const CURRENT_WINDOW_MINUTES = 60;

type RawRow = Record<string, unknown>;

interface NormalizedIssue {
  issueId: string;
  title: string;
  status: string;
  occurrences: number;
  users: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

type PosthogResponse =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number; body: unknown; error: string }
  | { ok: false; error: string };

interface TrafficBuckets {
  ok: true;
  buckets: { bucket: unknown; users: number }[];
  currentUsers: number;
}

type ProjectId = string | number;

interface PosthogApi {
  host: string;
  listOrganizations(): Promise<PosthogResponse>;
  listProjects(orgId: string): Promise<PosthogResponse>;
  queryIssues(
    projectId: ProjectId,
    options?: { dateRangeHours?: number; limit?: number },
  ): Promise<PosthogResponse>;
  queryTrafficBuckets(
    projectId: ProjectId,
    options?: { baselineDays?: unknown },
  ): Promise<PosthogResponse | TrafficBuckets>;
  listSpikeEvents(projectId: ProjectId): Promise<PosthogResponse>;
  listRecommendations(projectId: ProjectId): Promise<PosthogResponse>;
  updateIssueStatus(projectId: ProjectId, issueId: string, status: string): Promise<PosthogResponse>;
}

function toCount(value: unknown, fallback = 0): number {
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  return fallback;
}

function timestampOrNull(value: unknown): string | null {
  if (typeof value === 'string') return value;
  return value == null ? null : String(value);
}

function firstDefined(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is RawRow {
  return Boolean(value) && typeof value === 'object';
}

function extractRows(body: unknown): RawRow[] {
  if (!body) return [];
  if (Array.isArray(body)) return body.filter(isRecord);
  if (!isRecord(body)) return [];
  const results = body.results || body.issues || body.data;
  if (!Array.isArray(results)) return [];
  const columns = Array.isArray(body.columns) ? body.columns : null;
  return results
    .map((row: unknown) => {
      if (!Array.isArray(row)) return row;
      if (!columns) return null;
      const obj: RawRow = {};
      columns.forEach((name: unknown, i: number) => { obj[String(name)] = row[i]; });
      return obj;
    })
    .filter(isRecord);
}

function normalizeIssue(raw: unknown): NormalizedIssue {
  const row: RawRow = isRecord(raw) ? raw : {};
  const agg: RawRow = isRecord(row.aggregations) ? row.aggregations : row;
  return {
    issueId: String(firstDefined(row.id, row.issue_id, row.issueId, '') ?? ''),
    title: String(firstDefined(row.name, row.title, row.description, '') ?? ''),
    status: String(firstDefined(row.status, 'active')),
    occurrences: toCount(firstDefined(agg.occurrences, agg.events, agg.count), 0),
    users: toCount(firstDefined(agg.users, agg.unique_users, agg.distinct_users), 0),
    firstSeen: timestampOrNull(firstDefined(row.first_seen, row.firstSeen, agg.first_seen)),
    lastSeen: timestampOrNull(firstDefined(row.last_seen, row.lastSeen, agg.last_seen)),
  };
}

function normalizeIssues(body: unknown): NormalizedIssue[] {
  return extractRows(body).map(normalizeIssue).filter((issue) => issue.issueId !== '');
}

function parseSpikeIssueIds(body: unknown, sinceTs: unknown = 0): Set<string> {
  const ids = new Set<string>();
  for (const row of extractRows(body)) {
    const props: RawRow = isRecord(row.properties) ? row.properties : {};
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

function clampBaselineDays(value: unknown): number {
  if (value == null || value === '') return DEFAULT_BASELINE_DAYS;
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_BASELINE_DAYS;
  return Math.min(MAX_BASELINE_DAYS, Math.max(1, n));
}

function createPosthogApi({ host, apiKey, fetchFn }: {
  host?: string;
  apiKey?: string;
  fetchFn?: typeof fetch;
} = {}): PosthogApi {
  const base = String(host || '').replace(/\/+$/, '');
  const doFetch = fetchFn || ((url: string, init: RequestInit) => fetch(url, init));

  async function request(
    pathname: string,
    { method = 'GET', body }: { method?: string; body?: unknown } = {},
  ): Promise<PosthogResponse> {
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
      let parsed: unknown = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
      if (!res.ok) return { ok: false, status: res.status, body: parsed, error: `HTTP ${res.status}` };
      return { ok: true, status: res.status, body: parsed };
    } catch (err) {
      const failure = (err ?? {}) as { message?: unknown };
      return { ok: false, error: String(failure.message || err) };
    }
  }

  function listOrganizations(): Promise<PosthogResponse> {
    return request('/api/organizations/');
  }

  function listProjects(orgId: string): Promise<PosthogResponse> {
    return request(`/api/organizations/${encodeURIComponent(orgId)}/projects/`);
  }

  function queryIssues(
    projectId: ProjectId,
    { dateRangeHours = DEFAULT_DATE_RANGE_HOURS, limit = DEFAULT_ISSUE_LIMIT }: {
      dateRangeHours?: number;
      limit?: number;
    } = {},
  ): Promise<PosthogResponse> {
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

  function runHogQL(projectId: ProjectId, query: string): Promise<PosthogResponse> {
    return request(`/api/projects/${encodeURIComponent(projectId)}/query/`, {
      method: 'POST',
      body: { query: { kind: 'HogQLQuery', query } },
    });
  }

  async function queryTrafficBuckets(
    projectId: ProjectId,
    { baselineDays = DEFAULT_BASELINE_DAYS }: { baselineDays?: unknown } = {},
  ): Promise<PosthogResponse | TrafficBuckets> {
    const days = clampBaselineDays(baselineDays);
    const bucketsRes = await runHogQL(projectId, [
      'SELECT toStartOfHour(timestamp) AS bucket, count(DISTINCT person_id) AS users',
      'FROM events',
      `WHERE timestamp >= now() - INTERVAL ${days} DAY AND timestamp < toStartOfHour(now())`,
      'GROUP BY bucket ORDER BY bucket',
    ].join(' '));
    if (!bucketsRes.ok) return bucketsRes;
    const currentRes = await runHogQL(projectId, [
      'SELECT count(DISTINCT person_id) AS users',
      'FROM events',
      `WHERE timestamp >= now() - INTERVAL ${CURRENT_WINDOW_MINUTES} MINUTE`,
    ].join(' '));
    if (!currentRes.ok) return currentRes;
    return {
      ok: true,
      buckets: extractRows(bucketsRes.body).map((row) => ({
        bucket: firstDefined(row.bucket, row.hour, null) ?? null,
        users: toCount(row.users, 0),
      })),
      currentUsers: toCount(extractRows(currentRes.body)[0]?.users, 0),
    };
  }

  function listSpikeEvents(projectId: ProjectId): Promise<PosthogResponse> {
    return request(`/api/projects/${encodeURIComponent(projectId)}/error_tracking/spikes/`);
  }

  function listRecommendations(projectId: ProjectId): Promise<PosthogResponse> {
    return request(`/api/projects/${encodeURIComponent(projectId)}/error_tracking/recommendations/`);
  }

  function updateIssueStatus(projectId: ProjectId, issueId: string, status: string): Promise<PosthogResponse> {
    const pathname = `/api/projects/${encodeURIComponent(projectId)}/error_tracking/issues/${encodeURIComponent(issueId)}/`;
    return request(pathname, { method: 'PATCH', body: { status } });
  }

  return {
    host: base,
    listOrganizations,
    listProjects,
    queryIssues,
    queryTrafficBuckets,
    listSpikeEvents,
    listRecommendations,
    updateIssueStatus,
  };
}

export {
  DEFAULT_BASELINE_DAYS,
  MAX_BASELINE_DAYS,
  clampBaselineDays,
  createPosthogApi,
  extractRows,
  normalizeIssue,
  normalizeIssues,
  parseSpikeIssueIds,
};
export type { NormalizedIssue, PosthogApi, PosthogResponse, ProjectId, TrafficBuckets };
