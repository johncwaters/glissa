'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createOrchestrator } = require('../teamlib/team-orchestrator');
const { loadTeam } = require('../teamlib/team-registry');
const teamOutput = require('../teamlib/team-output');
const { buildStagePrompt } = require('../teamlib/team-prompt');
const { buildStageSpawnOptions, teamPermissions } = require('../teamlib/team-settings');
const { createSpawnGate } = require('../spawn-gate');

const REPO_TEAMS = path.join(__dirname, '..', 'teams');
const OUT = '.glissa/teams/marketing';
const REQUIRED = ['voice-guide.md', 'avoid-list.md', 'brand.md', 'content-calendar.md', 'channels.md'];

const BRIEF = '## Topic\nBoondocking basics\n## Angle\nhook\n## Audience\nnew RVers\n'
  + '## Differentiator\nmobile-first\n## Sources\n- https://example.com\n## Sensitivities\nnone\n';
const PLAN = '## Platforms\nX, LinkedIn\n## Per-platform angle\nthread\n## CTA\nnone\n'
  + '## Length\nshort\n## Posting time\n5am MT\n';
const DRAFTS = '## X\nA calm post about boondocking.\n';
const REVIEW = (v) => `Reviewed every draft.\nVERDICT: ${v}\n`;
const PUBLISHED = '## X\nPostiz draft created: https://postiz.example/d/1\n';

// Write a filled pack (no sentinel) so the orchestrator's first-run setup gate passes and the run
// proceeds. The orchestrator uses the REAL team-output, which reads the pack from the project path.
function seedPack(proj) {
  const dir = path.join(proj, OUT, 'pack');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of REQUIRED) fs.writeFileSync(path.join(dir, name), `# ${name}\nreal content\n`, 'utf8');
}

// Fake session factory: writes the produces file (path parsed from the real built prompt) then
// emits `exit`, mirroring `claude -p` exit-based completion.
//   behaviors[stageId] = {write, exitCode, hang}  -- a single behavior reused for every spawn, OR
//   behaviors[stageId] = [{...}, {...}]            -- a sequence consumed in order across successive
//                                                     spawns of that stage, with the LAST entry sticky
//                                                     (reused for any further spawns of the stage).
// A per-stageId call counter selects which behavior a given spawn uses, so a stage can return FIX then
// SHIP across revise rounds, or distinct drafts per round.
function fakeFactory(behaviors) {
  const calls = {}; // stageId -> number of spawns so far
  return (sessionOpts) => {
    const stageId = String(sessionOpts.id).split(':').pop();
    const ee = new EventEmitter();
    ee.start = () => {
      const spec = behaviors[stageId];
      const n = calls[stageId] || 0;
      calls[stageId] = n + 1;
      let b;
      if (Array.isArray(spec)) {
        b = spec.length ? (spec[n] || spec[spec.length - 1]) : { exitCode: 0 };
      } else {
        b = spec || { exitCode: 0 };
      }
      if (b.hang) return; // never completes on its own; only a kill() ends it
      const m = /Write your single output file to: (.+)/.exec(sessionOpts.initialPrompt || '');
      const producesPath = m ? m[1].trim() : null;
      setImmediate(() => {
        if (b.write != null && producesPath) fs.writeFileSync(producesPath, b.write, 'utf8');
        ee.emit('exit', { exitCode: b.exitCode == null ? 0 : b.exitCode });
      });
    };
    // Real Session.kill() tears down the process tree but KEEPS its listeners, so the pending 'exit'
    // still reaches runStage's handler, which is what lets a cancel resolve the in-flight stage.
    ee.kill = () => { setImmediate(() => ee.emit('exit', { exitCode: 137 })); };
    // Real Session.destroy() calls removeAllListeners(). Model that faithfully: a regression that
    // cancels via destroy() instead of kill() would strip the 'exit' listener before it fires and
    // strand the run until the stage timeout, which would hang the cancel tests below.
    ee.destroy = () => { ee.removeAllListeners(); };
    return ee;
  };
}

function makeOrch(tmpProj, behaviors, opts = {}) {
  const events = [];
  const orch = createOrchestrator({
    loadTeam: (id) => loadTeam(id, REPO_TEAMS),
    getProjectPath: () => tmpProj,
    output: teamOutput,
    buildStagePrompt,
    buildStageSpawnOptions,
    teamPermissions,
    spawnGate: createSpawnGate(),
    makeStageSession: fakeFactory(behaviors),
    gitWorkspace: opts.gitWorkspace || null,
    now: () => new Date(Date.UTC(2026, 5, 2, 18, 0, 0)),
    log: () => {}, // keep lifecycle logging out of the test output (it pipes through `tail`)
  });
  for (const name of ['team-run-started', 'team-stage-started', 'team-stage-complete',
    'team-run-cancelling', 'team-run-complete', 'team-run-failed', 'team-run-skipped', 'team-run-needs-setup']) {
    orch.on(name, (p) => events.push({ name, ...p }));
  }
  return { orch, events };
}

// Fake git workspace: hands the run a real temp dir as its cwd (so stage files actually write) and
// records create/integrate/discard so we can assert the run was isolated and integrated.
function fakeWorkspace() {
  const calls = { create: 0, integrate: 0, discard: 0 };
  const wdirs = [];
  return {
    calls,
    wdirs,
    create: () => {
      calls.create += 1;
      const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-fakewt-'));
      wdirs.push(wt);
      return { cwd: wt, isGit: true, branch: 'glissa/marketing/run', base: 'main', baseSha: 'abc123' };
    },
    integrate: () => { calls.integrate += 1; return { branch: null, base: 'main', merged: true, committed: true }; },
    discard: () => { calls.discard += 1; },
    cleanup: () => { for (const d of wdirs) fs.rmSync(d, { recursive: true, force: true }); },
  };
}

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-orch-'));
}
function runsOf(proj) {
  const dir = path.join(proj, OUT, 'runs');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}
