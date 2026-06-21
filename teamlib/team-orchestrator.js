'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { runFolderLabel, escapeRegExp } = require('./team-output');

// Team run engine. Glissa drives each stage as one short-lived `claude -p` session, gating on the
// handoff file between stages. Completion is keyed on the session's `exit` event (exit 0 => DONE),
// which the Phase-0 probe confirmed for `claude -p` in node-pty - NOT on the Stop hook. See
// .omc/plans/marketing-team-pipeline.md sections 3.4 and 3.10.
//
// All side-effecting collaborators are injected so the full stage loop is testable with a fake
// session spawner (no real Claude). Production wiring lives in backend.js.

// Local-time YYYY-MM-DD-weekday run label, shared with team-output (used for both the run folder and
// the git worktree branch name).
const defaultRunLabel = runFolderLabel;

// Parse the editor VERDICT line. Returns the matched value (e.g. "SHIP") or null.
function parseVerdict(text, verdictSpec) {
  if (!text || !verdictSpec) return null;
  const marker = verdictSpec.marker || 'VERDICT:';
  const values = verdictSpec.values || ['SHIP', 'FIX', 'BLOCK'];
  const re = new RegExp(`${escapeRegExp(marker)}\\s*([A-Z]+)`, 'i');
  const m = re.exec(text);
  if (!m) return null;
  const found = m[1].toUpperCase();
  return values.includes(found) ? found : null;
}

// Detect an operator-question sentinel: the agent wrote the marker as the ENTIRE output (the QUESTION
// protocol in team-prompt) instead of a normal handoff. Returns the trimmed question text, or null.
// Matching at the START of the output (not as a substring) avoids a false positive from a handoff that
// merely mentions the word.
function extractQuestion(text, marker = 'QUESTION:') {
  const t = String(text || '').trim();
  const m = String(marker || 'QUESTION:');
  if (t.length < m.length) return null;
  if (t.slice(0, m.length).toUpperCase() !== m.toUpperCase()) return null;
  return t.slice(m.length).trim() || '(no question text)';
}

