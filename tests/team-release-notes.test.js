'use strict';

// Acceptance tests for the release-notes team (plan: .omc/plans/release-notes-team.md). The team is
// data + role markdown + pack templates with ZERO engine changes, so these tests drive the REAL engine
// (loadTeam over the repo teams dir; the orchestrator with a fake stage spawner) exactly the way
// tests/team-registry.test.js and tests/team-orchestrator.test.js exercise the marketing team.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createOrchestrator } = require('../teamlib/team-orchestrator');
const { loadTeam, listTeams } = require('../teamlib/team-registry');
const teamOutput = require('../teamlib/team-output');
const { buildStagePrompt } = require('../teamlib/team-prompt');
const { buildStageSpawnOptions, teamPermissions } = require('../teamlib/team-settings');
const { createSpawnGate } = require('../spawn-gate');

const REPO_TEAMS = path.join(__dirname, '..', 'teams');
const TEAM_DIR = path.join(REPO_TEAMS, 'release-notes');
const OUT = '.glissa/teams/release-notes';
const REQUIRED = ['voice-guide.md', 'avoid-list.md', 'release-config.md'];
const STAGE_IDS = ['researcher', 'writer', 'editor', 'publisher'];
const ROLE_FILES = STAGE_IDS.map((id) => path.join(TEAM_DIR, 'agents', `${id}.md`));

// Sample stage outputs for the orchestrator runs. The brief carries the researcher's required sections;
// the topic line drives the run-log topic (orchestrator special-cases stage id 'researcher').
const TOPIC = 'v1.4.0 (v1.3.0..HEAD)';
const BRIEF = `## Topic\n${TOPIC}\n## Release range\nv1.3.0..HEAD\n`
  + '## Changes\n- Added a thing (#12)\n## Sources\n- #12\n## Excluded\n- chore: bump deps\n';
const NOTES = '## Release v1.4.0\nYou can now do a thing (#12).\n';
const REVIEW = (v) => `## Summary\nChecked the notes against the brief sources.\nVERDICT: ${v}\n`;
const PUBLISHED = '## GitHub release draft\nv1.4.0\n## Announcement draft\nWe shipped v1.4.0.\n';
// Distinct notes per revise round so the no-progress guard does not bail.
const NOTES_N = (n) => `## Release v1.4.0\nYou can now do a thing (#12). Revision ${n}.\n`;

// --- Fake stage spawner + orchestrator wiring (mirrors tests/team-orchestrator.test.js) ---

// behaviors[stageId] = {write, exitCode, hang} (reused for every spawn) OR an array consumed in order
// across successive spawns of that stage (last entry sticky). Keyed by the last colon-segment of the id.
function fakeFactory(behaviors) {
  const calls = {};
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
      if (b.hang) return;
      const m = /Write your single output file to: (.+)/.exec(sessionOpts.initialPrompt || '');
      const producesPath = m ? m[1].trim() : null;
      setImmediate(() => {
        if (b.write != null && producesPath) fs.writeFileSync(producesPath, b.write, 'utf8');
        ee.emit('exit', { exitCode: b.exitCode == null ? 0 : b.exitCode });
      });
    };
    ee.kill = () => { setImmediate(() => ee.emit('exit', { exitCode: 137 })); };
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
    log: () => {},
  });
  for (const name of ['team-run-started', 'team-stage-started', 'team-stage-complete',
    'team-run-cancelling', 'team-run-complete', 'team-run-failed', 'team-run-skipped', 'team-run-needs-setup']) {
    orch.on(name, (p) => events.push({ name, ...p }));
  }
  return { orch, events };
}

function seedPack(proj) {
  const dir = path.join(proj, OUT, 'pack');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of REQUIRED) fs.writeFileSync(path.join(dir, name), `# ${name}\nreal content\n`, 'utf8');
}

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-rn-'));
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

// --- Registry / definition (load-time, no spawning) ---

// AC1 + AC2: the team loads and has the 4 expected stages (no strategist).
test('AC1/AC2: release-notes loads with id/outputPath and the four stages', () => {
  const team = loadTeam('release-notes', REPO_TEAMS);
  assert.equal(team.id, 'release-notes');
  assert.equal(team.outputPath, '.glissa/teams/release-notes');
  assert.deepEqual(team.stages.map((s) => s.id), STAGE_IDS);
});

// AC3: ALL FOUR roles (incl. editor) resolve under the TEAM dir, none under _shared.
test('AC3: every stage agent resolves under the team dir, none under _shared', () => {
  const team = loadTeam('release-notes', REPO_TEAMS);
  const localAgents = path.join('release-notes', 'agents');
  for (const s of team.stages) {
    assert.ok(fs.existsSync(s.agentPath), `${s.id} agent file exists`);
    assert.ok(s.agentPath.includes(localAgents), `${s.id} resolves under the team dir`);
    assert.ok(!s.agentPath.includes('_shared'), `${s.id} does not resolve from _shared`);
  }
});