function logLines(proj) {
  const p = path.join(proj, OUT, 'log.md');
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
}
function runDirOf(proj) {
  return path.join(proj, OUT, 'runs', runsOf(proj)[0]);
}
function startedCount(events, stage) {
  return events.filter((e) => e.name === 'team-stage-started' && e.stage === stage).length;
}
// Distinct DRAFTS bodies so the no-progress guard does NOT bail (each revise round produces new bytes).
const DRAFTS_N = (n) => `## X\nA calm post about boondocking, revision ${n}.\n`;

test('first run with no pack scaffolds + halts (needs-setup), runs zero stages', async () => {
  const proj = tmpProject();
  try {
    const { orch, events } = makeOrch(proj, { researcher: { write: BRIEF } });
    const res = await orch.runTeam({ teamId: 'marketing', projectId: 'p1', trigger: 'manual' });
    assert.equal(res.needsSetup, true);
    assert.ok(res.unfilled.length > 0, 'reports the unfilled pack files');
    assert.equal(runsOf(proj).length, 0, 'no run folder created');
    assert.ok(logLines(proj).some((l) => l.includes('NEEDS_SETUP')), 'logged a NEEDS_SETUP line');
    assert.ok(events.some((e) => e.name === 'team-run-needs-setup'));
    assert.ok(!events.some((e) => e.name === 'team-stage-started'), 'no stage ran');
    // The pack was scaffolded for the operator to fill.
    assert.ok(fs.existsSync(path.join(proj, OUT, 'pack', 'voice-guide.md')));
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('happy path: all stages run, SHIP -> publisher, one success log line', async () => {
  const proj = tmpProject();
  try {
    seedPack(proj);
    const { orch, events } = makeOrch(proj, {
      researcher: { write: BRIEF },
      strategist: { write: PLAN },
      writer: { write: DRAFTS },
      editor: { write: REVIEW('SHIP') },
      publisher: { write: PUBLISHED },
    });
    const res = await orch.runTeam({ teamId: 'marketing', projectId: 'p1', trigger: 'manual' });
    assert.equal(res.ok, true);
    assert.equal(res.verdict, 'SHIP');
    const runDir = path.join(proj, OUT, 'runs', runsOf(proj)[0]);
    for (const f of ['brief.md', 'plan.md', 'drafts.md', 'review.md', 'published.md']) {
      assert.ok(fs.existsSync(path.join(runDir, f)), `${f} written`);
    }
    assert.equal(logLines(proj).length, 2, 'header + exactly one run line');
    assert.equal(events.filter((e) => e.name === 'team-stage-complete').length, 5);
    assert.ok(events.some((e) => e.name === 'team-run-complete'));
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('stage-2 failure halts before stage 3: no drafts.md, one failure line', async () => {
  const proj = tmpProject();
  try {
    seedPack(proj);
    const { orch, events } = makeOrch(proj, {
      researcher: { write: BRIEF },
      strategist: { exitCode: 1 }, // fails, writes nothing
      writer: { write: DRAFTS },
    });
    const res = await orch.runTeam({ teamId: 'marketing', projectId: 'p1' });
    assert.equal(res.failedStage, 'strategist');
    const runDir = path.join(proj, OUT, 'runs', runsOf(proj)[0]);
    assert.ok(fs.existsSync(path.join(runDir, 'brief.md')));
    assert.ok(!fs.existsSync(path.join(runDir, 'drafts.md')), 'writer never ran');
    assert.equal(logLines(proj).length, 2, 'header + one failure line');
    assert.ok(events.some((e) => e.name === 'team-run-failed'));
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('researcher INSUFFICIENT_TOPICS halts the run (sections not required)', async () => {
  const proj = tmpProject();
  try {
    seedPack(proj);
    const { orch } = makeOrch(proj, { researcher: { write: 'INSUFFICIENT_TOPICS\n' } });
    const res = await orch.runTeam({ teamId: 'marketing', projectId: 'p1' });
    assert.equal(res.halted, 'INSUFFICIENT_TOPICS');
    assert.equal(runsOf(proj).length, 1);
    assert.ok(logLines(proj).some((l) => l.includes('HALT')));
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('incomplete handoff (missing sections) fails the stage', async () => {
  const proj = tmpProject();
  try {
    seedPack(proj);
    const { orch } = makeOrch(proj, { researcher: { write: '## Topic\nonly a topic\n' } });
    const res = await orch.runTeam({ teamId: 'marketing', projectId: 'p1' });
    assert.equal(res.failedStage, 'researcher');
    assert.ok(res.missing.includes('Angle'));
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('editor BLOCK completes the run but skips the publisher', async () => {
  const proj = tmpProject();
  try {
    seedPack(proj);
    const { orch } = makeOrch(proj, {
      researcher: { write: BRIEF },
      strategist: { write: PLAN },
      writer: { write: DRAFTS },
      editor: { write: REVIEW('BLOCK') },
      publisher: { write: PUBLISHED },
    });
    const res = await orch.runTeam({ teamId: 'marketing', projectId: 'p1' });
    assert.equal(res.ok, true);
    assert.equal(res.verdict, 'BLOCK');
    const runDir = path.join(proj, OUT, 'runs', runsOf(proj)[0]);
    assert.ok(!fs.existsSync(path.join(runDir, 'published.md')), 'publisher skipped on non-SHIP');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('a git project runs in an isolated workspace and integrates on success', async () => {
  const proj = tmpProject();
  const gw = fakeWorkspace();
  try {
    seedPack(proj);
    const { orch, events } = makeOrch(proj, {
      researcher: { write: BRIEF }, strategist: { write: PLAN }, writer: { write: DRAFTS },
      editor: { write: REVIEW('SHIP') }, publisher: { write: PUBLISHED },
    }, { gitWorkspace: gw });
    const res = await orch.runTeam({ teamId: 'marketing', projectId: 'p1', trigger: 'scheduled' });
    assert.equal(res.ok, true);
    assert.equal(res.merged, true);
    assert.equal(gw.calls.create, 1, 'created an isolated workspace');
    assert.equal(gw.calls.integrate, 1, 'integrated the run on success');
    assert.equal(gw.calls.discard, 0);
    const complete = events.find((e) => e.name === 'team-run-complete');
    assert.equal(complete.merged, true);
    // The run output lives in the worktree, NOT the project's working tree.
    assert.equal(runsOf(proj).length, 0, 'project working tree untouched');
    assert.equal(fs.readdirSync(path.join(gw.wdirs[0], OUT, 'runs')).length, 1);
  } finally {
    gw.cleanup();
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('cancelling a run discards its workspace and does not integrate', async () => {
  const proj = tmpProject();
  const gw = fakeWorkspace();
  try {
    seedPack(proj);
    const { orch } = makeOrch(proj, { researcher: { hang: true } }, { gitWorkspace: gw });
    const first = orch.runTeam({ teamId: 'marketing', projectId: 'p1' });
    await new Promise((r) => setImmediate(r));
    assert.equal(orch.cancelRun('marketing', 'p1'), true);
    const res = await first;
    assert.equal(res.cancelled, true);
    assert.equal(gw.calls.discard, 1, 'threw the worktree away');
    assert.equal(gw.calls.integrate, 0, 'did not integrate a cancelled run');
  } finally {
    gw.cleanup();
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('a stage failure still integrates the partial run (kept, not discarded)', async () => {
  const proj = tmpProject();
  const gw = fakeWorkspace();
  try {
    seedPack(proj);
    const { orch } = makeOrch(proj, { researcher: { write: BRIEF }, strategist: { exitCode: 1 } }, { gitWorkspace: gw });
    const res = await orch.runTeam({ teamId: 'marketing', projectId: 'p1' });
    assert.equal(res.failedStage, 'strategist');
    assert.equal(gw.calls.integrate, 1, 'failed run is committed + integrated');
    assert.equal(gw.calls.discard, 0);
  } finally {
    gw.cleanup();
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('a second concurrent run is skipped; cancelRun releases the first', async () => {
  const proj = tmpProject();
  try {
    seedPack(proj);
    const { orch, events } = makeOrch(proj, { researcher: { hang: true } });
    const first = orch.runTeam({ teamId: 'marketing', projectId: 'p1' }); // pending (researcher hangs)
    // Give the first run a tick to acquire the lock and spawn the hanging stage.
    await new Promise((r) => setImmediate(r));
    const second = await orch.runTeam({ teamId: 'marketing', projectId: 'p1' });
    assert.equal(second.skipped, true);
    assert.ok(events.some((e) => e.name === 'team-run-skipped'));
    assert.equal(orch.cancelRun('marketing', 'p1'), true);
    const firstRes = await first;
    assert.equal(firstRes.cancelled, true);
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('cancel resolves the in-flight stage promptly (kill, not destroy) and ends as cancelled', async () => {
  const proj = tmpProject();
  try {
    seedPack(proj);
    const { orch, events } = makeOrch(proj, { researcher: { hang: true } });
    const run = orch.runTeam({ teamId: 'marketing', projectId: 'p1' });
    await new Promise((r) => setImmediate(r)); // acquire the lock + spawn the hanging stage
    assert.equal(orch.isActive('marketing', 'p1'), true);
    assert.equal(orch.cancelRun('marketing', 'p1'), true);
    // If cancelRun regressed to session.destroy(), the fake strips its 'exit' listener and this await
    // would never resolve (the real bug: hang until the stage timeout). kill() keeps the listener.
    const res = await run;
    assert.equal(res.cancelled, true);
    assert.ok(events.some((e) => e.name === 'team-run-cancelling'), 'emitted a cancelling signal for clients');
    const failed = events.find((e) => e.name === 'team-run-failed');
    assert.ok(failed && failed.reason === 'cancelled', 'ended as cancelled via the stage exit');
    assert.equal(orch.isActive('marketing', 'p1'), false, 'released the lock');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('getRunState exposes the live stage + timestamps while active, cancelling on cancel, null otherwise', async () => {
  const proj = tmpProject();
  try {
    seedPack(proj);
    const { orch } = makeOrch(proj, { researcher: { hang: true } });
    assert.equal(orch.getRunState('marketing', 'p1'), null, 'null before any run');
    const run = orch.runTeam({ teamId: 'marketing', projectId: 'p1' });
    await new Promise((r) => setImmediate(r));
    const live = orch.getRunState('marketing', 'p1');
    assert.ok(live, 'a snapshot while active');
    assert.equal(live.currentStage, 'researcher');
    assert.ok(live.stageStartedAtMs > 0, 'records when the current stage started');
    assert.equal(live.cancelling, false);
    orch.cancelRun('marketing', 'p1'); // synchronous: flips cancelling before the stage unwinds
    const mid = orch.getRunState('marketing', 'p1');
    assert.ok(mid && mid.cancelling === true, 'cancelling flag visible to a re-mounting client');
    await run;
    assert.equal(orch.getRunState('marketing', 'p1'), null, 'null after the run ends');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// --- Phase B: bounded FIX revision loop (acceptance criteria 1-8) ---

// 1. Converges: editor FIX then SHIP. Writer drafts differ across rounds so the no-progress guard does
//    not bail. Writer re-runs once, published.md exists, verdict SHIP, rounds 1, log "FIX->SHIP (1 round".
test('loop 1: FIX then SHIP converges, writer re-runs once, publisher runs (rounds=1)', async () => {
  const proj = tmpProject();
  try {
    seedPack(proj);
    const { orch, events } = makeOrch(proj, {
      researcher: { write: BRIEF },
      strategist: { write: PLAN },
      writer: [{ write: DRAFTS_N(0) }, { write: DRAFTS_N(1) }],
      editor: [{ write: REVIEW('FIX') }, { write: REVIEW('SHIP') }],
      publisher: { write: PUBLISHED },
    });
    const res = await orch.runTeam({ teamId: 'marketing', projectId: 'p1', trigger: 'manual' });
    assert.equal(res.verdict, 'SHIP');
    assert.equal(res.rounds, 1);
    assert.equal(startedCount(events, 'writer'), 2, 'writer ran on the linear pass + one revise round');
    assert.equal(startedCount(events, 'editor'), 2, 'editor audited twice');
    assert.ok(fs.existsSync(path.join(runDirOf(proj), 'published.md')), 'publisher ran on the final SHIP');
    assert.ok(logLines(proj).some((l) => l.includes('FIX->SHIP (1 round')), 'log records the converged verdict');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// 2. Budget exhaustion: editor always FIX, maxRounds 2, writer drafts DISTINCT each round (no-progress
//    guard never trips). Writer started 3x, editor started 3x, no publisher, verdict FIX, rounds 2,
//    log "maxRounds 2".
test('loop 2: always FIX exhausts maxRounds 2, publisher skipped (rounds=2)', async () => {
  const proj = tmpProject();
  try {
    seedPack(proj);
    const { orch, events } = makeOrch(proj, {
      researcher: { write: BRIEF },
      strategist: { write: PLAN },
      writer: [{ write: DRAFTS_N(0) }, { write: DRAFTS_N(1) }, { write: DRAFTS_N(2) }],
      editor: { write: REVIEW('FIX') }, // sticky FIX across all spawns
      publisher: { write: PUBLISHED },
    });
    const res = await orch.runTeam({ teamId: 'marketing', projectId: 'p1' });
    assert.equal(res.verdict, 'FIX');
    assert.equal(res.rounds, 2);
    assert.equal(startedCount(events, 'writer'), 3, 'writer: linear + 2 revise rounds');
    assert.equal(startedCount(events, 'editor'), 3, 'editor: linear + 2 re-audits');
    assert.ok(!fs.existsSync(path.join(runDirOf(proj), 'published.md')), 'publisher skipped on FIX');
    assert.ok(logLines(proj).some((l) => l.includes('maxRounds 2')), 'log records budget exhaustion');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// 3. Archive trail after the exhausted run in #2: rounds/ holds r0/r1 of both files; canonical files
//    hold the final round's content.
test('loop 3: archive trail captures each round; canonical files hold the final round', async () => {
  const proj = tmpProject();
  try {
    seedPack(proj);
    const { orch } = makeOrch(proj, {
      researcher: { write: BRIEF },
      strategist: { write: PLAN },
      writer: [{ write: DRAFTS_N(0) }, { write: DRAFTS_N(1) }, { write: DRAFTS_N(2) }],
      editor: { write: REVIEW('FIX') },
      publisher: { write: PUBLISHED },
    });
    await orch.runTeam({ teamId: 'marketing', projectId: 'p1' });
    const runDir = runDirOf(proj);
    const roundsDir = path.join(runDir, 'rounds');
    for (const f of ['r0-drafts.md', 'r0-review.md', 'r1-drafts.md', 'r1-review.md']) {
      assert.ok(fs.existsSync(path.join(roundsDir, f)), `${f} archived`);
    }
    assert.equal(fs.readFileSync(path.join(runDir, 'drafts.md'), 'utf8'), DRAFTS_N(2), 'canonical drafts.md is the final round');
    assert.equal(fs.readFileSync(path.join(roundsDir, 'r0-drafts.md'), 'utf8'), DRAFTS_N(0), 'r0 archive is the first draft');
    assert.equal(fs.readFileSync(path.join(roundsDir, 'r1-drafts.md'), 'utf8'), DRAFTS_N(1), 'r1 archive is the second draft');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// 4. BLOCK on the first pass: zero revise rounds, writer started exactly once, no publisher, rounds 0.
test('loop 4: BLOCK first pass short-circuits, no revise rounds (rounds=0)', async () => {
  const proj = tmpProject();
  try {
    seedPack(proj);
    const { orch, events } = makeOrch(proj, {
      researcher: { write: BRIEF },
      strategist: { write: PLAN },
      writer: { write: DRAFTS },
      editor: { write: REVIEW('BLOCK') },
      publisher: { write: PUBLISHED },
    });
    const res = await orch.runTeam({ teamId: 'marketing', projectId: 'p1' });
    assert.equal(res.verdict, 'BLOCK');
    assert.equal(res.rounds, 0);
    assert.equal(startedCount(events, 'writer'), 1, 'writer ran exactly once (no revise)');
    assert.ok(!fs.existsSync(path.join(runDirOf(proj), 'published.md')), 'publisher skipped on BLOCK');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// 5. No-progress guard: editor sticky FIX, writer outputs IDENTICAL bytes every spawn. In revise round 1
//    the writer produces the same drafts, so the editor is NOT re-spawned (editor started once total),
//    writer started twice, verdict FIX, log "no-progress".
test('loop 5: no-progress guard bails before re-auditing identical drafts', async () => {
  const proj = tmpProject();
  try {
    seedPack(proj);
    const { orch, events } = makeOrch(proj, {
      researcher: { write: BRIEF },
      strategist: { write: PLAN },
      writer: { write: DRAFTS }, // identical bytes on every spawn
      editor: { write: REVIEW('FIX') },
      publisher: { write: PUBLISHED },
    });
    const res = await orch.runTeam({ teamId: 'marketing', projectId: 'p1' });
    assert.equal(res.verdict, 'FIX');
    assert.equal(startedCount(events, 'writer'), 2, 'writer: linear + one revise attempt');
    assert.equal(startedCount(events, 'editor'), 1, 'editor NOT re-spawned once the draft did not change');
    assert.ok(!fs.existsSync(path.join(runDirOf(proj), 'published.md')), 'publisher skipped');
    assert.ok(logLines(proj).some((l) => l.includes('no-progress')), 'log records the no-progress bail');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// 6. First-pass SHIP regression: rounds 0 and the log line carries NO round suffix.
test('loop 6: first-pass SHIP has rounds=0 and no log round suffix', async () => {
  const proj = tmpProject();
  try {
    seedPack(proj);
    const { orch } = makeOrch(proj, {
      researcher: { write: BRIEF },
      strategist: { write: PLAN },
      writer: { write: DRAFTS },
      editor: { write: REVIEW('SHIP') },
      publisher: { write: PUBLISHED },
    });
    const res = await orch.runTeam({ teamId: 'marketing', projectId: 'p1' });
    assert.equal(res.verdict, 'SHIP');
    assert.equal(res.rounds, 0);
    const runLine = logLines(proj).find((l) => l.includes('SHIP'));
    assert.ok(runLine, 'a SHIP run line exists');
    assert.ok(!/round|->/.test(runLine), 'no round suffix on a first-pass SHIP');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// 7. Events: team-revise-round fires once per executed round with the right round; re-run stage events
//    carry round > 0; team-run-complete carries rounds.
test('loop 7: events carry round/rounds across the revise loop', async () => {
  const proj = tmpProject();
  try {
    seedPack(proj);
    const { orch, events } = makeOrch(proj, {
      researcher: { write: BRIEF },
      strategist: { write: PLAN },
      writer: [{ write: DRAFTS_N(0) }, { write: DRAFTS_N(1) }],
      editor: [{ write: REVIEW('FIX') }, { write: REVIEW('SHIP') }],
      publisher: { write: PUBLISHED },
    });
    orch.on('team-revise-round', (p) => events.push({ name: 'team-revise-round', ...p }));
    const res = await orch.runTeam({ teamId: 'marketing', projectId: 'p1' });
    assert.equal(res.rounds, 1);
    const reviseEvents = events.filter((e) => e.name === 'team-revise-round');
    assert.equal(reviseEvents.length, 1, 'one revise-round event for one executed round');
    assert.equal(reviseEvents[0].round, 1);
    assert.equal(reviseEvents[0].fromVerdict, 'FIX');
    const writerRound1 = events.find((e) => e.name === 'team-stage-started' && e.stage === 'writer' && e.round === 1);
    assert.ok(writerRound1, 'the re-run writer event carries round 1');
    const editorRound1 = events.find((e) => e.name === 'team-stage-started' && e.stage === 'editor' && e.round === 1);
    assert.ok(editorRound1, 'the re-audit editor event carries round 1');
    const complete = events.find((e) => e.name === 'team-run-complete');
    assert.equal(complete.rounds, 1, 'team-run-complete carries rounds');
    const linearWriter = events.find((e) => e.name === 'team-stage-started' && e.stage === 'writer' && e.round === 0);
    assert.ok(linearWriter, 'the linear-pass writer event carries round 0');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// 8. Cancel during revise: the writer's SECOND spawn hangs; let the first FIX happen, then cancel during
//    the hanging revise writer. The run ends cancelled and the worktree is discarded (no integrate).
test('loop 8: cancel during a revise round discards the worktree', async () => {
  const proj = tmpProject();
  const gw = fakeWorkspace();
  try {
    seedPack(proj);
    const { orch, events } = makeOrch(proj, {
      researcher: { write: BRIEF },
      strategist: { write: PLAN },
      writer: [{ write: DRAFTS_N(0) }, { hang: true }], // 2nd spawn (revise round 1) hangs
      editor: { write: REVIEW('FIX') },
      publisher: { write: PUBLISHED },
    }, { gitWorkspace: gw });
    const run = orch.runTeam({ teamId: 'marketing', projectId: 'p1' });
    // Wait until the hanging revise writer has started (its round-1 stage-started event fired).
    await new Promise((resolve) => {
      const tick = () => {
        if (events.some((e) => e.name === 'team-stage-started' && e.stage === 'writer' && e.round === 1)) {
          resolve();
        } else { setImmediate(tick); }
      };
      tick();
    });
    assert.equal(orch.cancelRun('marketing', 'p1'), true);
    const res = await run;
    assert.equal(res.cancelled, true);
    assert.equal(gw.calls.discard, 1, 'cancelled revise discards the worktree');
    assert.equal(gw.calls.integrate, 0, 'no integrate on a cancelled revise');
  } finally {
    gw.cleanup();
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// --- QA team: SHIP-gated writeScope staging + restore-before-audit (the oracle-integrity mechanism) ---

const OUT_QA = '.glissa/teams/qa';
const QA_PACK = ['how-to-run.md', 'flaky-and-known.md', 'fix-policy.md'];
const TRIAGE = '## Gate\nnpm test\n## Failures\nfoo.test\n## Classification\nfoo: real\n'
  + '## Scope\nsrc/foo.js\n## Plan\nfix foo\n';
const TRIAGE_GREEN = 'SUITE_GREEN\n';
const FIXES = '## Fixes\nfixed src/foo.js\n## Suite result\nall pass\n## Un-landable\nnone\n';
const QREVIEW = (v) => `## Whole-suite\ngreen\n## Root-cause\nyes\n## Flaky/env\nhandled\n## Summary\nok\nVERDICT: ${v}\n`;
const REPORT = '## Report\nwhat was red, fixed, residual risk\n';

function seedQaPack(proj) {
  const dir = path.join(proj, OUT_QA, 'pack');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of QA_PACK) fs.writeFileSync(path.join(dir, name), `# ${name}\nreal content\n`, 'utf8');
}
// With a git workspace the run folder + log live in the WORKTREE (gw.wdirs[0]), not the project tree.
// These helpers read from a given base dir (pass the worktree dir for a git run, or proj for in-place).
function qaRunsOf(base) {
  const dir = path.join(base, OUT_QA, 'runs');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}
function qaRunIdOf(base) {
  return qaRunsOf(base)[0] || '';
}
function qaRunDirOf(base) {
  return path.join(base, OUT_QA, 'runs', qaRunIdOf(base));
}
function logLinesQa(base) {
  const p = path.join(base, OUT_QA, 'log.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean) : [];
}

// A capturing git workspace: a real temp worktree (so stage files write) that RECORDS the addPaths of the
// last integrate and every restoreTests checkout/clean command into a shared `cmds` log (interleaved with
// a per-stage marker so order vs the stage spawns is assertable). baseSha is present so the orchestrator's
// restore gate is satisfied for a qa run.
function capturingWorkspace() {
  const calls = { create: 0, integrate: 0, discard: 0, restore: 0 };
  const wdirs = [];
  const cmds = []; // 'restore:checkout ...', 'restore:clean ...'
  let lastAddPaths = null;
  return {
    calls,
    wdirs,
    cmds,
    get lastAddPaths() { return lastAddPaths; },
    create: () => {
      calls.create += 1;
      const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-qawt-'));
      wdirs.push(wt);
      return { cwd: wt, isGit: true, branch: 'glissa/qa/run', base: 'main', baseSha: 'base000' };
    },
    integrate: ({ addPaths }) => {
      calls.integrate += 1;
      lastAddPaths = addPaths;
      return { branch: null, base: 'main', merged: true, committed: true };
    },
    discard: () => { calls.discard += 1; },
    restoreTests: ({ testGlobs = [] }) => {
      calls.restore += 1;
      for (const g of testGlobs) cmds.push(`restore:checkout base000 -- ${g}`);
      for (const g of testGlobs) cmds.push(`restore:clean -f -- ${g}`);
    },
    cleanup: () => { for (const d of wdirs) fs.rmSync(d, { recursive: true, force: true }); },
  };
}
test('qa SHIP stages writeScope (src/** + lib/**) in addition to run folder + log', async () => {
  const proj = tmpProject();
  const gw = capturingWorkspace();
  try {
    seedQaPack(proj);
    const { orch } = makeOrch(proj, {
      'runner-triager': { write: TRIAGE },
      fixer: { write: FIXES },
      auditor: { write: QREVIEW('SHIP') },
      reporter: { write: REPORT },
    }, { gitWorkspace: gw });
    const res = await orch.runTeam({ teamId: 'qa', projectId: 'p1' });
    assert.equal(res.verdict, 'SHIP');
    const runId = qaRunIdOf(gw.wdirs[0]);
    assert.deepEqual(gw.lastAddPaths, [
      `${OUT_QA}/runs/${runId}`, `${OUT_QA}/log.md`, 'src/**', 'lib/**',
    ], 'SHIP stages the writeScope globs after the run folder + log');
  } finally {
    gw.cleanup();
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('qa non-SHIP (BLOCK) stages EXACTLY run folder + log, no source globs; reporter skipped', async () => {
  const proj = tmpProject();
  const gw = capturingWorkspace();
  try {
    seedQaPack(proj);
    const { orch } = makeOrch(proj, {
      'runner-triager': { write: TRIAGE },
      fixer: { write: FIXES },
      auditor: { write: QREVIEW('BLOCK') },
      reporter: { write: REPORT },
    }, { gitWorkspace: gw });
    const res = await orch.runTeam({ teamId: 'qa', projectId: 'p1' });
    assert.equal(res.verdict, 'BLOCK');
    const runId = qaRunIdOf(gw.wdirs[0]);
    assert.deepEqual(gw.lastAddPaths, [`${OUT_QA}/runs/${runId}`, `${OUT_QA}/log.md`],
      'a non-SHIP run stages no source globs');
    assert.ok(!fs.existsSync(path.join(qaRunDirOf(gw.wdirs[0]), 'report.md')), 'reporter skipped on BLOCK (runIfVerdict)');
  } finally {
    gw.cleanup();
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('qa runner-triager SUITE_GREEN halts: zero downstream stages, halt event, bare addPaths', async () => {
  const proj = tmpProject();
  const gw = capturingWorkspace();
  try {
    seedQaPack(proj);
    const { orch, events } = makeOrch(proj, {
      'runner-triager': { write: TRIAGE_GREEN },
      fixer: { write: FIXES },
      auditor: { write: QREVIEW('SHIP') },
    }, { gitWorkspace: gw });
    const res = await orch.runTeam({ teamId: 'qa', projectId: 'p1' });
    assert.equal(res.halted, 'SUITE_GREEN');
    assert.equal(startedCount(events, 'fixer'), 0, 'fixer never started');
    assert.equal(startedCount(events, 'auditor'), 0, 'auditor never started');
    assert.ok(logLinesQa(gw.wdirs[0]).some((l) => l.includes('HALT (SUITE_GREEN)')), 'HALT line logged');
    const failed = events.find((e) => e.name === 'team-run-failed');
    assert.ok(failed && failed.reason === 'halt' && failed.signal === 'SUITE_GREEN', 'halt event with signal');
    // The finally-integrate stages only run folder + log (no SHIP, so no source).
    const runId = qaRunIdOf(gw.wdirs[0]);
    assert.deepEqual(gw.lastAddPaths, [`${OUT_QA}/runs/${runId}`, `${OUT_QA}/log.md`]);
    assert.equal(gw.calls.restore, 0, 'no restore on a healthy-repo halt (auditor never ran)');
  } finally {
    gw.cleanup();
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('qa restores the oracle before EACH audit (checkout-then-clean, testGlob-scoped) and not before other stages', async () => {
  const proj = tmpProject();
  const gw = capturingWorkspace();
  try {
    seedQaPack(proj);
    // FIX then SHIP so there are TWO audits (linear + one re-audit); fixer outputs differ so no-progress
    // does not bail.
    const { orch, events } = makeOrch(proj, {
      'runner-triager': { write: TRIAGE },
      fixer: [{ write: FIXES }, { write: '## Fixes\nround 2\n## Suite result\npass\n## Un-landable\nnone\n' }],
      auditor: [{ write: QREVIEW('FIX') }, { write: QREVIEW('SHIP') }],
      reporter: { write: REPORT },
    }, { gitWorkspace: gw });
    const res = await orch.runTeam({ teamId: 'qa', projectId: 'p1' });
    assert.equal(res.verdict, 'SHIP');
    assert.equal(res.rounds, 1);
    // restore ran once per audit: linear audit + one re-audit = 2.
    assert.equal(gw.calls.restore, 2, 'restore ran before each of the two audits');
    // Command shape: checkout precedes clean, both scoped to the five testGlobs.
    const TG = ['**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**', '**/__tests__/**'];
    for (const g of TG) {
      assert.ok(gw.cmds.includes(`restore:checkout base000 -- ${g}`), `checkout for ${g}`);
      assert.ok(gw.cmds.includes(`restore:clean -f -- ${g}`), `clean for ${g}`);
    }
    const firstClean = gw.cmds.findIndex((c) => c.startsWith('restore:clean'));
    const lastCheckout = gw.cmds.map((c) => c.startsWith('restore:checkout')).lastIndexOf(true);
    // Within one restore the checkouts precede the cleans; across two restores the pattern repeats.
    assert.ok(firstClean > 0 && lastCheckout >= 0, 'both checkout and clean commands recorded');
    // SHIP staged source.
    const runId = qaRunIdOf(gw.wdirs[0]);
    assert.deepEqual(gw.lastAddPaths, [`${OUT_QA}/runs/${runId}`, `${OUT_QA}/log.md`, 'src/**', 'lib/**']);
    // Sanity: the auditor started twice, the (non-verdict) triager/fixer did not trigger restore beyond the 2.
    assert.equal(startedCount(events, 'auditor'), 2);
  } finally {
    gw.cleanup();
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('qa bogus path: auditor never reaches SHIP (FIX then BLOCK) -> no source merged', async () => {
  const proj = tmpProject();
  const gw = capturingWorkspace();
  try {
    seedQaPack(proj);
    // Models a fixer whose "green" depended on a test edit: after the restore the audit is red, so the
    // auditor returns FIX, then BLOCK on the re-audit. The run never SHIPs, so no source stages.
    const { orch } = makeOrch(proj, {
      'runner-triager': { write: TRIAGE },
      fixer: [{ write: FIXES }, { write: '## Fixes\nstill red\n## Suite result\nfail\n## Un-landable\ntest edit needed\n' }],
      auditor: [{ write: QREVIEW('FIX') }, { write: QREVIEW('BLOCK') }],
      reporter: { write: REPORT },
    }, { gitWorkspace: gw });
    const res = await orch.runTeam({ teamId: 'qa', projectId: 'p1' });
    assert.equal(res.verdict, 'BLOCK');
    assert.ok(gw.calls.restore >= 2, 'restore ran before each audit');
    const runId = qaRunIdOf(gw.wdirs[0]);
    assert.deepEqual(gw.lastAddPaths, [`${OUT_QA}/runs/${runId}`, `${OUT_QA}/log.md`],
      'a bogus test-edit fix never SHIPs, so no source globs are staged');
    assert.ok(!fs.existsSync(path.join(qaRunDirOf(gw.wdirs[0]), 'report.md')), 'no report on BLOCK');
  } finally {
    gw.cleanup();
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('qa negative control: a clean source-only fix SHIPs and stages source (restore does not disturb it)', async () => {
  const proj = tmpProject();
  const gw = capturingWorkspace();
  try {
    seedQaPack(proj);
    const { orch } = makeOrch(proj, {
      'runner-triager': { write: TRIAGE },
      fixer: { write: FIXES },
      auditor: { write: QREVIEW('SHIP') },
      reporter: { write: REPORT },
    }, { gitWorkspace: gw });
    const res = await orch.runTeam({ teamId: 'qa', projectId: 'p1' });
    assert.equal(res.verdict, 'SHIP');
    assert.equal(gw.calls.restore, 1, 'restore ran once before the single audit');
    const runId = qaRunIdOf(gw.wdirs[0]);
    assert.deepEqual(gw.lastAddPaths, [`${OUT_QA}/runs/${runId}`, `${OUT_QA}/log.md`, 'src/**', 'lib/**']);
    assert.ok(fs.existsSync(path.join(qaRunDirOf(gw.wdirs[0]), 'report.md')), 'reporter ran on SHIP');
  } finally {
    gw.cleanup();
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('marketing records NO restore (its writeScope is [], so the restore gate is false)', async () => {
  const proj = tmpProject();
  const gw = capturingWorkspace();
  try {
    seedPack(proj); // marketing pack
    const { orch } = makeOrch(proj, {
      researcher: { write: BRIEF }, strategist: { write: PLAN }, writer: { write: DRAFTS },
      editor: { write: REVIEW('SHIP') }, publisher: { write: PUBLISHED },
    }, { gitWorkspace: gw });
    const res = await orch.runTeam({ teamId: 'marketing', projectId: 'p1' });
    assert.equal(res.verdict, 'SHIP');
    assert.equal(gw.calls.restore, 0, 'marketing never restores (no writeScope opt-in)');
    assert.equal(gw.cmds.length, 0, 'no restore commands recorded for marketing');
    // And marketing's addPaths is byte-identical (run folder + log only; its writeScope is []).
    const mktRunId = fs.readdirSync(path.join(gw.wdirs[0], OUT, 'runs'))[0];
    assert.deepEqual(gw.lastAddPaths, [`${OUT}/runs/${mktRunId}`, `${OUT}/log.md`]);
  } finally {
    gw.cleanup();
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('qa FIX loop re-runs [fixer] bounded by maxRounds 2, then reporter skipped on a non-SHIP terminal', async () => {
  const proj = tmpProject();
  const gw = capturingWorkspace();
  try {
    seedQaPack(proj);
    // Sticky FIX with DISTINCT fixer output each round (no-progress never trips) -> exhausts maxRounds 2.
    const { orch, events } = makeOrch(proj, {
      'runner-triager': { write: TRIAGE },
      fixer: [
        { write: '## Fixes\nr0\n## Suite result\nx\n## Un-landable\nn\n' },
        { write: '## Fixes\nr1\n## Suite result\nx\n## Un-landable\nn\n' },
        { write: '## Fixes\nr2\n## Suite result\nx\n## Un-landable\nn\n' },
      ],
      auditor: { write: QREVIEW('FIX') }, // sticky FIX across all audits
      reporter: { write: REPORT },
    }, { gitWorkspace: gw });
    const res = await orch.runTeam({ teamId: 'qa', projectId: 'p1' });
    assert.equal(res.verdict, 'FIX');
    assert.equal(res.rounds, 2);
    assert.equal(startedCount(events, 'fixer'), 3, 'fixer: linear + 2 revise rounds');
    assert.equal(startedCount(events, 'auditor'), 3, 'auditor: linear + 2 re-audits');
    assert.equal(gw.calls.restore, 3, 'restore before each of the 3 audits');
    assert.ok(!fs.existsSync(path.join(qaRunDirOf(gw.wdirs[0]), 'report.md')), 'reporter skipped on FIX');
    const runId = qaRunIdOf(gw.wdirs[0]);
    assert.deepEqual(gw.lastAddPaths, [`${OUT_QA}/runs/${runId}`, `${OUT_QA}/log.md`], 'no source on a FIX terminal');
  } finally {
    gw.cleanup();
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('qa first run with an unfilled pack scaffolds + halts (needs-setup), zero stages', async () => {
  const proj = tmpProject();
  try {
    const { orch, events } = makeOrch(proj, { 'runner-triager': { write: TRIAGE } });
    const res = await orch.runTeam({ teamId: 'qa', projectId: 'p1' });
    assert.equal(res.needsSetup, true);
    assert.ok(res.unfilled.length > 0, 'reports unfilled pack files');
    assert.equal(qaRunsOf(proj).length, 0, 'no run folder created');
    assert.ok(!events.some((e) => e.name === 'team-stage-started'), 'no stage ran');
    // Scaffolded the three qa pack templates (with the GLISSA:NEEDS-INPUT sentinel) for the operator.
    for (const name of QA_PACK) {
      assert.ok(fs.existsSync(path.join(proj, OUT_QA, 'pack', name)), `${name} scaffolded`);
    }
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});
