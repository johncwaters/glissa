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

/*
 * The PostHog monitoring poller. IO-FREE by construction, exactly like server/pr-poller.ts: the
 * PostHog client, the session spawn, Telegram, state persistence and every timer are injected, so a
 * whole tick is unit-testable with fakes.
 *
 * Per-issue lifecycle (state persisted across ticks, keyed by `<host>/<projectId>#<issueId>`):
 *   new / spiking / regressed / worsened -> spawn one headless investigation session -> a verdict of
 *   ROOT_CAUSE (quiet), NEEDS_HUMAN (ping once) or ERROR (ping once) is recorded on the entry.
 *   quiet   -> observed only; costs nothing.
 * An issue that vanishes from the active list is marked resolved and aged out (see reconcileVanished).
 *
 * The poller makes ZERO writes to PostHog: nothing on a tick resolves, assigns, or merges an issue.
 * The only write in the lane is the carbon unit's explicit resolve/suppress click, which goes
 * through posthog-wiring.ts, never through here.
 */

// Observation-level pings (fired from the classification, before any investigation runs).
// A regression is naturally once-per-occurrence: it stops matching as soon as the entry's status is
// written back as active. A SPIKE is not - the same issue can classify spiking on every tick for as
// long as the spike endpoint keeps naming it - so it is deduped through the entry's pingedPhases.
const OBSERVATION_PINGS: Record<string, { kind: string; dedupe: boolean } | undefined> = {
  spiking: { kind: 'spike', dedupe: true },
  regressed: { kind: 'regression', dedupe: false },
};

// Investigation-verdict pings. ROOT_CAUSE is absent on purpose: a diagnosed issue is digest
// material, not a phone buzz (core.pingFor returns null for it either way). FIXED belongs to the
// auto-fix job and DOES ping: a shipped pull request is the one verdict that asks for a carbon unit.
// TRANSIENT stays silent in both modes.
const VERDICT_PING_KIND: Record<string, string | undefined> = {
  NEEDS_HUMAN: 'needs_human',
  ERROR: 'error',
  FIXED: 'fixed',
};

// The one verdict ping that is NOT deduped per issue phase (see finishInvestigation).
const FIX_PING_KIND = 'fixed';