// AC4: packRequired is the three release-notes files and each ships a team-local template.
test('AC4: packRequired matches and each ships a team-local template', () => {
  const team = loadTeam('release-notes', REPO_TEAMS);
  assert.deepEqual(team.packRequired, REQUIRED);
  for (const name of REQUIRED) {
    assert.ok(fs.existsSync(path.join(TEAM_DIR, 'pack-templates', name)), `${name} template shipped`);
  }
});

// AC5: listTeams includes release-notes (and still marketing).
test('AC5: listTeams includes release-notes and marketing', () => {
  const teams = listTeams(REPO_TEAMS);
  assert.ok(teams.includes('release-notes'));
  assert.ok(teams.includes('marketing'));
});

// AC6: verdict + revise + reviseReads wiring validates.
test('AC6: editor verdict/revise/reviseReads and writer reviseReads are wired', () => {
  const team = loadTeam('release-notes', REPO_TEAMS);
  const editor = team.stages.find((s) => s.id === 'editor');
  const writer = team.stages.find((s) => s.id === 'writer');
  assert.deepEqual(editor.verdict.values, ['SHIP', 'FIX', 'BLOCK']);
  assert.deepEqual(editor.revise, { onVerdict: 'FIX', stages: ['writer'], maxRounds: 2 });
  assert.deepEqual(editor.reviseReads, ['review.md']);
  assert.deepEqual(writer.reviseReads, ['review.md', 'notes.md']);
});

// AC6b: the deny-list guardrail is real (yolo is paired with a deny-list that blocks state changes).
test('AC6b: teamPermissions yields a non-empty deny-list with the state-change blockers', () => {
  const team = loadTeam('release-notes', REPO_TEAMS);
  assert.equal(team.permissions.mode, 'yolo');
  const { deny } = teamPermissions(team);
  assert.ok(Array.isArray(deny) && deny.length > 0, 'deny-list is non-empty');
  for (const blocker of ['Bash(git push*)', 'Bash(gh release create*)', 'Bash(gh api*)', 'Bash(npm publish*)']) {
    assert.ok(deny.includes(blocker), `deny-list blocks ${blocker}`);
  }
});

// AC15: the publisher is gated by an engine-honored fact, not by role prose.
test('AC15: publisher carries the engine-honored runIfVerdict/optional gate', () => {
  const team = loadTeam('release-notes', REPO_TEAMS);
  const publisher = team.stages.find((s) => s.id === 'publisher');
  assert.equal(publisher.runIfVerdict, 'SHIP');
  assert.equal(publisher.optional, true);
});

// --- Behavioral / content guard (lint-style, no spawning) ---

// AC14: the four team-local role files are project-agnostic + house-style (no URL, no em/en dash, no emoji).
test('AC14: role files contain no URL, em/en dash, or emoji', () => {
  const EM_DASH = String.fromCharCode(8212);
  const EN_DASH = String.fromCharCode(8211);
  const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
  for (const file of ROLE_FILES) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.includes('http'), `${path.basename(file)} has no URL`);
    assert.ok(!text.includes(EM_DASH), `${path.basename(file)} has no em dash`);
    assert.ok(!text.includes(EN_DASH), `${path.basename(file)} has no en dash`);
    assert.ok(!emoji.test(text), `${path.basename(file)} has no emoji`);
  }
});

// --- Orchestrator (full stage loop with the fake spawner) ---