// First non-empty content line under a markdown heading (used for the log line's topic/platforms).
function sectionFirstLine(text, heading) {
  if (!text) return '';
  const esc = escapeRegExp(heading);
  const re = new RegExp(`^#{1,6}\\s*${esc}\\b.*$`, 'im');
  const m = re.exec(text);
  if (!m) return '';
  const rest = text.slice(m.index + m[0].length).split(/\r?\n/);
  for (const line of rest) {
    const t = line.trim().replace(/^[-*]\s*/, '');
    if (t && !/^#{1,6}\s/.test(t)) return t;
  }
  return '';
}

// Clamp a logged field to one tidy segment: drop the pipe delimiter, collapse to a single line, and
// cap length so log.md stays one scannable line per run even when an agent writes a paragraph.
function clip(value, max = 100) {
  const t = String(value || '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}...` : t;
}

// Format the run-log verdict field to reflect the revise-loop outcome. Pure.
//   - first pass (rounds 0): the bare verdict, no suffix ("SHIP" / "BLOCK" / "FIX").
//   - converged after N rounds: "FIX->SHIP (1 round)" / "FIX->SHIP (2 rounds)".
//   - no-progress early bail: "FIX (no-progress, round 1)".
//   - budget exhausted: "FIX (maxRounds 2)".
function formatRunVerdict({
  verdict, initialVerdict, rounds = 0, noProgress = false, maxRounds = 0,
} = {}) {
  if (!rounds) return verdict || 'DONE';
  const plural = rounds === 1 ? 'round' : 'rounds';
  if (noProgress) return `${verdict} (no-progress, round ${rounds})`;
  if (verdict !== initialVerdict) return `${initialVerdict}->${verdict} (${rounds} ${plural})`;
  // Still the trigger verdict after spending the budget.
  return `${verdict} (maxRounds ${maxRounds || rounds})`;
}

function createOrchestrator(deps) {
  const {
    loadTeam,
    getProjectPath,
    output,
    buildStagePrompt,
    buildStageSpawnOptions,
    teamPermissions,
    spawnGate,
    makeStageSession,
    gitWorkspace = null,
    // App-runtime worktree wiring (injected by backend). worktreeShare is the gitignored local context
    // to bring into a run worktree (node_modules, .env*, .claude, .omc); getWorktreeBase(projectPath)
    // returns the stable per-project worktree root. Both consumed ONLY when a team opts in via
    // runtime.shareLocalContext, so file-in/file-out teams keep their bare temp-dir worktree.
    worktreeShare = null,
    getWorktreeBase = null,
    now = () => new Date(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    readFile = (p) => fs.readFileSync(p, 'utf8'),
    runLabel = defaultRunLabel,
    // Lifecycle logging. Default writes a `[team] ...` line to the server console (matching the
    // `[control]`/`[session]` prefixes elsewhere); injectable so tests can silence it.
    log = (msg) => console.log(`[team] ${msg}`),
  } = deps;

  const emitter = new EventEmitter();
  // lockKey -> live run state. `cancelled` drives the loop's exit; `cancelling` drives the UI state
  // and survives a dashboard tab re-mount via getRunState(). currentStage/stageStartedAtMs let a
  // re-mounting (or second) client rehydrate the live pipeline and a continuous elapsed timer instead
  // of resetting to a blank rail and a zeroed clock.
  const active = new Map();

  function readText(p) {
    try {
      return readFile(p);
    } catch {
      return '';
    }
  }

  // Append one conversation turn to the run's chat.md and broadcast it. `entry` is the live run state
  // (for runDir); role is 'operator' or 'agent'. Best-effort: a transcript write failure never breaks a
  // run. Returns the stored entry.
  function recordChat(entry, teamId, projectId, role, stage, text) {
    let stored = {
      role, stage: stage || null, ts: now().toISOString(), text: String(text == null ? '' : text),
    };
    if (entry?.runDir) {
      try { stored = output.appendChat(entry.runDir, stored); } catch { /* best-effort transcript */ }
    }
    emitter.emit('team-chat-message', { teamId, projectId, ...stored });
    return stored;
  }

  // Spawn one stage and resolve when its process exits (exit 0 = success), it errors, or it times out.
  // This NEVER rejects. Two failure modes are funnelled into a clean { ok:false, reason:'spawn-error' }:
  //   (1) a SYNCHRONOUS throw while building the spawn options or constructing the stage session, and
  //   (2) an ASYNC rejection from Session.start() (which is async and was previously called
  //       fire-and-forget). start() does its worktree provision, hook-settings write, and spawn-command
  //       build BEFORE the guarded pty.spawn; a throw in any of those rejects start(). An unhandled
  //       rejection there crashes the whole server under Node's default - and on a team run it killed the
  //       run mid-stage, leaving the run branch behind with nothing committed and NO project-visible
  //       record (the empty `glissa/marketing/2026-06-20-saturday` stub). Catching it fails the stage
  //       cleanly so the normal failTerminal -> appendLog -> integrate path records and cleans up the run.
  function runStage({ team, stage, runId, projectPath, prompt, lockKey }) {
    return spawnGate.run(() => new Promise((resolve) => {
      const entry = active.get(lockKey);
      let session = null;
      let settled = false;
      let timer = null;

      function finish(ok, reason, exitCode) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeoutFn(timer);
        try { if (session) session.destroy(); } catch { /* best-effort */ }
        if (entry) entry.session = null;
        resolve({ ok, reason, exitCode });
      }

      try {
        const spawnOptions = buildStageSpawnOptions(team, stage);
        session = makeStageSession({
          id: `team:${runId}:${stage.id}`,
          name: `${team.id}/${stage.id}`,
          path: projectPath,
          initialPrompt: prompt,
          spawnOptions,
          permissions: teamPermissions(team),
        });
        if (entry) entry.session = session;

        timer = setTimeoutFn(() => finish(false, 'timeout'), (team.stageTimeoutSeconds || 900) * 1000);
        if (timer && typeof timer.unref === 'function') timer.unref();

        session.on('exit', ({ exitCode }) => finish(exitCode === 0, exitCode === 0 ? null : 'nonzero-exit', exitCode));
        session.on('error', () => finish(false, 'spawn-error'));
        // start() is async: a rejection (failed worktree provision, hook-settings write, spawn-command
        // build) would otherwise escape as an unhandled rejection and never settle this stage. Promise.resolve
        // wraps a sync-returning fake (tests) and a real async start() alike.
        Promise.resolve(session.start()).catch(() => finish(false, 'spawn-error'));
      } catch {
        finish(false, 'spawn-error');
      }
    }));
  }

  // Drive a full team run. trigger: 'manual' | 'scheduled'. Each run executes in an isolated git
  // worktree on a dedicated branch (when the project is a git repo); on a terminal outcome the run is
  // committed and fast-forwarded back to the base branch, so the user's working tree is never dirtied
  // mid-run. A cancelled run throws its worktree away; a non-git project runs in place.
  async function runTeam({ teamId, projectId, trigger = 'manual' }) {
    const lockKey = `${teamId}:${projectId}`;
    const team = loadTeam(teamId);
    const projectPath = getProjectPath(projectId);
    if (!projectPath) {
      throw new Error(`No project path for projectId "${projectId}"`);
    }
    const dateStr = (() => {
      const d = now();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();

    if (active.has(lockKey)) {
      output.ensureStructure(projectPath, team.outputPath);
      output.appendLog(projectPath, team.outputPath, `${dateStr} | (skipped) | - | SKIPPED (active run)`);
      log(`run skipped (already active): ${lockKey}`);
      emitter.emit('team-run-skipped', { teamId, projectId });
      return { skipped: true };
    }
    // Interactive chat is scoped to manual runs: a scheduled/unattended run never injects the QUESTION
    // protocol and never blocks for an operator (see the QUESTION handling in runOneStage).
    const chatCfg = team.chat || {
      allowQuestions: false, questionMarker: 'QUESTION:', maxQuestions: 3, answerTimeoutSec: 600,
    };
    const interactive = !!chatCfg.allowQuestions && trigger === 'manual';
    active.set(lockKey, {
      cancelled: false, cancelling: false, session: null,
      runId: '', runStartedAtMs: 0, currentStage: null, stageStartedAtMs: 0,
      interactive, chatCfg, runDir: '',
      awaiting: false, pendingQuestion: null, awaitResolve: null, awaitTimer: null, questionsAsked: 0,
    });
    log(`run requested: ${lockKey} (trigger=${trigger})`);

    let workspace = { cwd: projectPath, isGit: false };
    let runId = '';
    let verdict = null;
    let finalized = false;

    // Commit + fast-forward the run back to the base branch, or (on cancel / no run produced) throw the
    // worktree away. Runs at most once; in-place (non-git) runs are a no-op.
    const finalize = async (mode) => {
      const fallback = { branch: workspace.branch || null, base: workspace.base || null, merged: false };
      if (finalized || !gitWorkspace || !workspace.isGit) return fallback;
      finalized = true;
      try {
        if (mode === 'discard' || !runId) {
          await gitWorkspace.discard({ projectPath, workspace });
          return { branch: null, base: workspace.base || null, merged: false };
        }
        const message = `${team.id}: ${runId}${verdict ? ` (${verdict})` : ''}`;
        // SHIP-gate the auto-merge boundary: only a final SHIP stages the team's writeScope (source);
        // a FIX/BLOCK/failed/halt run (and the finally integrate) stages ONLY the run folder + log, so
        // no partial or red source merges. Marketing's writeScope is [] -> byte-identical addPaths.
        const addPaths = [
          `${team.outputPath}/runs/${runId}`,
          `${team.outputPath}/log.md`,
          ...(verdict === 'SHIP' ? (team.writeScope || []) : []),
        ];
        return (await gitWorkspace.integrate({ projectPath, workspace, message, addPaths })) || fallback;
      } catch (err) {
        return { ...fallback, reason: err.message };
      }
    };

    try {
      // First-run setup gate (main repo): glissa owns the agents; the project owns the pack (voice,
      // brand, calendar, channels). Scaffold it from the team's templates (idempotent) and halt until
      // filled, so a run never produces output from empty voice rules. team-git copies the pack into the
      // worktree at run time. This runs before any worktree is created.
      output.ensureStructure(projectPath, team.outputPath);
      const scaffolded = output.scaffoldPack(
        projectPath, team.outputPath, team.packTemplatesDir, team.packRequired,
        team.packTemplatesFallbackDir, team.packShared,
      );
      // Surface shared-pack migration so a promotion (and especially an abandoned divergent copy) is
      // discoverable in the run log rather than silent.
      for (const p of (scaffolded.promoted || [])) log(`pack promote: ${p.name} (from ${p.from})`);
      for (const d of (scaffolded.divergent || [])) {
        log(`pack divergent: ${d.name} (team-local copy at ${d.teamLocalPath} differs from shared, left for manual reconcile)`);
      }
      const pack = output.packStatus(projectPath, team.outputPath, team.packRequired, team.packShared);
      if (!pack.configured) {
        output.appendLog(projectPath, team.outputPath, `${dateStr} | (setup) | - | NEEDS_SETUP (${pack.unfilled.join(', ')})`);
        log(`run halted: ${lockKey} needs pack setup (${pack.unfilled.join(', ')})`);
        emitter.emit('team-run-needs-setup', {
          teamId, projectId, packDir: pack.packDir, unfilled: pack.unfilled,
        });
        return { needsSetup: true, unfilled: pack.unfilled };
      }

      // A team that pins a base branch REQUIRES git isolation off it: never silently run in the
      // operator's checkout on the wrong branch. Surface a project-visible BLOCK. No worktree exists in
      // any of these cases, so the finally's finalize is a no-op. `detail` carries the specific cause so
      // a transient create failure is not misreported as "not a git repo".
      const blockRun = (why) => {
        output.appendLog(projectPath, team.outputPath, `${dateStr} | (setup) | - | BLOCKED (${why})`);
        log(`run blocked: ${lockKey} (${why})`);
        emitter.emit('team-run-failed', { teamId, projectId, reason: 'no-base-branch', detail: why });
        return { blocked: true, reason: why };
      };
      // baseBranch needs the isolation engine to fork off the branch; without it the run would fall
      // through to an in-place run on the wrong branch. Block before attempting anything.
      if (team.runtime?.baseBranch && !gitWorkspace) {
        return blockRun(`base branch "${team.runtime.baseBranch}" pinned but git isolation is unavailable`);
      }

      if (gitWorkspace) {
        const runtime = team.runtime || {};
        const createOpts = {
          projectPath, teamId: team.id, label: runLabel(now()), outputPath: team.outputPath,
        };
        // App-runtime teams (e.g. the persona QA walk) opt in to a worktree that carries the project's
        // gitignored local context (so the agent can actually boot the app) and to a pinned base branch
        // (so the run forks from the branch holding the walk inputs, not the operator's current HEAD).
        if (runtime.shareLocalContext) {
          if (worktreeShare) createOpts.shareList = worktreeShare;
          if (getWorktreeBase) createOpts.worktreeBase = getWorktreeBase(projectPath);
        }
        if (runtime.baseBranch) createOpts.baseBranch = runtime.baseBranch;
        try {
          workspace = (await gitWorkspace.create(createOpts)) || { cwd: projectPath, isGit: false };
        } catch (err) {
          // Preserve the cause so the BLOCK below reports the real failure, not a misleading default.
          workspace = { cwd: projectPath, isGit: false, reason: 'create-failed', detail: err?.message };
        }
        if (runtime.baseBranch && !workspace.isGit) {
          if (workspace.reason === 'no-base-branch') return blockRun(`base branch "${runtime.baseBranch}" not found`);
          if (workspace.reason === 'create-failed') return blockRun(`worktree create failed (${workspace.detail || 'unknown error'})`);
          return blockRun('project is not a git repo');
        }
      }
      const cwd = workspace.cwd;

      output.ensureStructure(cwd, team.outputPath);
      const runDir = output.createRunFolder(cwd, team.outputPath, runLabel(now()));
      runId = path.basename(runDir);
      // Shared-aware pack list for the worktree: shared files resolve under <cwd>/.glissa/pack/ (copied in
      // by team-git), the rest under the team-local pack. buildStagePrompt consumes the flat {name,path} list.
      const { packDir, files: packFiles } = output.resolvePackLayout(
        cwd, team.outputPath, team.packRequired, team.packShared,
      );
      const runEntry = active.get(lockKey);
      if (runEntry) { runEntry.runId = runId; runEntry.runStartedAtMs = now().getTime(); runEntry.runDir = runDir; }
      log(`run started: ${lockKey} runId=${runId}${workspace.branch ? ` branch=${workspace.branch}` : ''}`);
      emitter.emit('team-run-started', { teamId, projectId, runId, runDir, trigger, branch: workspace.branch || null });

      const topicRef = { value: '' };
      const platformsRef = { value: '' };

      // One stage attempt (linear pass uses round 0; the revise loop uses round N >= 1). Round-0
      // behavior is byte-identical to the original inline body; only the reads union and the round
      // field on the events differ for N >= 1. Returns { terminal } when the run must early-return
      // (the caller returns that value verbatim) or { ok: true, verdict, produced } on success.
      const runOneStage = async ({ stage, round = 0 }) => {
        const topic = () => topicRef.value;
        const platforms = () => platformsRef.value;
        // Restore-before-audit: before EVERY auditor invocation (the linear pass AND each re-audit in the
        // revise loop), restore the tests in the worktree to the run's base SHA, so the auditor grades the
        // SOURCE against the unedited oracle. A fixer that "greened" the suite by editing/adding a test has
        // that edit reverted, so the suite is red again here and the verdict is FIX/BLOCK (nothing merges).
        // Gated on the stage being the verdict stage AND the team opting in via writeScope + testGlobs, so
        // marketing (writeScope []) and any non-verdict stage never trigger it: byte-identical behavior.
        if (stage.verdict && gitWorkspace && workspace.isGit
          && team.writeScope.length && team.testGlobs.length) {
          await gitWorkspace.restoreTests({ workspace, testGlobs: team.testGlobs });
        }
        if (active.get(lockKey).cancelled) {
          output.appendLog(cwd, team.outputPath, `${dateStr} | ${topic() || '(topic)'} | ${platforms() || '-'} | CANCELLED`);
          log(`run cancelled: ${lockKey} before stage ${stage.id}`);
          await finalize('discard');
          emitter.emit('team-run-failed', { teamId, projectId, reason: 'cancelled', stage: stage.id });
          return { terminal: { cancelled: true, stage: stage.id } };
        }

        // Reads = stage.reads UNION (round > 0 ? stage.reviseReads : []), de-duplicated by name.
        const readNames = [...(stage.reads || [])];
        if (round > 0) {
          for (const name of (stage.reviseReads || [])) {
            if (!readNames.includes(name)) readNames.push(name);
          }
        }
        const produces = { name: stage.produces, path: path.join(runDir, stage.produces) };
        const stageEntry = active.get(lockKey);
        const interactive = !!stageEntry?.interactive;
        const chatCfg = stageEntry?.chatCfg || {};
        const marker = chatCfg.questionMarker || 'QUESTION:';

        // CANCELLED terminal, shared by the cancel checks after a spawn or after an awaited question.
        const cancelledTerminal = async () => {
          output.appendLog(cwd, team.outputPath, `${dateStr} | ${topic() || '(topic)'} | ${platforms() || '-'} | CANCELLED`);
          log(`run cancelled: ${lockKey} at stage ${stage.id}`);
          await finalize('discard');
          emitter.emit('team-run-failed', { teamId, projectId, reason: 'cancelled', stage: stage.id });
          return { terminal: { cancelled: true, stage: stage.id } };
        };
        // FAILED terminal, shared by the spawn-failure and question-loop bailouts. The canonical run-log
        // tag is `FAILED @stage (reason)`; needs-operator overrides the tag and the debug verb.
        const failTerminal = (reason, logTag = `FAILED @${stage.id} (${reason})`, verb = 'failed') => {
          output.appendLog(cwd, team.outputPath, `${dateStr} | ${topic() || '(topic)'} | ${platforms() || '-'} | ${logTag}`);
          log(`run ${verb}: ${lockKey} at stage ${stage.id} (${reason})`);
          emitter.emit('team-run-failed', { teamId, projectId, reason, stage: stage.id });
          return { terminal: { failedStage: stage.id, reason } };
        };

        if (stageEntry) { stageEntry.currentStage = stage.id; stageEntry.stageStartedAtMs = now().getTime(); }
        log(`stage start: ${lockKey} ${stage.id} (${stage.model || 'sonnet'})${round ? ` round=${round}` : ''}`);
        emitter.emit('team-stage-started', { teamId, projectId, runId, stage: stage.id, round });

        // Spawn the stage, then (interactive runs only) pause if it emitted the QUESTION marker and re-run
        // with the operator's answer once it lands in chat.md. A normal stage runs the body exactly once.
        let produced = '';
        let lastQuestionOutput = null;
        for (;;) {
          const reads = readNames.map((name) => ({ name, path: path.join(runDir, name) }));
          // Inject the operator conversation when it exists and is non-empty, so a run nobody has spoken in
          // produces byte-identical prompts to before this feature (and scheduled runs never see it).
          let chatRead = null;
          const cp = output.chatPath(runDir);
          if (fs.existsSync(cp) && readText(cp).trim()) chatRead = { name: 'chat.md', path: cp };
          const prompt = buildStagePrompt(readText(stage.agentPath), {
            runDir, packDir, packFiles, reads, produces, chat: chatRead, allowQuestions: interactive,
          });

          const result = await runStage({ team, stage, runId, projectPath: cwd, prompt, lockKey });
          if (active.get(lockKey).cancelled) return cancelledTerminal();
          if (!result.ok) return failTerminal(result.reason);

          produced = readText(produces.path);
          const question = extractQuestion(produced, marker);
          if (!question) break; // normal handoff: fall through to the halt/section gates below

          if (!interactive) {
            // Scheduled / opt-out: never block on a human. A stray question becomes a needs-operator halt.
            return failTerminal('needs-operator', `NEEDS_OPERATOR @${stage.id}`, 'halted');
          }
          // No-progress guard: the agent re-asked an identical question after being answered.
          if (lastQuestionOutput !== null && produced === lastQuestionOutput) return failTerminal('question-no-progress');
          const entry = active.get(lockKey);
          // questionsAsked is a RUN-WIDE budget (not reset between stages), so a multi-stage run cannot
          // pepper the operator with maxQuestions per stage.
          entry.questionsAsked += 1;
          if (entry.questionsAsked > (chatCfg.maxQuestions || 3)) return failTerminal('question-budget');

          // Surface the question and wait for the operator (postMessage), a timeout, or a cancel.
          recordChat(entry, teamId, projectId, 'agent', stage.id, question);
          entry.awaiting = true;
          entry.pendingQuestion = question;
          emitter.emit('team-run-awaiting-input', { teamId, projectId, runId, stage: stage.id, question });
          log(`run awaiting operator: ${lockKey} at stage ${stage.id}`);

          const outcome = await new Promise((resolve) => {
            entry.awaitResolve = resolve;
            const t = setTimeoutFn(() => resolve({ timedOut: true }), (chatCfg.answerTimeoutSec || 600) * 1000);
            if (t && typeof t.unref === 'function') t.unref();
            entry.awaitTimer = t;
          });
          clearTimeoutFn(entry.awaitTimer);
          entry.awaitTimer = null;
          entry.awaitResolve = null;
          entry.awaiting = false;
          entry.pendingQuestion = null;

          if (active.get(lockKey).cancelled || outcome.cancelled) return cancelledTerminal();
          if (outcome.timedOut) return failTerminal('answer-timeout');
          // Answered: re-run this stage with the answer now present in chat.md.
          emitter.emit('team-run-resumed', { teamId, projectId, runId, stage: stage.id });
          log(`run resumed: ${lockKey} at stage ${stage.id}`);
          lastQuestionOutput = produced;
        }
        // Researcher halt signal (e.g. INSUFFICIENT_TOPICS) is checked BEFORE section verification:
        // a halt brief legitimately omits the normal sections.
        if (stage.haltSignal && produced.includes(stage.haltSignal)) {
          output.appendLog(cwd, team.outputPath, `${dateStr} | (none) | - | HALT (${stage.haltSignal})`);
          log(`run halted: ${lockKey} at stage ${stage.id} (${stage.haltSignal})`);
          emitter.emit('team-run-failed', { teamId, projectId, reason: 'halt', stage: stage.id, signal: stage.haltSignal });
          return { terminal: { halted: stage.haltSignal, stage: stage.id } };
        }

        // Gate on the handoff file: it must exist with its required sections.
        const check = output.verifyHandoff(produces.path, stage.requiredSections || []);
        if (!check.ok) {
          output.appendLog(cwd, team.outputPath, `${dateStr} | ${topic() || '(topic)'} | ${platforms() || '-'} | FAILED @${stage.id} (missing: ${check.missing.join(', ')})`);
          log(`run failed: ${lockKey} at stage ${stage.id} (incomplete handoff, missing: ${check.missing.join(', ')})`);
          emitter.emit('team-run-failed', { teamId, projectId, reason: 'incomplete-handoff', stage: stage.id, missing: check.missing });
          return { terminal: { failedStage: stage.id, missing: check.missing } };
        }
        if (stage.id === 'researcher') topicRef.value = clip(sectionFirstLine(produced, 'Topic')) || topicRef.value;
        if (stage.id === 'strategist') platformsRef.value = clip(sectionFirstLine(produced, 'Platforms')) || platformsRef.value;
        let stageVerdict = null;
        if (stage.verdict) { stageVerdict = parseVerdict(produced, stage.verdict); verdict = stageVerdict; }

        log(`stage complete: ${lockKey} ${stage.id}${stageVerdict ? ` verdict=${stageVerdict}` : ''}${round ? ` round=${round}` : ''}`);
        emitter.emit('team-stage-complete', {
          teamId, projectId, runId, stage: stage.id, verdict: stageVerdict, round,
        });
        return { ok: true, verdict: stageVerdict, produced };
      };

      let rounds = 0;
      let reviseLogVerdict = null;

      for (const stage of team.stages) {
        // Publisher (and any conditional stage) runs only when the editor verdict matches.
        if (stage.runIfVerdict && verdict !== stage.runIfVerdict) continue;

        const linear = await runOneStage({ stage, round: 0 });
        if (linear.terminal) return linear.terminal;

        // Bounded FIX revision loop: after a verdict stage whose verdict triggers revise, re-run the
        // earlier revise.stages then re-audit, bounded by maxRounds, with a byte-identical no-progress
        // guard. The publisher still reads the final post-loop `verdict` through the :219 gate above.
        if (stage.revise && verdict === stage.revise.onVerdict) {
          const initialVerdict = verdict;
          const maxRounds = stage.revise.maxRounds || 2;
          const reviseStages = stage.revise.stages
            .map((id) => team.stages.find((s) => s.id === id))
            .filter(Boolean);
          let noProgress = false;

          for (let n = 1; n <= maxRounds; n += 1) {
            emitter.emit('team-revise-round', {
              teamId, projectId, runId, round: n, fromVerdict: verdict,
            });
            // Archive the round we are about to overwrite (the revise stages' outputs + the verdict
            // stage's output) into rounds/r{n-1}-<name> before re-running.
            const archiveNames = [...reviseStages.map((s) => s.produces), stage.produces];
            output.archiveRoundArtifacts(runDir, n - 1, archiveNames);
            const archivedBefore = reviseStages.map((s) => ({
              produces: s.produces,
              prior: readText(path.join(runDir, 'rounds', `r${n - 1}-${s.produces}`)),
            }));

            // Re-run each revise stage (in order) at round n.
            let reviseTerminal = null;
            for (const reviseStage of reviseStages) {
              const r = await runOneStage({ stage: reviseStage, round: n });
              if (r.terminal) { reviseTerminal = r.terminal; break; }
            }
            if (reviseTerminal) return reviseTerminal;

            // No-progress guard: if EVERY revise stage's new output is byte-identical to its just
            // archived prior copy, the loop cannot converge by re-running, so skip the re-audit, exit
            // with the verdict unchanged, and record the reason.
            const allIdentical = archivedBefore.every(
              (a) => readText(path.join(runDir, a.produces)) === a.prior,
            );
            if (allIdentical) {
              noProgress = true;
              rounds = n;
              break;
            }

            // Re-audit: re-run the verdict stage at round n and recompute the verdict.
            const audit = await runOneStage({ stage, round: n });
            if (audit.terminal) return audit.terminal;
            verdict = parseVerdict(audit.produced, stage.verdict);
            rounds = n;

            if (verdict !== stage.revise.onVerdict) break; // SHIP / BLOCK: converged or hard stop.
            // Still the trigger verdict: continue if budget remains, else break (maxRounds reached).
          }

          // Reflect the loop outcome in the log line written after the stage loop completes.
          reviseLogVerdict = formatRunVerdict({
            verdict, initialVerdict, rounds, noProgress, maxRounds,
          });
        }
      }

      const topic = topicRef.value;
      const platforms = platformsRef.value;
      output.appendLog(cwd, team.outputPath, `${dateStr} | ${topic || '(topic)'} | ${platforms || '-'} | ${reviseLogVerdict || verdict || 'DONE'}`);
      const integ = await finalize('integrate');
      log(`run complete: ${lockKey} runId=${runId} verdict=${verdict || 'DONE'}${integ.merged ? ' (merged)' : ''}`);
      emitter.emit('team-run-complete', { teamId, projectId, runId, runDir, verdict, rounds, branch: integ.branch, base: integ.base, merged: integ.merged });
      return { ok: true, verdict, runDir, rounds, branch: integ.branch, merged: integ.merged };
    } catch (err) {
      // Backstop for any UNEXPECTED throw in the run (an fs error building the run folder/prompt, a bad
      // event listener, a stage fault that surfaced synchronously). Before this guard such a throw unwound
      // SILENTLY: no project-visible record and, on a git project, an empty leaked branch. Record it where
      // the run can see it - the worktree log when one exists (the finally's integrate commits + FF-merges
      // it back), else the project log - and surface a team-run-failed (backend re-broadcasts it to the
      // dashboard + notifies). Resolve with { error } rather than rejecting, so the call-site .catch does
      // not ALSO broadcast a duplicate failure. The finally still finalizes the workspace exactly as before.
      const reason = (err && err.message) ? err.message : String(err);
      try {
        const logTarget = (workspace.isGit && workspace.cwd) ? workspace.cwd : projectPath;
        output.appendLog(logTarget, team.outputPath,
          `${dateStr} | (error) | - | FAILED${runId ? ` @run ${runId}` : ''} (${clip(reason, 80)})`);
      } catch { /* best-effort: never mask the original error with a logging failure */ }
      log(`run errored: ${lockKey}${runId ? ` runId=${runId}` : ''} (${reason})`);
      emitter.emit('team-run-failed', { teamId, projectId, reason: 'error', error: reason });
      return { error: reason };
    } finally {
      active.delete(lockKey);
      // Failure / halt paths fall through here: commit + fast-forward them too, so the run is captured
      // and the working tree stays clean. The success and cancel paths already finalized above.
      if (!finalized) await finalize('integrate');
    }
  }

  function cancelRun(teamId, projectId) {
    const lockKey = `${teamId}:${projectId}`;
    const entry = active.get(lockKey);
    if (!entry) return false;
    entry.cancelled = true;
    entry.cancelling = true;
    log(`cancel requested: ${lockKey}${entry.currentStage ? ` (stage ${entry.currentStage})` : ''}`);
    // Signal every client (and a re-mounting tab, via getRunState) to show "Cancelling...".
    emitter.emit('team-run-cancelling', { teamId, projectId, stage: entry.currentStage || null });
    // If the run is paused awaiting an operator answer (no live stage process), unblock the await so the
    // cancel settles the run promptly instead of hanging until the answer timeout.
    if (entry.awaitResolve) {
      const resolve = entry.awaitResolve;
      entry.awaitResolve = null;
      resolve({ cancelled: true });
    }
    if (entry.session) {
      // Use kill() (process-tree teardown that KEEPS listeners), NOT destroy(): destroy() calls
      // removeAllListeners(), which strips the 'exit' handler runStage installed to resolve the stage.
      // With kill(), the PTY 'exit' still reaches that handler, so the stage settles and the run ends
      // promptly as cancelled instead of hanging until the stage timeout. runStage's finish() then
      // calls destroy() for full cleanup once the stage has settled.
      try { entry.session.kill(); } catch { /* best-effort */ }
    }
    return true;
  }

  // Post an operator message into the active run's conversation. Always records the turn (steering note);
  // when the run is paused awaiting an answer, the message resolves the wait and the paused stage re-runs.
  function postMessage(teamId, projectId, text) {
    const entry = active.get(`${teamId}:${projectId}`);
    if (!entry) return { ok: false, reason: 'no-active-run' };
    recordChat(entry, teamId, projectId, 'operator', entry.currentStage, text);
    if (entry.awaiting && entry.awaitResolve) {
      const resolve = entry.awaitResolve;
      entry.awaitResolve = null;
      resolve({ answer: String(text == null ? '' : text) });
      return { ok: true, answered: true };
    }
    return { ok: true, answered: false };
  }

  function isActive(teamId, projectId) {
    return active.has(`${teamId}:${projectId}`);
  }

  // Live snapshot for a re-mounting or second dashboard client: which stage is active and when the
  // run + current stage started (so the elapsed timer stays continuous instead of resetting to 0),
  // plus whether a cancel is in flight. Returns null when no run is active.
  function getRunState(teamId, projectId) {
    const entry = active.get(`${teamId}:${projectId}`);
    if (!entry) return null;
    return {
      runId: entry.runId || null,
      currentStage: entry.currentStage || null,
      runStartedAtMs: entry.runStartedAtMs || 0,
      stageStartedAtMs: entry.stageStartedAtMs || 0,
      cancelling: !!entry.cancelling,
      awaiting: !!entry.awaiting,
      pendingQuestion: entry.pendingQuestion || null,
    };
  }

  emitter.runTeam = runTeam;
  emitter.cancelRun = cancelRun;
  emitter.postMessage = postMessage;
  emitter.isActive = isActive;
  emitter.getRunState = getRunState;
  emitter.activeCount = () => active.size;
  return emitter;
}

module.exports = {
  createOrchestrator, parseVerdict, extractQuestion, sectionFirstLine, formatRunVerdict, defaultRunLabel,
};