// Traffic-lane verdicts that reach Telegram. 'clear' is absent on purpose: traffic falling back to
// normal re-arms the state silently, it is not news.
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
  // The narrow call shapes createTickLoop and raceWithAbort declare, not the globals: setInterval's and
  // setTimeout's __promisify__ members make those types unimplementable by a hand-fired test timer.
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
  // Auto-fix is OFF unless explicitly enabled: a lane that diagnoses is a monitor, a lane that pushes
  // branches is a contributor, and the operator opts into the second one deliberately.
  const autoFix = deps.autoFix === true;
  // A fix reproduces, repairs and runs a suite, so it gets its own (longer) ceiling. Fix jobs still
  // ride the SAME concurrency slots as investigations: one cap governs what the lane costs.
  const fixTimeoutSeconds = deps.fixTimeoutSeconds || 1800;
  const minUsersToInvestigate = deps.minUsersToInvestigate ?? core.DEFAULT_MIN_USERS_TO_INVESTIGATE;
  const userEscalationThreshold = deps.userEscalationThreshold ?? core.DEFAULT_USER_ESCALATION_THRESHOLD;
  const dateRangeHours = deps.dateRangeHours || 24;
  const entryRetentionDays = deps.entryRetentionDays ?? core.DEFAULT_ENTRY_RETENTION_DAYS;
  const archivedRetentionDays = deps.archivedRetentionDays ?? core.DEFAULT_ARCHIVED_RETENTION_DAYS;
  // Recurrence dedupe is ON unless explicitly disabled: a repeat of a diagnosed non-event is the
  // common case, and the kill switch exists for an operator who would rather pay than ever miss one.
  const recurrenceDedupe = deps.recurrenceDedupe !== false;
  const recurrenceWindowDays = deps.recurrenceWindowDays ?? recurrence.DEFAULT_RECURRENCE_WINDOW_DAYS;
  const transientRecurrenceLimit = deps.transientRecurrenceLimit ?? recurrence.DEFAULT_TRANSIENT_RECURRENCE_LIMIT;
  // Traffic spike detection rides the same tick and is ON unless explicitly disabled: it costs two
  // read-only HogQL queries per project and answers the one question error triage cannot.
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

  // Fire a ping once per phase per issue. `phases` is the entry's own pingedPhases array, mutated in
  // place so the caller's nextState() call carries the record forward.
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
      // Tracked on its own, not only through the race: on the TIMEOUT path the race resolves and the
      // slot frees while the spawn is still unwinding, and a fix job unwinds through its worktree
      // discard. Without this, stop() (a shutdown, or a settings-triggered restart) could return
      // before that discard ran and leave the throwaway checkout behind for the next instance.
      start: (signal) => loop.track(Promise.resolve(spawnInvestigation({ ...args, signal }))
        .catch((e: unknown) => ({ verdict: 'ERROR', summary: firstLine(errorMessage(e)) }))),
    });
  }

  // Open or refresh the signature cluster after a TRANSIENT verdict; recurrenceOf folds a matched
  // issue back into its cluster rather than opening a rival one.
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

  /*
   * `plannedMode` is what the tick decided; `result.mode` is what actually ran. They differ when the
   * wiring downgraded a fix to an investigation (no repository to commit in), and the entry, the ping
   * and the inbox record must all describe the job that happened, not the one that was planned.
   */
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
      // A completed fix is per JOB, not per issue phase: pingedPhases is carried forward forever, so
      // deduping it meant the SECOND fix (after a regression) opened a pull request in silence. The
      // dispatch gates already decide when a second fix may run at all.
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
    // The inbox entry is written HERE, at the same seam as the verdict, so it exists whether or not
    // the verdict pinged and whether or not the issue survives in the active list.
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

  /*
   * Drop archived records past the retention window. Runs at the two seams that already touch the
   * log - the state load and each tick, just before its persist - so the cleanup needs no timer of
   * its own and rides the write that was happening anyway. Returns whether anything went, so the
   * tick can persist a purge that happened on an otherwise clean cycle.
   */
  function pruneInvestigationLog(): boolean {
    const investigationLog = state[core.INVESTIGATIONS_KEY];
    if (!Array.isArray(investigationLog) || investigationLog.length === 0) return false;
    const pruned = core.pruneInvestigations(investigationLog, now(), { archivedRetentionDays });
    if (pruned.length === investigationLog.length) return false;
    state[core.INVESTIGATIONS_KEY] = pruned;
    return true;
  }

  // Age out clusters past the window, at the same two seams as the investigations-log prune.
  function pruneSignatureRegistry(): boolean {
    const before = Object.keys(recurrence.signatureRecords(state)).length;
    if (before === 0) return false;
    const pruned = recurrence.pruneSignatures(state, now(), { recurrenceWindowDays });
    if (Object.keys(pruned).length === before) return false;
    state[recurrence.SIGNATURES_KEY] = pruned;
    return true;
  }

  /*
   * Operator-driven archive of one inbox record. Purely a state edit: nothing is polled, nothing is
   * written to PostHog, and the record stays in the log (archived) rather than being deleted, so the
   * cap keeps behaving as a plain newest-N window.
   */
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

  // Mark an issue in-flight and launch its job, tracked so stop() drains it. Shared by the tick's
  // planned investigations and the operator's manual re-investigation, so both take the same
  // concurrency slot, the same never-rejecting tracking promise, and the same state bookkeeping.
  // A fix job and an investigation are indistinguishable here on purpose: one slot pool, one drain.
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

  // A would-be investigation the recurrence memory already answered: nothing spawns, but the normal
  // completion path still runs, and the counter grows on the PRIOR record, which outlives this entry.
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

  // Stop trusting a cluster's verdict: the escalated latch keeps later issues out of the dedupe
  // path, and the ping surfaces what a silent dedupe would have buried.
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

  // Absence from one tick is NOT death: queryIssues returns only the top-50 active issues of the last
  // 24h, so a live investigation's issue or a merely quieter recurring issue routinely falls off the
  // list. core.decideVanishedEntry keeps an in-flight entry, marks a first absence resolved (which is
  // what lets a reappearance classify as 'regressed'), and only drops an entry once it has been gone
  // longer than the retention window.
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

  // Traffic query failures warn only, because a broken query would otherwise buzz a carbon unit every interval.
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
    // Stamped BEFORE the queries, and used as the next tick's spike cutoff. Stamping after them left
    // the whole query window (plus every investigation spawned in it) invisible to the next tick, so
    // a spike landing mid-tick was never seen.
    const tickStartedAt = now();
    const issuesRes = await api.queryIssues(projectId, { dateRangeHours });
    if (!issuesRes || !issuesRes.ok) {
      const error = String((issuesRes && 'error' in issuesRes ? issuesRes.error : null) || 'no response');
      log.warn(`[posthog-poller] issue query failed for ${projectName}: ${error}`);
      // Reported rather than dropped: a project that silently vanished from the dashboard looked
      // exactly like a healthy one nobody had errors in.
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
      // Same rule as the auto-fix major predicate: the issue itself qualifies, blast radius does not.
      if (change.change === 'new' && !prev.verdict) {
        pingOnce('new_issue', pingContext(change), phases);
      }
      state[change.key] = core.nextState(prev, change.issue, {
        observedAt: tickStartedAt,
        inFlight: prev.inFlight === true,
        pingedPhases: phases,
      });
    }

    // One planning call decides everything about a change: whether it earns attention at all, and
    // whether the lane's recurrence memory already knows the answer. Deduped items still get a
    // verdict and an inbox record, they just never spawn a session.
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
      // Latch-and-ping only alongside the spawn it justifies; the latch re-check keeps two
      // same-cluster escalations planned from one pre-tick snapshot down to a single ping.
      const escalating = item.recurrence.action === 'escalate'
        && recurrence.signatureRecords(state)[item.recurrence.matchKey ?? '']?.escalated !== true;
      const typedItem = item as { change: IssueChange; recurrence: RecurrenceDecision };
      if (escalating) applyEscalation(typedItem);
      startInvestigation(typedItem.change, typedItem.recurrence);
    }

    await tickTraffic(projectId, projectName, tickStartedAt);

    // The stamp itself is state, and the next tick's spike cutoff depends on it surviving a restart,
    // so a project that got as far as querying always persists.
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
      // The dashboard's staleness threshold is two missed polls, which it cannot compute without
      // knowing how often we poll.
      intervalMinutes,
      projects: summaries,
      investigations: currentInvestigations(),
    });
    // The tick loop reads a returned outcome as a failed poll; this lane never reports one.
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