// AC8: first run with no pack scaffolds + halts (needs-setup), runs zero stages.
test('AC8: first run with no pack scaffolds + halts, runs zero stages', async () => {
  const proj = tmpProject();
  try {
    const { orch, events } = makeOrch(proj, { researcher: { write: BRIEF } });
    const res = await orch.runTeam({ teamId: 'release-notes', projectId: 'p1', trigger: 'manual' });
    assert.equal(res.needsSetup, true);
    assert.deepEqual([...res.unfilled].sort(), [...REQUIRED].sort());
    assert.equal(runsOf(proj).length, 0, 'no run folder created');
    assert.ok(events.some((e) => e.name === 'team-run-needs-setup'));
    assert.ok(!events.some((e) => e.name === 'team-stage-started'), 'no stage ran');
    for (const name of REQUIRED) {
      const fp = path.join(proj, OUT, 'pack', name);
      assert.ok(fs.existsSync(fp), `${name} scaffolded`);
      assert.ok(fs.readFileSync(fp, 'utf8').includes('GLISSA:NEEDS-INPUT'), `${name} carries the sentinel`);
    }
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// AC9: happy path, all four stages run, SHIP -> publisher, the run-log topic comes from ## Topic.
test('AC9: happy path reaches all four stages on SHIP and logs the topic', async () => {
  const proj = tmpProject();
  try {
    seedPack(proj);
    const { orch, events } = makeOrch(proj, {
      researcher: { write: BRIEF },
      writer: { write: NOTES },
      editor: { write: REVIEW('SHIP') },
      publisher: { write: PUBLISHED },
    });
    const res = await orch.runTeam({ teamId: 'release-notes', projectId: 'p1', trigger: 'manual' });
    assert.equal(res.ok, true);
    assert.equal(res.verdict, 'SHIP');
    const runDir = runDirOf(proj);
    for (const f of ['brief.md', 'notes.md', 'review.md', 'published.md']) {
      assert.ok(fs.existsSync(path.join(runDir, f)), `${f} written`);
    }
    assert.equal(events.filter((e) => e.name === 'team-stage-complete').length, 4);
    assert.ok(logLines(proj).some((l) => l.includes('v1.4.0')), 'run log carries the ## Topic value');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// AC10: an incomplete brief (missing a required section) fails the researcher before the writer runs.
test('AC10: a brief missing a required section fails the stage', async () => {
  const proj = tmpProject();
  try {
    seedPack(proj);
    const noSources = `## Topic\n${TOPIC}\n## Release range\nv1.3.0..HEAD\n`
      + '## Changes\n- Added a thing (#12)\n## Excluded\n- chore\n';
    const { orch } = makeOrch(proj, { researcher: { write: noSources }, writer: { write: NOTES } });
    const res = await orch.runTeam({ teamId: 'release-notes', projectId: 'p1' });
    assert.equal(res.failedStage, 'researcher');
    assert.ok(res.missing.includes('Sources'), 'names the absent section');
    assert.ok(!fs.existsSync(path.join(runDirOf(proj), 'notes.md')), 'writer never ran');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// AC11: the researcher halt signal stops the run cleanly (sections not required on a halt brief).
test('AC11: researcher INSUFFICIENT_CHANGES halts the run', async () => {
  const proj = tmpProject();
  try {
    seedPack(proj);
    const { orch, events } = makeOrch(proj, { researcher: { write: 'INSUFFICIENT_CHANGES\n' } });
    const res = await orch.runTeam({ teamId: 'release-notes', projectId: 'p1' });
    assert.equal(res.halted, 'INSUFFICIENT_CHANGES');
    assert.ok(logLines(proj).some((l) => l.includes('HALT')));
    assert.ok(!events.some((e) => e.name === 'team-stage-started' && e.stage === 'writer'), 'writer never ran');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// AC12: FIX then SHIP converges across one revise round, the writer re-runs, round artifacts are archived.
test('AC12: FIX then SHIP revises once, archives the round, publisher runs on the final SHIP', async () => {
  const proj = tmpProject();
  try {
    seedPack(proj);
    const { orch, events } = makeOrch(proj, {
      researcher: { write: BRIEF },
      writer: [{ write: NOTES_N(0) }, { write: NOTES_N(1) }],
      editor: [{ write: REVIEW('FIX') }, { write: REVIEW('SHIP') }],
      publisher: { write: PUBLISHED },
    });
    orch.on('team-revise-round', (p) => events.push({ name: 'team-revise-round', ...p }));
    const res = await orch.runTeam({ teamId: 'release-notes', projectId: 'p1' });
    assert.equal(res.verdict, 'SHIP');
    assert.equal(res.rounds, 1);
    const revise = events.filter((e) => e.name === 'team-revise-round');
    assert.equal(revise.length, 1, 'one revise-round event for one executed round');
    assert.equal(revise[0].round, 1);
    assert.equal(startedCount(events, 'writer'), 2, 'writer ran on the linear pass + one revise round');
    assert.equal(startedCount(events, 'editor'), 2, 'editor audited twice');
    const runDir = runDirOf(proj);
    assert.ok(fs.existsSync(path.join(runDir, 'published.md')), 'publisher ran on the final SHIP');
    assert.ok(fs.existsSync(path.join(runDir, 'rounds', 'r0-notes.md')), 'round 0 notes archived');
    assert.ok(fs.existsSync(path.join(runDir, 'rounds', 'r0-review.md')), 'round 0 review archived');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// AC13: a BLOCK verdict completes the run but skips the publisher (its runIfVerdict is not met).
test('AC13: editor BLOCK completes the run but skips the publisher', async () => {
  const proj = tmpProject();
  try {
    seedPack(proj);
    const { orch, events } = makeOrch(proj, {
      researcher: { write: BRIEF },
      writer: { write: NOTES },
      editor: { write: REVIEW('BLOCK') },
      publisher: { write: PUBLISHED },
    });
    const res = await orch.runTeam({ teamId: 'release-notes', projectId: 'p1' });
    assert.equal(res.ok, true);
    assert.equal(res.verdict, 'BLOCK');
    assert.ok(!fs.existsSync(path.join(runDirOf(proj), 'published.md')), 'publisher skipped on non-SHIP');
    assert.ok(!events.some((e) => e.name === 'team-stage-started' && e.stage === 'publisher'), 'publisher never started');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});
