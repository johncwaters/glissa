'use strict';

const core = require('./core/posthog-core');
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
 * The only write in the lane is the operator's explicit resolve/suppress click, which goes through
 * posthog-wiring.js, never through here. investigateNow() is the poller's one other operator entry
 * point: a manual re-investigation that reuses the automatic path's slots and bookkeeping.
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
// material, not a phone buzz (core.pingFor returns null for it either way).
const VERDICT_PING_KIND = {
  NEEDS_HUMAN: 'needs_human',
  ERROR: 'error',
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
  const minUsersToInvestigate = deps.minUsersToInvestigate ?? core.DEFAULT_MIN_USERS_TO_INVESTIGATE;
  const userEscalationThreshold = deps.userEscalationThreshold ?? core.DEFAULT_USER_ESCALATION_THRESHOLD;
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
  // Last tick's issues per project, keyed by issue id. The persisted state entry records what an
  // issue DID (verdict, counts at diagnosis) but not what it IS (title, current aggregates), and the
  // manual investigateNow() below needs the latter to build the same change object a tick builds.
  const lastIssuesByProject = new Map();

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
        resolve({ verdict: 'ERROR', summary: 'investigation timed out' });
      }, args.timeoutMs);
      if (timeoutHandle && typeof timeoutHandle.unref === 'function') timeoutHandle.unref();
    });
    const run = Promise.resolve(spawnInvestigation({ ...args, signal: controller.signal }))
      .catch((e) => ({ verdict: 'ERROR', summary: firstLine(e.message) }));
    const res = await Promise.race([run, timeout]);
    if (timeoutHandle) clearTimeoutFn(timeoutHandle);
    return res || { verdict: 'ERROR', summary: 'no verdict' };
  }

  function finishInvestigation(change, result) {
    const prev = state[change.key] || {};
    const phases = [...(prev.pingedPhases || [])];
    const verdict = String((result?.verdict) || 'ERROR').toUpperCase();
    const completedAt = now();
    const kind = VERDICT_PING_KIND[verdict];
    if (kind) {
      pingOnce(kind, { ...pingContext(change), summary: result?.summary }, phases);
    }
    state[change.key] = core.nextState(prev, change.issue, {
      verdict,
      summaryLine: core.summaryLineFromReportText(result?.summary),
      at: completedAt,
      inFlight: false,
      pingedPhases: phases,
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
    }));
    return persist();
  }

  function currentInvestigations() {
    return core.unarchivedInvestigations(state[core.INVESTIGATIONS_KEY]);
  }

  /*
   * Operator-driven archive of one inbox record. Purely a state edit: nothing is polled, nothing is
   * written to PostHog, and the record stays in the log (archived) rather than being deleted, so the
   * cap keeps behaving as a plain newest-N window.
   */
  async function archiveInvestigation(id) {
    const ref = core.validateInvestigationId(id);
    if (!ref.ok) return { ok: false, error: ref.error };
    const res = core.markInvestigationArchived(state[core.INVESTIGATIONS_KEY], ref.id);
    if (!res.ok) return { ok: false, error: res.error };
    state[core.INVESTIGATIONS_KEY] = res.log;
    await persist();
    return { ok: true, investigations: currentInvestigations() };
  }

  async function runInvestigation(change) {
    try {
      const res = await spawnWithTimeout({
        key: change.key,
        issue: change.issue,
        projectId: change.projectId,
        projectName: change.projectName,
        host,
        url: change.url,
        timeoutMs: investigationTimeoutSeconds * 1000,
      });
      await finishInvestigation(change, res);
    } catch (e) {
      await finishInvestigation(change, { verdict: 'ERROR', summary: firstLine(e.message) });
    }
  }

  // Mark an issue in-flight and launch its investigation, tracked so stop() drains it. Shared by the
  // tick's planned investigations and the operator's manual re-investigation, so both take the same
  // concurrency slot, the same never-rejecting tracking promise, and the same state bookkeeping.
  function startInvestigation(change) {
    state[change.key].inFlight = true;
    const investigation = runInvestigation(change).catch((e) => {
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
      log.warn(`[posthog-poller] issue query failed for ${projectName}: ${(issuesRes?.error) || 'no response'}`);
      return null;
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

    lastIssuesByProject.set(String(projectId), {
      projectName,
      byId: new Map(changes.map((change) => [String(change.issue.issueId), change])),
    });

    reconcileVanished(core.issueKey(host, projectId, ''), new Set(changes.map((c) => c.key)), tickStartedAt);

    for (const change of changes) {
      const prev = state[change.key] || {};
      const phases = [...(prev.pingedPhases || [])];
      const observation = OBSERVATION_PINGS[change.change];
      if (observation?.dedupe) pingOnce(observation.kind, pingContext(change), phases);
      if (observation && !observation.dedupe) pingAlways(observation.kind, pingContext(change));
      // A brand-new issue already over the escalation threshold is worth a ping before any
      // investigation finishes: the operator should not wait ~15 minutes to learn it exists.
      if (change.change === 'new' && !prev.verdict && change.issue.users >= userEscalationThreshold) {
        pingOnce('new_high_impact', pingContext(change), phases);
      }
      state[change.key] = core.nextState(prev, change.issue, {
        observedAt: tickStartedAt,
        inFlight: prev.inFlight === true,
        pingedPhases: phases,
      });
    }

    let slots = maxConcurrentInvestigations - inFlightCount();
    const planned = core.planInvestigations(changes, state, {
      minUsersToInvestigate, userEscalationThreshold,
    });
    for (const change of planned) {
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
        projects: summaries,
        investigations: currentInvestigations(),
      });
    } finally {
      tickRunning = false;
    }
  }

  /*
   * Operator-driven re-investigation of one issue, from a Radar row. Deliberately bypasses
   * core.planInvestigations (an explicit click IS the plan: the whole point is re-running an issue
   * whose head and verdict have not moved) but keeps every other guarantee of the automatic path -
   * the same spawn, the same concurrency cap, the same in-flight bookkeeping and result plumbing.
   * Refuses rather than queues: a second click while one is running would double-spend a slot.
   */
  function investigateNow({ projectId, issueId }) {
    if (stopped) return { ok: false, error: 'PostHog monitoring is stopping' };
    const key = core.issueKey(host, projectId, issueId);
    if (state[key]?.inFlight) {
      return { ok: false, error: 'An investigation is already running for this issue' };
    }
    if (inFlightCount() >= maxConcurrentInvestigations) {
      return { ok: false, error: 'All investigation slots are busy; try again shortly' };
    }
    const known = lastIssuesByProject.get(String(projectId));
    const change = known?.byId.get(String(issueId));
    if (!change) return { ok: false, error: 'That issue is not in the latest poll' };
    state[key] = core.nextState(state[key] || {}, change.issue, {
      inFlight: true, pingedPhases: [...(state[key]?.pingedPhases || [])],
    });
    startInvestigation(change);
    return { ok: true };
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
    start, stop, tick, investigateNow, archiveInvestigation,
    investigations: currentInvestigations,
    _state: () => state,
  };
}

module.exports = { createPosthogPoller };
