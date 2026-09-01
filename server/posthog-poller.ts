import * as core from './core/posthog-core.ts';
import type { InvestigationRecord, PosthogIssue, PosthogIssueChange, PosthogStateEntry } from './core/posthog-core.ts';
import * as recurrence from './core/posthog-recurrence.ts';
import type { RecurrenceDecision } from './core/posthog-recurrence.ts';
import * as traffic from './core/traffic-spike-core.ts';
import type { TrafficState } from './core/traffic-spike-core.ts';
import { firstLine, raceWithAbort } from './ephemeral-session.ts';
import { createTickLoop } from './lane-runner.ts';
import type { TickOutcome } from './lane-runner.ts';
import { normalizeIssues, parseSpikeIssueIds } from './posthog-api.ts';
import type { PosthogApi } from './posthog-api.ts';


const OBSERVATION_PINGS: Record<string, { kind: string; dedupe: boolean } | undefined> = {
  spiking: { kind: 'spike', dedupe: true },
  regressed: { kind: 'regression', dedupe: false },
};

const VERDICT_PING_KIND: Record<string, string | undefined> = {
  NEEDS_HUMAN: 'needs_human',
  ERROR: 'error',
  FIXED: 'fixed',
};

const FIX_PING_KIND = 'fixed';

const TRAFFIC_PING_KIND: Record<string, string | undefined> = {
  ping: 'traffic_spike',
  escalate: 'traffic_spike_growth',
};

const META_KEY = '_meta';

type PosthogState = Record<string, unknown>;

interface PosthogMeta {
  lastTickAt: Record<string, number>;
}

type IssueChange = PosthogIssueChange & {
  [key: string]: unknown;
  issue: PosthogIssue;
  projectId: string | number;
  projectName: string;
  url: string;
};

interface JobResult {
  verdict?: unknown;
  summary?: unknown;
  mode?: unknown;
  reproduced?: unknown;
  prUrl?: unknown;
}

interface SpawnInvestigationArgs {
  key: string;
  issue: PosthogIssue;
  projectId: string | number;
  projectName: string;
  host: string;
  url: string;
  mode: string;
  timeoutMs: number;
  signal?: AbortSignal | null;
}

interface PollerProject {
  projectId: string | number;
  name?: string;
}

interface PosthogPollerDependencies {
  api: PosthogApi;
  host?: string;
  resolveProjects?: () => Promise<PollerProject[]>;
  spawnInvestigation: (args: SpawnInvestigationArgs) => Promise<JobResult | null | undefined>;
  telegram?: (message: string) => void;
  readState?: () => Promise<PosthogState>;
  writeState?: (state: PosthogState) => Promise<void>;
  setIntervalFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn?: (handle: NodeJS.Timeout) => void;
  setTimeoutFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutFn?: (handle: NodeJS.Timeout) => void;
  log?: Pick<Console, 'warn'>;
  onTickComplete?: (status: Record<string, unknown>) => void;
  now?: () => number;
  intervalMinutes?: number;
  maxConcurrentInvestigations?: number;
  investigationTimeoutSeconds?: number;
  autoFix?: boolean;
  fixTimeoutSeconds?: number;
  minUsersToInvestigate?: number;
  userEscalationThreshold?: number;
  dateRangeHours?: number;
  entryRetentionDays?: number;
  archivedRetentionDays?: number;
  recurrenceDedupe?: boolean;
  recurrenceWindowDays?: number;
  transientRecurrenceLimit?: number;
  trafficSpikeEnabled?: boolean;
  trafficSpikeMultiplier?: number;
  trafficSpikeMinUsers?: number;
  trafficSpikeCooldownMinutes?: number;
  trafficSpikeBaselineDays?: number;
}

