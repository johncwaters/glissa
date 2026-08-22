'use strict';

const core = require('./core/posthog-core');
const { normalizeIssues, parseSpikeIssueIds } = require('./posthog-api');

/*
 * The PostHog monitoring poller. IO-FREE by construction, exactly like server/pr-poller.js: the
 * PostHog client, the session spawn, Telegram, state persistence and every timer are injected, so a
 * whole tick is unit-testable with fakes.
 *
 * Per-issue lifecycle (state persisted across ticks, keyed by `<host>/<projectId>#<issueId>`):
 *   new / spiking / regressed -> spawn one headless investigation session -> a verdict of
 *   ROOT_CAUSE (quiet), NEEDS_HUMAN (ping once) or ERROR (ping once) is recorded on the entry.
 *   quiet   -> observed only; costs nothing.
 * An issue that vanishes from the active list is marked resolved and aged out (see reconcileVanished).
 *
 * The poller makes ZERO writes to PostHog: nothing on a tick resolves, assigns, or merges an issue.
 * The only write in the lane is the carbon unit's explicit resolve/suppress click, which goes
 * through posthog-wiring.js, never through here.
 */

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
  const dateRangeHours = deps.dateRangeHours || 24;
  const entryRetentionDays = deps.entryRetentionDays ?? core.DEFAULT_ENTRY_RETENTION_DAYS;

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
    state[change.key] = core.nextState(prev, change.issue, {
      verdict,
      summaryLine: core.summaryLineFromReportText(result?.summary),
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
    return core.sortedInvestigations(state[core.INVESTIGATIONS_KEY]);
  }

  /*
   * Operator-driven removal of one inbox record. Purely a state edit: nothing is polled and nothing
   * is written to PostHog.
   */
  async function archiveInvestigation(id) {
    const ref = core.validateInvestigationId(id);
    if (!ref.ok) return { ok: false, error: ref.error };
    const res = core.removeInvestigation(state[core.INVESTIGATIONS_KEY], ref.id);
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

  // Mark an issue in-flight and launch its job, tracked so stop() drains it. A fix job and an
  // investigation are indistinguishable here on purpose: one slot pool, one drain.
  function startInvestigation(change) {
    const mode = core.decideJobMode(change, { autoFix });
    state[change.key].inFlight = true;
    const investigation = runInvestigation(change, mode).catch((e) => {
      log.warn(`[posthog-poller] investigation crashed for ${change.key}: ${e.message}`);
    });
    running.add(investigation);
    investigation.finally(() => running.delete(investigation));
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
      change: core.classifyIssueChange(state[core.issueKey(host, projectId, issue.issueId)], issue, spikeIssueIds),
    }));

    reconcileVanished(core.issueKey(host, projectId, ''), new Set(changes.map((c) => c.key)), tickStartedAt);

    for (const change of changes) {
      const prev = state[change.key] || {};
      const phases = [...(prev.pingedPhases || [])];
      // A regression is naturally once-per-occurrence (it stops matching as soon as the entry's
      // status is written back as active); a spike and a first sighting are not, so both dedupe
      // through the entry's pingedPhases.
      if (change.change === 'spiking') pingOnce('spike', pingContext(change), phases);
      if (change.change === 'regressed') pingAlways('regression', pingContext(change));
      if (change.change === 'new' && !prev.verdict) pingOnce('new_issue', pingContext(change), phases);
      state[change.key] = core.nextState(prev, change.issue, {
        observedAt: tickStartedAt,
        inFlight: prev.inFlight === true,
        pingedPhases: phases,
      });
    }

    let slots = maxConcurrentInvestigations - inFlightCount();
    for (const change of core.planInvestigations(changes, state, { minUsersToInvestigate })) {
      if (slots <= 0) break;
      if (stopped) break;
      slots -= 1;
      startInvestigation(change);
    }

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
