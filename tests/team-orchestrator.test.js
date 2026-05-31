'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createOrchestrator } = require('../team-orchestrator');
const { loadTeam } = require('../team-registry');
const teamOutput = require('../team-output');
const { buildStagePrompt } = require('../team-prompt');
const { buildStageSpawnOptions, teamPermissions } = require('../team-settings');
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
// emits `exit`, mirroring `claude -p` exit-based completion. behaviors[stageId] = {write, exitCode, hang}.
function fakeFactory(behaviors) {
  return (sessionOpts) => {
    const stageId = String(sessionOpts.id).split(':').pop();
    const ee = new EventEmitter();
    ee.start = () => {
      const b = behaviors[stageId] || { exitCode: 0 };
      if (b.hang) return; // never completes until destroy()
      const m = /Write your single output file to: (.+)/.exec(sessionOpts.initialPrompt || '');
      const producesPath = m ? m[1].trim() : null;
      setImmediate(() => {
        if (b.write != null && producesPath) fs.writeFileSync(producesPath, b.write, 'utf8');
        ee.emit('exit', { exitCode: b.exitCode == null ? 0 : b.exitCode });
      });
    };
    ee.destroy = () => { setImmediate(() => ee.emit('exit', { exitCode: 137 })); };
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
  });
  for (const name of ['team-run-started', 'team-stage-started', 'team-stage-complete',
    'team-run-complete', 'team-run-failed', 'team-run-skipped', 'team-run-needs-setup']) {
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
