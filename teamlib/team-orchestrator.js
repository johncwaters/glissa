'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { runFolderLabel, escapeRegExp } = require('./team-output');

// Team run engine. Glissa drives each stage as one short-lived `claude -p` session, gating on the
// handoff file between stages. Completion is keyed on the session's `exit` event (exit 0 => DONE),
// which the Phase-0 probe confirmed for `claude -p` in node-pty — NOT on the Stop hook. See
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
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
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

  // Spawn one stage and resolve when its process exits (exit 0 = success) or the stage times out.
  function runStage({ team, stage, runId, projectPath, prompt, lockKey }) {
    return spawnGate.run(() => new Promise((resolve) => {
      const spawnOptions = buildStageSpawnOptions(team, stage);
      const session = makeStageSession({
        id: `team:${runId}:${stage.id}`,
        name: `${team.id}/${stage.id}`,
        path: projectPath,
        initialPrompt: prompt,
        spawnOptions,
        permissions: teamPermissions(team),
      });
      const entry = active.get(lockKey);
      if (entry) entry.session = session;

      let settled = false;
      const timer = setTimeoutFn(() => finish(false, 'timeout'), (team.stageTimeoutSeconds || 900) * 1000);
      if (timer && typeof timer.unref === 'function') timer.unref();

      function finish(ok, reason, exitCode) {
        if (settled) return;
        settled = true;
        clearTimeoutFn(timer);
        try { session.destroy(); } catch { /* best-effort */ }
        if (entry) entry.session = null;
        resolve({ ok, reason, exitCode });
      }

      session.on('exit', ({ exitCode }) => finish(exitCode === 0, exitCode === 0 ? null : 'nonzero-exit', exitCode));
      session.on('error', () => finish(false, 'spawn-error'));
      session.start();
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
    active.set(lockKey, {
      cancelled: false, cancelling: false, session: null,
      runId: '', runStartedAtMs: 0, currentStage: null, stageStartedAtMs: 0,
    });
    log(`run requested: ${lockKey} (trigger=${trigger})`);

    let workspace = { cwd: projectPath, isGit: false };
    let runId = '';
    let verdict = null;
    let finalized = false;

    // Commit + fast-forward the run back to the base branch, or (on cancel / no run produced) throw the
    // worktree away. Runs at most once; in-place (non-git) runs are a no-op.
    const finalize = (mode) => {
      const fallback = { branch: workspace.branch || null, base: workspace.base || null, merged: false };
      if (finalized || !gitWorkspace || !workspace.isGit) return fallback;
      finalized = true;
      try {
        if (mode === 'discard' || !runId) {
          gitWorkspace.discard({ projectPath, workspace });
          return { branch: null, base: workspace.base || null, merged: false };
        }
        const message = `${team.id}: ${runId}${verdict ? ` (${verdict})` : ''}`;
        const addPaths = [`${team.outputPath}/runs/${runId}`, `${team.outputPath}/log.md`];
        return gitWorkspace.integrate({ projectPath, workspace, message, addPaths }) || fallback;
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
      output.scaffoldPack(projectPath, team.outputPath, team.packTemplatesDir, team.packRequired, team.packTemplatesFallbackDir);
      const pack = output.packStatus(projectPath, team.outputPath, team.packRequired);
      if (!pack.configured) {
        output.appendLog(projectPath, team.outputPath, `${dateStr} | (setup) | - | NEEDS_SETUP (${pack.unfilled.join(', ')})`);
        log(`run halted: ${lockKey} needs pack setup (${pack.unfilled.join(', ')})`);
        emitter.emit('team-run-needs-setup', {
          teamId, projectId, packDir: pack.packDir, unfilled: pack.unfilled,
        });
        return { needsSetup: true, unfilled: pack.unfilled };
      }

      if (gitWorkspace) {
        try {
          workspace = gitWorkspace.create({ projectPath, teamId: team.id, label: runLabel(now()), outputPath: team.outputPath })
            || { cwd: projectPath, isGit: false };
        } catch {
          workspace = { cwd: projectPath, isGit: false };
        }
      }
      const cwd = workspace.cwd;

      output.ensureStructure(cwd, team.outputPath);
      const runDir = output.createRunFolder(cwd, team.outputPath, runLabel(now()));
      runId = path.basename(runDir);
      const packDir = path.join(cwd, team.outputPath, 'pack');
      const packFiles = (team.packRequired || []).map((name) => ({ name, path: path.join(packDir, name) }));
      const runEntry = active.get(lockKey);
      if (runEntry) { runEntry.runId = runId; runEntry.runStartedAtMs = now().getTime(); }
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
        if (active.get(lockKey).cancelled) {
          output.appendLog(cwd, team.outputPath, `${dateStr} | ${topic() || '(topic)'} | ${platforms() || '-'} | CANCELLED`);
          log(`run cancelled: ${lockKey} before stage ${stage.id}`);
          finalize('discard');
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
        const reads = readNames.map((name) => ({ name, path: path.join(runDir, name) }));
        const produces = { name: stage.produces, path: path.join(runDir, stage.produces) };
        const prompt = buildStagePrompt(readText(stage.agentPath), {
          runDir, packDir, packFiles, reads, produces,
        });
        const stageEntry = active.get(lockKey);
        if (stageEntry) { stageEntry.currentStage = stage.id; stageEntry.stageStartedAtMs = now().getTime(); }
        log(`stage start: ${lockKey} ${stage.id} (${stage.model || 'sonnet'})${round ? ` round=${round}` : ''}`);
        emitter.emit('team-stage-started', { teamId, projectId, runId, stage: stage.id, round });

        const result = await runStage({ team, stage, runId, projectPath: cwd, prompt, lockKey });
        if (active.get(lockKey).cancelled) {
          output.appendLog(cwd, team.outputPath, `${dateStr} | ${topic() || '(topic)'} | ${platforms() || '-'} | CANCELLED`);
          log(`run cancelled: ${lockKey} at stage ${stage.id}`);
          finalize('discard');
          emitter.emit('team-run-failed', { teamId, projectId, reason: 'cancelled', stage: stage.id });
          return { terminal: { cancelled: true, stage: stage.id } };
        }
        if (!result.ok) {
          output.appendLog(cwd, team.outputPath, `${dateStr} | ${topic() || '(topic)'} | ${platforms() || '-'} | FAILED @${stage.id} (${result.reason})`);
          log(`run failed: ${lockKey} at stage ${stage.id} (${result.reason})`);
          emitter.emit('team-run-failed', { teamId, projectId, reason: result.reason, stage: stage.id });
          return { terminal: { failedStage: stage.id, reason: result.reason } };
        }

        const produced = readText(produces.path);
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
      const integ = finalize('integrate');
      log(`run complete: ${lockKey} runId=${runId} verdict=${verdict || 'DONE'}${integ.merged ? ' (merged)' : ''}`);
      emitter.emit('team-run-complete', { teamId, projectId, runId, runDir, verdict, rounds, branch: integ.branch, base: integ.base, merged: integ.merged });
      return { ok: true, verdict, runDir, rounds, branch: integ.branch, merged: integ.merged };
    } finally {
      active.delete(lockKey);
      // Failure / halt paths fall through here: commit + fast-forward them too, so the run is captured
      // and the working tree stays clean. The success and cancel paths already finalized above.
      if (!finalized) finalize('integrate');
    }
  }

  function cancelRun(teamId, projectId) {
    const lockKey = `${teamId}:${projectId}`;
    const entry = active.get(lockKey);
    if (!entry) return false;
    entry.cancelled = true;
    entry.cancelling = true;
    log(`cancel requested: ${lockKey}${entry.currentStage ? ` (stage ${entry.currentStage})` : ''}`);
    // Signal every client (and a re-mounting tab, via getRunState) to show "Cancelling…".
    emitter.emit('team-run-cancelling', { teamId, projectId, stage: entry.currentStage || null });
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
    };
  }

  emitter.runTeam = runTeam;
  emitter.cancelRun = cancelRun;
  emitter.isActive = isActive;
  emitter.getRunState = getRunState;
  emitter.activeCount = () => active.size;
  return emitter;
}

module.exports = {
  createOrchestrator, parseVerdict, sectionFirstLine, formatRunVerdict, defaultRunLabel,
};
