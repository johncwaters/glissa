'use strict';

const core = require('./core/posthog-core');
const recurrence = require('./core/posthog-recurrence');
const traffic = require('./core/traffic-spike-core');
const { normalizeIssues, parseSpikeIssueIds } = require('./posthog-api');

/*
 * The PostHog monitoring poller. IO-FREE by construction, exactly like server/pr-poller.js: the
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
 * through posthog-wiring.js, never through here.
 */

// Observation-level pings (fired from the classification, before any investigation runs).
// A regression is naturally once-per-occurrence: it stops matching as soon as the entry's status is
// written back as active. A SPIKE is not - the same issue can classify spiking on every tick for as
// long as the spike endpoint keeps naming it - so it is deduped through the entry's pingedPhases.
const OBSERVATION_PINGS = {
  spiking: { kind: 'spike', dedupe: true },
  regressed: { kind: 'regression', dedupe: false },
};

// Investigation-verdict pings. ROOT_CAUSE is absent on purpose: a diagnosed issue is digest
// material, not a phone buzz (core.pingFor returns null for it either way). FIXED belongs to the
// auto-fix job and DOES ping: a shipped pull request is the one verdict that asks for a carbon unit.
// TRANSIENT stays silent in both modes.
const VERDICT_PING_KIND = {
  NEEDS_HUMAN: 'needs_human',
  ERROR: 'error',
  FIXED: 'fixed',
};

// The one verdict ping that is NOT deduped per issue phase (see finishInvestigation).
const FIX_PING_KIND = 'fixed';

// Traffic-lane verdicts that reach Telegram. 'clear' is absent on purpose: traffic falling back to
// normal re-arms the state silently, it is not news.
const TRAFFIC_PING_KIND = {
  ping: 'traffic_spike',
  escalate: 'traffic_spike_growth',
};

const META_KEY = '_meta';

function isIssueKey(key) {
  return !key.startsWith('_');
}