interface PosthogPoller {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  tick: () => Promise<void>;
  archiveInvestigation: (id?: string) => Promise<{ ok: boolean; error?: string; investigations?: InvestigationRecord[] }>;
  investigations: () => InvestigationRecord[];
  _state: () => PosthogState;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isIssueKey(key: string): boolean {
  return !key.startsWith('_');
}

function issueEntryOf(state: PosthogState, key: string): PosthogStateEntry | undefined {
  const value = state[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as PosthogStateEntry;
}

function createPosthogPoller(deps: PosthogPollerDependencies): PosthogPoller {
  const {
    api,
    host = '',
    resolveProjects = async () => [],
    spawnInvestigation,
    telegram = () => {},
    readState = async () => ({}),
    writeState = async () => {},
    setIntervalFn = (fn, ms) => setInterval(fn, ms),
    clearIntervalFn = clearInterval,
    setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
    clearTimeoutFn = clearTimeout,
    log = console,
    onTickComplete = () => {},
    now = () => Date.now(),
  } = deps;

  const intervalMinutes = deps.intervalMinutes || 15;
  const maxConcurrentInvestigations = deps.maxConcurrentInvestigations || 2;
  const investigationTimeoutSeconds = deps.investigationTimeoutSeconds || 900;
  const autoFix = deps.autoFix === true;
  const fixTimeoutSeconds = deps.fixTimeoutSeconds || 1800;
  const minUsersToInvestigate = deps.minUsersToInvestigate ?? core.DEFAULT_MIN_USERS_TO_INVESTIGATE;
  const userEscalationThreshold = deps.userEscalationThreshold ?? core.DEFAULT_USER_ESCALATION_THRESHOLD;
  const dateRangeHours = deps.dateRangeHours || 24;
  const entryRetentionDays = deps.entryRetentionDays ?? core.DEFAULT_ENTRY_RETENTION_DAYS;
  const archivedRetentionDays = deps.archivedRetentionDays ?? core.DEFAULT_ARCHIVED_RETENTION_DAYS;
  const recurrenceDedupe = deps.recurrenceDedupe !== false;
  const recurrenceWindowDays = deps.recurrenceWindowDays ?? recurrence.DEFAULT_RECURRENCE_WINDOW_DAYS;
  const transientRecurrenceLimit = deps.transientRecurrenceLimit ?? recurrence.DEFAULT_TRANSIENT_RECURRENCE_LIMIT;
  const trafficSpikeEnabled = deps.trafficSpikeEnabled !== false;
  const trafficSpikeMultiplier = deps.trafficSpikeMultiplier ?? traffic.DEFAULT_TRAFFIC_SPIKE_MULTIPLIER;
  const trafficSpikeMinUsers = deps.trafficSpikeMinUsers ?? traffic.DEFAULT_TRAFFIC_SPIKE_MIN_USERS;
  const trafficSpikeCooldownMinutes = deps.trafficSpikeCooldownMinutes ?? traffic.DEFAULT_TRAFFIC_SPIKE_COOLDOWN_MINUTES;
  const trafficSpikeBaselineDays = deps.trafficSpikeBaselineDays ?? traffic.DEFAULT_TRAFFIC_BASELINE_DAYS;

  let state: PosthogState = {};

  const loop = createTickLoop({
    tag: 'posthog-poller',
    intervalMs: intervalMinutes * 60000,
    tick: () => runTick(),
    writeState: () => writeState(state),
    setIntervalFn,
    clearIntervalFn,
    log,
  });
  const persist = () => loop.persist();

  function meta(): PosthogMeta {
    const existing = state[META_KEY];
    const record = existing && typeof existing === 'object' && !Array.isArray(existing)
      ? existing as PosthogMeta
      : { lastTickAt: {} };
    if (!record.lastTickAt) record.lastTickAt = {};
    state[META_KEY] = record;
    return record;
  }

  function inFlightCount(): number {
    return Object.keys(state).filter((k) => isIssueKey(k) && issueEntryOf(state, k)?.inFlight).length;
  }

  function pingOnce(kind: string, ctx: Record<string, unknown>, phases: string[]): void {
    if (phases.includes(kind)) return;
    const msg = core.pingFor(kind, ctx);
    phases.push(kind);
    if (msg) telegram(msg);
  }

  function pingAlways(kind: string, ctx: Record<string, unknown>): void {
    const msg = core.pingFor(kind, ctx);
    if (msg) telegram(msg);
  }

  function pingContext(change: IssueChange): Record<string, unknown> {
    return {
      projectName: change.projectName,
      title: change.issue.title,
      occurrences: change.issue.occurrences,
      users: change.issue.users,
      url: change.url,
    };
  }

  function spawnWithTimeout(args: Omit<SpawnInvestigationArgs, 'signal'>): Promise<JobResult> {
    return raceWithAbort<JobResult>({
      timeoutMs: args.timeoutMs,
      setTimeoutFn,
      clearTimeoutFn,
      onTimeout: () => {
        const what = args.mode === core.JOB_MODES.fix ? 'fix' : 'investigation';
        return { verdict: 'ERROR', summary: `${what} timed out`, mode: args.mode };
      },
      onEmpty: () => ({ verdict: 'ERROR', summary: 'no verdict' }),
      start: (signal) => loop.track(Promise.resolve(spawnInvestigation({ ...args, signal }))
        .catch((e: unknown) => ({ verdict: 'ERROR', summary: firstLine(errorMessage(e)) }))),
    });
  }

  function recordTransientCluster(
    change: IssueChange,
    prev: Partial<PosthogStateEntry>,
    summaryLine: string | null,
    at: number,
  ): void {
    state[recurrence.SIGNATURES_KEY] = recurrence.recordTransientSignature(state, {
      key: prev.recurrenceOf || change.key,
      projectId: change.projectId,
      issueId: change.issue.issueId,
      title: change.issue.title,
      summaryLine,
      at,
    });
  }

  function finishInvestigation(
    change: IssueChange,
    result: JobResult | null | undefined,
    plannedMode: string = core.JOB_MODES.investigate,
  ): Promise<void> {
    const prev: Partial<PosthogStateEntry> = issueEntryOf(state, change.key) || {};
    const phases = [...(prev.pingedPhases || [])];
    const verdict = String((result?.verdict) || 'ERROR').toUpperCase();
    const mode = core.normalizeJobMode(result?.mode || plannedMode);
    const isFix = mode === core.JOB_MODES.fix;
    const completedAt = now();
    const kind = VERDICT_PING_KIND[verdict];
    if (kind) {
      const ctx = {
        ...pingContext(change),
        summary: result?.summary,
        detail: isFix && verdict === 'FIXED' ? core.fixDetailLine(result?.reproduced) : undefined,
        prUrl: isFix ? result?.prUrl : undefined,
      };
      if (kind === FIX_PING_KIND) pingAlways(kind, ctx);
      if (kind !== FIX_PING_KIND) pingOnce(kind, ctx, phases);
    }
    const summaryLine = core.summaryLineFromReportText(result?.summary);
    if (recurrenceDedupe && verdict === 'TRANSIENT') {
      recordTransientCluster(change, prev, summaryLine, completedAt);
    }
    state[change.key] = core.nextState(prev, change.issue, {
      verdict,
      summaryLine,
      at: completedAt,
      inFlight: false,
      pingedPhases: phases,
      fix: isFix
        ? { at: completedAt, verdict, reproduced: result?.reproduced === true, prUrl: result?.prUrl }
        : null,
    });
    state[core.INVESTIGATIONS_KEY] = core.appendInvestigation(state[core.INVESTIGATIONS_KEY], core.buildInvestigationRecord({
      key: change.key,
      projectId: change.projectId,
      projectName: change.projectName,
      host,
      issueId: change.issue.issueId,
      title: change.issue.title,
      url: change.url,
      verdict,
      summaryLine: result?.summary,
      at: completedAt,
      mode,
      prUrl: isFix ? result?.prUrl : null,
    }));
    return persist();
  }

  function currentInvestigations(): InvestigationRecord[] {
    return core.unarchivedInvestigations(state[core.INVESTIGATIONS_KEY]);
  }

  function pruneInvestigationLog(): boolean {
    const investigationLog = state[core.INVESTIGATIONS_KEY];
    if (!Array.isArray(investigationLog) || investigationLog.length === 0) return false;
    const pruned = core.pruneInvestigations(investigationLog, now(), { archivedRetentionDays });
    if (pruned.length === investigationLog.length) return false;
    state[core.INVESTIGATIONS_KEY] = pruned;
    return true;
  }

  function pruneSignatureRegistry(): boolean {
    const before = Object.keys(recurrence.signatureRecords(state)).length;
    if (before === 0) return false;
    const pruned = recurrence.pruneSignatures(state, now(), { recurrenceWindowDays });
    if (Object.keys(pruned).length === before) return false;
    state[recurrence.SIGNATURES_KEY] = pruned;
    return true;
  }

  async function archiveInvestigation(id?: string) {
    const ref = core.validateInvestigationId(id);
    if (!ref.ok) return { ok: false, error: ref.error };
    const res = core.markInvestigationArchived(state[core.INVESTIGATIONS_KEY], ref.id, now());
    if (!res.ok) return { ok: false, error: res.error };
    state[core.INVESTIGATIONS_KEY] = res.log;
    await persist();
    return { ok: true, investigations: currentInvestigations() };
  }

  async function runInvestigation(change: IssueChange, mode: string): Promise<void> {
    const isFix = mode === core.JOB_MODES.fix;
    try {
      const res = await spawnWithTimeout({
        key: change.key,
        issue: change.issue,
        projectId: change.projectId,
        projectName: change.projectName,
        host,
        url: change.url,
        mode,
        timeoutMs: (isFix ? fixTimeoutSeconds : investigationTimeoutSeconds) * 1000,
      });
      await finishInvestigation(change, res, mode);
    } catch (e) {
      await finishInvestigation(change, { verdict: 'ERROR', summary: firstLine(errorMessage(e)) }, mode);
    }
  }

  function startInvestigation(change: IssueChange, decision: RecurrenceDecision | null = null): void {
    const mode = core.decideJobMode(change, { autoFix });
    const entry = issueEntryOf(state, change.key);
    if (entry) {
      entry.inFlight = true;
      if (decision?.matchKey) entry.recurrenceOf = decision.matchKey;
    }
    loop.track(runInvestigation(change, mode).catch((e: unknown) => {
      log.warn(`[posthog-poller] investigation crashed for ${change.key}: ${errorMessage(e)}`);
    }));
  }

  function applyDedupe(item: { change: IssueChange; recurrence: RecurrenceDecision }): Promise<void> {
    const { change, recurrence: decision } = item;
    state[recurrence.SIGNATURES_KEY] = recurrence.noteRecurrence(state, decision.matchKey, {
      at: now(),
      issueId: change.issue.issueId,
    });
    const entry = issueEntryOf(state, change.key) || core.nextState(undefined, change.issue, {});
    entry.recurrenceOf = decision.matchKey;
    state[change.key] = entry;
    return finishInvestigation(change, {
      verdict: 'TRANSIENT',
      summary: recurrence.recurrenceSummaryLine(decision),
    });
  }

  function applyEscalation(item: { change: IssueChange; recurrence: RecurrenceDecision }): void {
    const { change, recurrence: decision } = item;
    state[recurrence.SIGNATURES_KEY] = recurrence.noteRecurrence(state, decision.matchKey, {
      at: now(),
      issueId: change.issue.issueId,
      escalated: true,
    });
    pingAlways('recurrence_escalated', {
      ...pingContext(change),
      detail: recurrence.escalationDetail({ ...decision, recurrenceWindowDays }),
    });
  }

  function reconcileVanished(projectPrefix: string, liveKeys: Set<string>, nowTs: number): void {
    for (const key of Object.keys(state)) {
      if (!isIssueKey(key)) continue;
      if (!key.startsWith(projectPrefix)) continue;
      if (liveKeys.has(key)) continue;
      const decision = core.decideVanishedEntry(issueEntryOf(state, key), nowTs, { entryRetentionDays });
      if (decision === 'keep') continue;
      if (decision === 'prune') {
        delete state[key];
        continue;
      }
      const entry = issueEntryOf(state, key);
      if (!entry) continue;
      entry.status = 'resolved';
      entry.vanishedAt = nowTs;
    }
  }

  async function collectSpikeIssueIds(projectId: string | number, sinceTs: number): Promise<Set<string>> {
    const res = await api.listSpikeEvents(projectId).catch(() => null);
    if (!res || !res.ok) return new Set();
    return parseSpikeIssueIds(res.body, sinceTs);
  }

  function trafficState(): Record<string, TrafficState> {
    const slice = state[traffic.TRAFFIC_KEY];
    if (!slice || typeof slice !== 'object' || Array.isArray(slice)) state[traffic.TRAFFIC_KEY] = {};
    return state[traffic.TRAFFIC_KEY] as Record<string, TrafficState>;
  }

  async function tickTraffic(projectId: string | number, projectName: string, nowTs: number): Promise<void> {
    if (!trafficSpikeEnabled) return;
    if (typeof api.queryTrafficBuckets !== 'function') return;
    try {
      const res = await api.queryTrafficBuckets(projectId, { baselineDays: trafficSpikeBaselineDays });
      if (!res || !res.ok || !('buckets' in res)) {
        const reason = res && 'error' in res ? res.error : null;
        log.warn(`[posthog-poller] traffic query failed for ${projectName}: ${reason || 'no response'}`);
        return;
      }
      const baseline = traffic.computeBaseline(res.buckets);
      const key = String(projectId);
      const verdict = traffic.decideTrafficSpike({
        currentUsers: res.currentUsers,
        baseline,
        prev: trafficState()[key],
        now: nowTs,
        cfg: {
          multiplier: trafficSpikeMultiplier,
          minUsers: trafficSpikeMinUsers,
          cooldownMinutes: trafficSpikeCooldownMinutes,
        },
      });
      trafficState()[key] = verdict.nextState;
      const kind = TRAFFIC_PING_KIND[verdict.action];
      if (!kind) return;
      pingAlways(kind, {
        projectName,
        title: traffic.spikeSummaryLine({
          currentUsers: res.currentUsers,
          baseline,
          multiple: verdict.multiple,
        }),
      });
    } catch (e) {
      log.warn(`[posthog-poller] traffic check failed for ${projectName}: ${errorMessage(e)}`);
    }
  }

  async function tickProject(project: PollerProject) {
    const { projectId } = project;
    const projectName = project.name || String(projectId);
    const tickStartedAt = now();
    const issuesRes = await api.queryIssues(projectId, { dateRangeHours });
    if (!issuesRes || !issuesRes.ok) {
      const error = String((issuesRes && 'error' in issuesRes ? issuesRes.error : null) || 'no response');
      log.warn(`[posthog-poller] issue query failed for ${projectName}: ${error}`);
      return {
        dirty: false,
        summary: {
          projectId,
          name: projectName,
          host,
          lastTickAt: meta().lastTickAt[String(projectId)] || 0,
          issues: [],
          error,
        },
      };
    }

    const issues = normalizeIssues(issuesRes.body);
    const lastTickAt = meta().lastTickAt[String(projectId)] || 0;
    const spikeIssueIds = await collectSpikeIssueIds(projectId, lastTickAt);

    const changes: IssueChange[] = issues.map((issue) => ({
      key: core.issueKey(host, projectId, issue.issueId),
      issue,
      projectId,
      projectName,
      url: core.issueUrl(host, projectId, issue.issueId),
      change: core.classifyIssueChange(issueEntryOf(state, core.issueKey(host, projectId, issue.issueId)), issue, spikeIssueIds, {
        userEscalationThreshold,
      }),
    }));

    reconcileVanished(core.issueKey(host, projectId, ''), new Set(changes.map((c) => c.key)), tickStartedAt);

    for (const change of changes) {
      const prev: Partial<PosthogStateEntry> = issueEntryOf(state, change.key) || {};
      const phases = [...(prev.pingedPhases || [])];
      const observation = OBSERVATION_PINGS[change.change];
      if (observation?.dedupe) pingOnce(observation.kind, pingContext(change), phases);
      if (observation && !observation.dedupe) pingAlways(observation.kind, pingContext(change));
      if (change.change === 'new' && !prev.verdict) {
        pingOnce('new_issue', pingContext(change), phases);
      }
      state[change.key] = core.nextState(prev, change.issue, {
        observedAt: tickStartedAt,
        inFlight: prev.inFlight === true,
        pingedPhases: phases,
      });
    }

    const plan = recurrence.planIssueActions(changes, state, {
      minUsersToInvestigate,
      userEscalationThreshold,
      recurrenceDedupe,
      recurrenceWindowDays,
      transientRecurrenceLimit,
      now: tickStartedAt,
    });
    for (const item of plan.dedupe) {
      await applyDedupe(item as { change: IssueChange; recurrence: RecurrenceDecision });
    }

    let slots = maxConcurrentInvestigations - inFlightCount();
    for (const item of plan.investigate) {
      if (slots <= 0) break;
      if (loop.isStopped()) break;
      slots -= 1;
      const escalating = item.recurrence.action === 'escalate'
        && recurrence.signatureRecords(state)[item.recurrence.matchKey ?? '']?.escalated !== true;
      const typedItem = item as { change: IssueChange; recurrence: RecurrenceDecision };
      if (escalating) applyEscalation(typedItem);
      startInvestigation(typedItem.change, typedItem.recurrence);
    }

    await tickTraffic(projectId, projectName, tickStartedAt);

    meta().lastTickAt[String(projectId)] = tickStartedAt;

    return {
      dirty: true,
      summary: {
        projectId,
        name: projectName,
        host,
        lastTickAt: meta().lastTickAt[String(projectId)],
        issues: changes.map((change) => {
          const entry = issueEntryOf(state, change.key);
          return {
            issueId: change.issue.issueId,
            title: change.issue.title,
            change: change.change,
            occurrences: change.issue.occurrences,
            users: change.issue.users,
            verdict: entry?.verdict || null,
            summaryLine: entry?.summaryLine || null,
            history: Array.isArray(entry?.history) ? entry.history : [],
            inFlight: !!entry?.inFlight,
            url: change.url,
          };
        }),
      },
    };
  }

  async function runTick(): Promise<TickOutcome | undefined> {
    const projects = await resolveProjects().catch((e: unknown) => {
      log.warn(`[posthog-poller] project resolution failed: ${errorMessage(e)}`);
      return [];
    });
    let dirty = false;
    const summaries: Record<string, unknown>[] = [];
    for (const project of projects) {
      const res = await tickProject(project).catch((e: unknown) => {
        log.warn(`[posthog-poller] tick failed for ${project?.projectId}: ${errorMessage(e)}`);
        return null;
      });
      if (!res) continue;
      if (res.dirty) dirty = true;
      summaries.push(res.summary);
    }
    if (pruneInvestigationLog()) dirty = true;
    if (pruneSignatureRegistry()) dirty = true;
    if (dirty) await persist();
    onTickComplete({
      type: 'posthog-status',
      ts: now(),
      intervalMinutes,
      projects: summaries,
      investigations: currentInvestigations(),
    });
    return undefined;
  }

  async function start(): Promise<void> {
    await loop.start(async () => {
      state = (await readState()) || {};
      for (const key of Object.keys(state)) {
        if (!isIssueKey(key)) continue;
        const entry = issueEntryOf(state, key);
        if (entry) entry.inFlight = false;
      }
      pruneInvestigationLog();
      pruneSignatureRegistry();
    });
  }

  return {
    start, stop: loop.stop, tick: loop.tick, archiveInvestigation,
    investigations: currentInvestigations,
    _state: () => state,
  };
}

export { createPosthogPoller };
export type { IssueChange, PosthogPoller, PosthogPollerDependencies, PosthogState, SpawnInvestigationArgs };