function createPosthogPoller(deps) {
  const {
    api,
    host = '',
    resolveProjects = async () => [],
    spawnInvestigation,
    telegram = () => {},
    readState = async () => ({}),
    writeState = async () => {},
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    setTimeoutFn = setTimeout,
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

  let state = {};
  let timer = null;
  let tickRunning = false;
  let stopped = false;
  let persistChain = Promise.resolve();
  // In-flight runInvestigation() calls, tracked so stop() can drain them before a caller reuses the
  // dependencies (result-file paths, report dir, state file) for a fresh poller instance.
  const running = new Set();

  function persist() {
    persistChain = persistChain.then(() => writeState(state)).catch((e) => {
      log.warn(`[posthog-poller] state write failed: ${e.message}`);
    });
    return persistChain;
  }

  function meta() {
    if (!state[META_KEY]) state[META_KEY] = { lastTickAt: {} };
    if (!state[META_KEY].lastTickAt) state[META_KEY].lastTickAt = {};
    return state[META_KEY];
  }

  function inFlightCount() {
    return Object.keys(state).filter((k) => isIssueKey(k) && state[k] && state[k].inFlight).length;
  }

  function firstLine(s) {
    return String(s || '').split(/\r?\n/)[0].trim();
  }

  // Fire a ping once per phase per issue. `phases` is the entry's own pingedPhases array, mutated in
  // place so the caller's nextState() call carries the record forward.
  function pingOnce(kind, ctx, phases) {
    if (phases.includes(kind)) return;
    const msg = core.pingFor(kind, ctx);
    phases.push(kind);
    if (msg) telegram(msg);
  }

  function pingAlways(kind, ctx) {
    const msg = core.pingFor(kind, ctx);
    if (msg) telegram(msg);
  }

  function pingContext(change) {
    return {
      projectName: change.projectName,
      title: change.issue.title,
      occurrences: change.issue.occurrences,
      users: change.issue.users,
      url: change.url,
    };
  }

  // Race the injected spawnInvestigation against a hard timeout so a hung `claude -p` session can
  // never pin an issue in-flight forever (same guarantee as pr-poller.spawnWithTimeout). On timeout
  // the session is aborted and the verdict resolves to ERROR, freeing the concurrency slot.
  async function spawnWithTimeout(args) {
    const controller = new AbortController();
    let timeoutHandle = null;
    const timeout = new Promise((resolve) => {
      timeoutHandle = setTimeoutFn(() => {
        controller.abort();
        const what = args.mode === core.JOB_MODES.fix ? 'fix' : 'investigation';
        resolve({ verdict: 'ERROR', summary: `${what} timed out`, mode: args.mode });
      }, args.timeoutMs);
      if (timeoutHandle && typeof timeoutHandle.unref === 'function') timeoutHandle.unref();
    });
    const run = Promise.resolve(spawnInvestigation({ ...args, signal: controller.signal }))
      .catch((e) => ({ verdict: 'ERROR', summary: firstLine(e.message) }));
    // Tracked on its own, not only through the race: on the TIMEOUT path the race resolves and the
    // slot frees while the spawn is still unwinding, and a fix job unwinds through its worktree
    // discard. Without this, stop() (a shutdown, or a settings-triggered restart) could return
    // before that discard ran and leave the throwaway checkout behind for the next instance.
    running.add(run);
    run.finally(() => running.delete(run));
    const res = await Promise.race([run, timeout]);
    if (timeoutHandle) clearTimeoutFn(timeoutHandle);
    return res || { verdict: 'ERROR', summary: 'no verdict' };
  }

  // Open or refresh the signature cluster after a TRANSIENT verdict; recurrenceOf folds a matched
  // issue back into its cluster rather than opening a rival one.
  function recordTransientCluster(change, prev, summaryLine, at) {
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
  function finishInvestigation(change, result, plannedMode = core.JOB_MODES.investigate) {
    const prev = state[change.key] || {};
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

  function currentInvestigations() {
    return core.unarchivedInvestigations(state[core.INVESTIGATIONS_KEY]);
  }

  /*
   * Drop archived records past the retention window. Runs at the two seams that already touch the
   * log - the state load and each tick, just before its persist - so the cleanup needs no timer of
   * its own and rides the write that was happening anyway. Returns whether anything went, so the
   * tick can persist a purge that happened on an otherwise clean cycle.
   */
  function pruneInvestigationLog() {
    const log = state[core.INVESTIGATIONS_KEY];
    if (!Array.isArray(log) || log.length === 0) return false;
    const pruned = core.pruneInvestigations(log, now(), { archivedRetentionDays });
    if (pruned.length === log.length) return false;
    state[core.INVESTIGATIONS_KEY] = pruned;
    return true;
  }

  // Age out clusters past the window, at the same two seams as the investigations-log prune.
  function pruneSignatureRegistry() {
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
  async function archiveInvestigation(id) {
    const ref = core.validateInvestigationId(id);
    if (!ref.ok) return { ok: false, error: ref.error };
    const res = core.markInvestigationArchived(state[core.INVESTIGATIONS_KEY], ref.id, now());
    if (!res.ok) return { ok: false, error: res.error };
    state[core.INVESTIGATIONS_KEY] = res.log;
    await persist();
    return { ok: true, investigations: currentInvestigations() };
  }

  async function runInvestigation(change, mode) {
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
      await finishInvestigation(change, { verdict: 'ERROR', summary: firstLine(e.message) }, mode);
    }
  }

  // Mark an issue in-flight and launch its job, tracked so stop() drains it. Shared by the tick's
  // planned investigations and the operator's manual re-investigation, so both take the same
  // concurrency slot, the same never-rejecting tracking promise, and the same state bookkeeping.
  // A fix job and an investigation are indistinguishable here on purpose: one slot pool, one drain.
  function startInvestigation(change, decision = null) {
    const mode = core.decideJobMode(change, { autoFix });
    state[change.key].inFlight = true;
    if (decision?.matchKey) state[change.key].recurrenceOf = decision.matchKey;
    const investigation = runInvestigation(change, mode).catch((e) => {
      log.warn(`[posthog-poller] investigation crashed for ${change.key}: ${e.message}`);
    });
    running.add(investigation);
    investigation.finally(() => running.delete(investigation));
  }

  // A would-be investigation the recurrence memory already answered: nothing spawns, but the normal
  // completion path still runs, and the counter grows on the PRIOR record, which outlives this entry.
  function applyDedupe(item) {
    const { change, recurrence: decision } = item;
    state[recurrence.SIGNATURES_KEY] = recurrence.noteRecurrence(state, decision.matchKey, {
      at: now(),
      issueId: change.issue.issueId,
    });
    const entry = state[change.key] || core.nextState(undefined, change.issue, {});
    entry.recurrenceOf = decision.matchKey;
    state[change.key] = entry;
    return finishInvestigation(change, {
      verdict: 'TRANSIENT',
      summary: recurrence.recurrenceSummaryLine(decision),
    });
  }

  // Stop trusting a cluster's verdict: the escalated latch keeps later issues out of the dedupe
  // path, and the ping surfaces what a silent dedupe would have buried.
  function applyEscalation(item) {
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
  function reconcileVanished(projectPrefix, liveKeys, nowTs) {
    for (const key of Object.keys(state)) {
      if (!isIssueKey(key)) continue;
      if (!key.startsWith(projectPrefix)) continue;
      if (liveKeys.has(key)) continue;
      const decision = core.decideVanishedEntry(state[key], nowTs, { entryRetentionDays });
      if (decision === 'keep') continue;
      if (decision === 'prune') {
        delete state[key];
        continue;
      }
      state[key].status = 'resolved';
      state[key].vanishedAt = nowTs;
    }
  }

  async function collectSpikeIssueIds(projectId, sinceTs) {
    const res = await api.listSpikeEvents(projectId).catch(() => null);
    if (!res || !res.ok) return new Set();
    return parseSpikeIssueIds(res.body, sinceTs);
  }

  function trafficState() {
    const slice = state[traffic.TRAFFIC_KEY];
    if (!slice || typeof slice !== 'object' || Array.isArray(slice)) state[traffic.TRAFFIC_KEY] = {};
    return state[traffic.TRAFFIC_KEY];
  }

  // Traffic query failures warn only, because a broken query would otherwise buzz a carbon unit every interval.
  async function tickTraffic(projectId, projectName, nowTs) {
    if (!trafficSpikeEnabled) return;
    if (typeof api.queryTrafficBuckets !== 'function') return;
    try {
      const res = await api.queryTrafficBuckets(projectId, { baselineDays: trafficSpikeBaselineDays });
      if (!res || !res.ok) {
        log.warn(`[posthog-poller] traffic query failed for ${projectName}: ${(res?.error) || 'no response'}`);
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
      log.warn(`[posthog-poller] traffic check failed for ${projectName}: ${e.message}`);
    }
  }

  async function tickProject(project) {
    const { projectId } = project;
    const projectName = project.name || String(projectId);
    // Stamped BEFORE the queries, and used as the next tick's spike cutoff. Stamping after them left
    // the whole query window (plus every investigation spawned in it) invisible to the next tick, so
    // a spike landing mid-tick was never seen.
    const tickStartedAt = now();
    const issuesRes = await api.queryIssues(projectId, { dateRangeHours });
    if (!issuesRes || !issuesRes.ok) {
      const error = String((issuesRes?.error) || 'no response');
      log.warn(`[posthog-poller] issue query failed for ${projectName}: ${error}`);
      // Reported rather than dropped: a project that silently vanished from the dashboard looked
      // exactly like a healthy one nobody had errors in.
      return {
        dirty: false,
        summary: {
          projectId,
          name: projectName,
          host,
          lastTickAt: meta().lastTickAt[projectId] || 0,
          issues: [],
          error,
        },
      };
    }

    const issues = normalizeIssues(issuesRes.body);
    const lastTickAt = meta().lastTickAt[projectId] || 0;
    const spikeIssueIds = await collectSpikeIssueIds(projectId, lastTickAt);

    const changes = issues.map((issue) => ({
      key: core.issueKey(host, projectId, issue.issueId),
      issue,
      projectId,
      projectName,
      url: core.issueUrl(host, projectId, issue.issueId),
      change: core.classifyIssueChange(state[core.issueKey(host, projectId, issue.issueId)], issue, spikeIssueIds, {
        userEscalationThreshold,
      }),
    }));

    reconcileVanished(core.issueKey(host, projectId, ''), new Set(changes.map((c) => c.key)), tickStartedAt);

    for (const change of changes) {
      const prev = state[change.key] || {};
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
      await applyDedupe(item);
    }

    let slots = maxConcurrentInvestigations - inFlightCount();
    for (const item of plan.investigate) {
      if (slots <= 0) break;
      if (stopped) break;
      slots -= 1;
      // Latch-and-ping only alongside the spawn it justifies; the latch re-check keeps two
      // same-cluster escalations planned from one pre-tick snapshot down to a single ping.
      const escalating = item.recurrence.action === 'escalate'
        && recurrence.signatureRecords(state)[item.recurrence.matchKey]?.escalated !== true;
      if (escalating) applyEscalation(item);
      startInvestigation(item.change, item.recurrence);
    }

    await tickTraffic(projectId, projectName, tickStartedAt);

    // The stamp itself is state, and the next tick's spike cutoff depends on it surviving a restart,
    // so a project that got as far as querying always persists.
    meta().lastTickAt[projectId] = tickStartedAt;

    return {
      dirty: true,
      summary: {
        projectId,
        name: projectName,
        host,
        lastTickAt: meta().lastTickAt[projectId],
        issues: changes.map((change) => ({
          issueId: change.issue.issueId,
          title: change.issue.title,
          change: change.change,
          occurrences: change.issue.occurrences,
          users: change.issue.users,
          verdict: (state[change.key] && state[change.key].verdict) || null,
          summaryLine: (state[change.key] && state[change.key].summaryLine) || null,
          history: Array.isArray(state[change.key]?.history) ? state[change.key].history : [],
          inFlight: !!(state[change.key] && state[change.key].inFlight),
          url: change.url,
        })),
      },
    };
  }

  async function tick() {
    if (tickRunning || stopped) return;
    tickRunning = true;
    try {
      const projects = await resolveProjects().catch((e) => {
        log.warn(`[posthog-poller] project resolution failed: ${e.message}`);
        return [];
      });
      let dirty = false;
      const summaries = [];
      for (const project of projects) {
        const res = await tickProject(project).catch((e) => {
          log.warn(`[posthog-poller] tick failed for ${project?.projectId}: ${e.message}`);
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
    } finally {
      tickRunning = false;
    }
  }

  async function start() {
    stopped = false;
    state = (await readState()) || {};
    for (const key of Object.keys(state)) {
      if (!isIssueKey(key)) continue;
      if (state[key]) state[key].inFlight = false;
    }
    pruneInvestigationLog();
    pruneSignatureRegistry();
    await tick();
    timer = setIntervalFn(() => { void tick(); }, intervalMinutes * 60000);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  // Async for the same reason as pr-poller.stop(): a caller that restarts the poller must let the old
  // instance's in-flight investigations (up to investigationTimeoutSeconds) and pending state writes
  // drain BEFORE a new instance reuses the same result-file paths, report dir, and state file.
  async function stop() {
    stopped = true;
    if (timer) clearIntervalFn(timer);
    timer = null;
    await Promise.allSettled([...running]);
    await persistChain;
  }

  return {
    start, stop, tick, archiveInvestigation,
    investigations: currentInvestigations,
    _state: () => state,
  };
}

module.exports = { createPosthogPoller };
