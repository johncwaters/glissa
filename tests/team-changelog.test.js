'use strict';

// Acceptance tests for the changelog team. Like marketing / qa, the team is data + role
// markdown + pack templates with ZERO engine changes, so these tests drive the REAL engine (loadTeam over
// the repo teams dir; the orchestrator with a fake stage spawner) the same way the other team tests do.
//
// The changelog team's distinguishing trait is that the curator edits the project's CHANGELOG file IN PLACE
// (like the qa fixer edits source), so the team declares a non-empty writeScope: on a final SHIP the edited
// changelog auto-merges back, bounded to changelog files; tests excluded. The orchestrator's
// restore-before-audit only touches testGlobs paths, so a CHANGELOG edit is never reverted by it. The
// in-place edit + merge path needs a real git harness (see tests/team-git.test.js); these tests cover the
// definition, the stage gating, the halt, and the revise loop with a fake spawner.

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
const TEAM_DIR = path.join(REPO_TEAMS, 'changelog');
const OUT = '.glissa/teams/changelog';
const REQUIRED = ['changelog-config.md', 'style-guide.md', 'announce-config.md'];
const STAGE_IDS = ['analyst', 'curator', 'auditor', 'announcer'];
const ROLE_FILES = STAGE_IDS.map((id) => path.join(TEAM_DIR, 'agents', `${id}.md`));
const DEFAULT_TEST_GLOBS = ['**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**', '**/__tests__/**'];
const WRITE_SCOPE = [
  'CHANGELOG.md', 'CHANGELOG.*', '**/CHANGELOG.md', '**/CHANGELOG.*',
  'CHANGES.md', 'HISTORY.md', 'NEWS.md', 'docs/**/CHANGELOG*',
];

// Sample stage outputs for the orchestrator runs. The analyst's required sections gate the handoff; the
// orchestrator's topic special-case is keyed to stage id 'researcher', so this team logs a generic topic
// (like qa) and the tests assert on the verdict, not the topic.
const ANALYSIS = '## Topic\nUnreleased reconcile (3 commits)\n## Range\nv1.3.0..HEAD\n'
  + '## Current state\nKeep a Changelog; Unreleased present.\n'
  + '## Discrepancies\n- MISSING: login fix (abc123)\n'
  + '## Proposed changes\n- Add "Fixed login redirect" under Unreleased / Fixed (abc123)\n'
  + '## Sources\n- abc123\n';
const REVISION = '## Edited\nCHANGELOG.md (Keep a Changelog)\n'
  + '## Changes applied\n- added: Fixed login redirect (abc123)\n## Unresolved\nNone.\n';
const REVIEW = (v) => '## Accuracy\nEvery entry traces to a commit; nothing missing.\n'
  + '## Format\nSections and ordering match the convention.\n## Style\nNo banned terms, no emoji, no dashes.\n'
  + `## Summary\nReconciled cleanly.\nVERDICT: ${v}\n`;
const PUBLISHED = '## Summary\nReconciled the Unreleased section against 3 commits; no follow-ups.\n'
  + '## Announcement draft\nTag v1.4.0. Fixed a login redirect bug (abc123).\n';
// Distinct revision per round so the no-progress guard does not bail.
const REVISION_N = (n) => '## Edited\nCHANGELOG.md\n'
  + `## Changes applied\n- added: Fixed login redirect (abc123). Pass ${n}.\n## Unresolved\nNone.\n`;

// --- Fake stage spawner + orchestrator wiring (mirrors the other team tests) ---

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
    now: () => new Date(Date.UTC(2026, 5, 4, 18, 0, 0)),
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-cl-'));
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

test('AC1/AC2: changelog loads with id/outputPath and the four stages', () => {
  const team = loadTeam('changelog', REPO_TEAMS);
  assert.equal(team.id, 'changelog');
  assert.equal(team.outputPath, '.glissa/teams/changelog');
  assert.deepEqual(team.stages.map((s) => s.id), STAGE_IDS);
});

test('AC3: every stage agent resolves under the team dir, none under _shared', () => {
  const team = loadTeam('changelog', REPO_TEAMS);
  const localAgents = path.join('changelog', 'agents');
  for (const s of team.stages) {
    assert.ok(fs.existsSync(s.agentPath), `${s.id} agent file exists`);
    assert.ok(s.agentPath.includes(localAgents), `${s.id} resolves under the team dir`);
    assert.ok(!s.agentPath.includes('_shared'), `${s.id} does not resolve from _shared`);
  }
});

test('AC4: packRequired matches and each ships a team-local template', () => {
  const team = loadTeam('changelog', REPO_TEAMS);
  assert.deepEqual(team.packRequired, REQUIRED);
  for (const name of REQUIRED) {
    assert.ok(fs.existsSync(path.join(TEAM_DIR, 'pack-templates', name)), `${name} template shipped`);
  }
});

test('AC5: listTeams includes changelog (and still marketing)', () => {
  const teams = listTeams(REPO_TEAMS);
  assert.ok(teams.includes('changelog'));
  assert.ok(teams.includes('marketing'));
});

test('AC6: auditor verdict/revise/reviseReads and curator reviseReads are wired', () => {
  const team = loadTeam('changelog', REPO_TEAMS);
  const auditor = team.stages.find((s) => s.id === 'auditor');
  const curator = team.stages.find((s) => s.id === 'curator');
  assert.deepEqual(auditor.verdict.values, ['SHIP', 'FIX', 'BLOCK']);
  assert.deepEqual(auditor.revise, { onVerdict: 'FIX', stages: ['curator'], maxRounds: 2 });
  assert.deepEqual(auditor.reviseReads, ['review.md']);
  assert.deepEqual(curator.reviseReads, ['review.md', 'revision.md']);
});

// The team edits a real repo file, so it declares a changelog-scoped writeScope (the SHIP-gated merge
// boundary); testGlobs stays the default set so restore-before-audit never reverts the changelog.
test('AC6c: writeScope is the changelog file set and testGlobs is the default set', () => {
  const team = loadTeam('changelog', REPO_TEAMS);
  assert.deepEqual(team.writeScope, WRITE_SCOPE);
  assert.deepEqual(team.testGlobs, DEFAULT_TEST_GLOBS);
  for (const g of WRITE_SCOPE) {
    assert.ok(!DEFAULT_TEST_GLOBS.includes(g), `writeScope glob ${g} is not a test glob`);
  }
});

test('AC6b: teamPermissions yields a non-empty deny-list with the state-change blockers', () => {
  const team = loadTeam('changelog', REPO_TEAMS);
  assert.equal(team.permissions.mode, 'yolo');
  const { deny } = teamPermissions(team);
  assert.ok(Array.isArray(deny) && deny.length > 0, 'deny-list is non-empty');
  for (const blocker of ['Bash(git push*)', 'Bash(git commit*)', 'Bash(git rebase*)', 'Bash(gh api*)']) {
    assert.ok(deny.includes(blocker), `deny-list blocks ${blocker}`);
  }
});

test('AC15: announcer carries the engine-honored runIfVerdict/optional gate and produces published.md', () => {
  const team = loadTeam('changelog', REPO_TEAMS);
  const announcer = team.stages.find((s) => s.id === 'announcer');
  assert.equal(announcer.runIfVerdict, 'SHIP');
  assert.equal(announcer.optional, true);
  assert.equal(announcer.produces, 'published.md');
  assert.deepEqual(announcer.requiredSections, ['Summary', 'Announcement draft']);
});

// AC16: exactly one verdict stage (the auditor). The announcer is a post-SHIP draft stage, NOT a second
// verdict pipeline, so the CHANGELOG writeScope merge stays gated on the single auditor verdict.
test('AC16: the auditor is the only verdict stage', () => {
  const team = loadTeam('changelog', REPO_TEAMS);
  const verdictStages = team.stages.filter((s) => s.verdict);
  assert.deepEqual(verdictStages.map((s) => s.id), ['auditor']);
});

// --- Behavioral / content guard (lint-style, no spawning) ---

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

test('AC8: first run with no pack scaffolds + halts, runs zero stages', async () => {
  const proj = tmpProject();
  try {
    const { orch, events } = makeOrch(proj, { analyst: { write: ANALYSIS } });
    const res = await orch.runTeam({ teamId: 'changelog', projectId: 'p1', trigger: 'manual' });
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

test('AC9: happy path reaches all four stages on SHIP', async () => {
  const proj = tmpProject();
  try {
    seedPack(proj);
    const { orch, events } = makeOrch(proj, {
      analyst: { write: ANALYSIS },
      curator: { write: REVISION },
      auditor: { write: REVIEW('SHIP') },
      announcer: { write: PUBLISHED },
    });
    const res = await orch.runTeam({ teamId: 'changelog', projectId: 'p1', trigger: 'manual' });
    assert.equal(res.ok, true);
    assert.equal(res.verdict, 'SHIP');
    const runDir = runDirOf(proj);
    for (const f of ['analysis.md', 'revision.md', 'review.md', 'published.md']) {
      assert.ok(fs.existsSync(path.join(runDir, f)), `${f} written`);
    }
    const published = fs.readFileSync(path.join(runDir, 'published.md'), 'utf8');
    assert.ok(/^##\s*Summary\b/m.test(published), 'published.md has a Summary section');
    assert.ok(/^##\s*Announcement draft\b/m.test(published), 'published.md has an Announcement draft section');
    assert.equal(events.filter((e) => e.name === 'team-stage-complete').length, 4);
    assert.ok(logLines(proj).some((l) => l.includes('SHIP')), 'run log records the verdict');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('AC10: an analysis missing a required section fails the analyst before the curator runs', async () => {
  const proj = tmpProject();
  try {
    seedPack(proj);
    const noSources = '## Topic\nUnreleased reconcile\n## Range\nv1.3.0..HEAD\n'
      + '## Current state\nfine\n## Discrepancies\n- MISSING: a thing (abc123)\n'
      + '## Proposed changes\n- add a thing (abc123)\n';
    const { orch } = makeOrch(proj, { analyst: { write: noSources }, curator: { write: REVISION } });
    const res = await orch.runTeam({ teamId: 'changelog', projectId: 'p1' });
    assert.equal(res.failedStage, 'analyst');
    assert.ok(res.missing.includes('Sources'), 'names the absent section');
    assert.ok(!fs.existsSync(path.join(runDirOf(proj), 'revision.md')), 'curator never ran');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('AC11: analyst CHANGELOG_ACCURATE halts the run', async () => {
  const proj = tmpProject();
  try {
    seedPack(proj);
    const { orch, events } = makeOrch(proj, { analyst: { write: 'CHANGELOG_ACCURATE\n' } });
    const res = await orch.runTeam({ teamId: 'changelog', projectId: 'p1' });
    assert.equal(res.halted, 'CHANGELOG_ACCURATE');
    assert.ok(logLines(proj).some((l) => l.includes('HALT')));
    assert.ok(!events.some((e) => e.name === 'team-stage-started' && e.stage === 'curator'), 'curator never ran');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('AC12: FIX then SHIP revises once, archives the round, announcer runs on the final SHIP', async () => {
  const proj = tmpProject();
  try {
    seedPack(proj);
    const { orch, events } = makeOrch(proj, {
      analyst: { write: ANALYSIS },
      curator: [{ write: REVISION_N(0) }, { write: REVISION_N(1) }],
      auditor: [{ write: REVIEW('FIX') }, { write: REVIEW('SHIP') }],
      announcer: { write: PUBLISHED },
    });
    orch.on('team-revise-round', (p) => events.push({ name: 'team-revise-round', ...p }));
    const res = await orch.runTeam({ teamId: 'changelog', projectId: 'p1' });
    assert.equal(res.verdict, 'SHIP');
    assert.equal(res.rounds, 1);
    const revise = events.filter((e) => e.name === 'team-revise-round');
    assert.equal(revise.length, 1, 'one revise-round event for one executed round');
    assert.equal(revise[0].round, 1);
    assert.equal(startedCount(events, 'curator'), 2, 'curator ran on the linear pass + one revise round');
    assert.equal(startedCount(events, 'auditor'), 2, 'auditor audited twice');
    const runDir = runDirOf(proj);
    assert.ok(fs.existsSync(path.join(runDir, 'published.md')), 'announcer ran on the final SHIP');
    assert.ok(fs.existsSync(path.join(runDir, 'rounds', 'r0-revision.md')), 'round 0 revision archived');
    assert.ok(fs.existsSync(path.join(runDir, 'rounds', 'r0-review.md')), 'round 0 review archived');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('AC13: auditor BLOCK completes the run but skips the announcer', async () => {
  const proj = tmpProject();
  try {
    seedPack(proj);
    const { orch, events } = makeOrch(proj, {
      analyst: { write: ANALYSIS },
      curator: { write: REVISION },
      auditor: { write: REVIEW('BLOCK') },
      announcer: { write: PUBLISHED },
    });
    const res = await orch.runTeam({ teamId: 'changelog', projectId: 'p1' });
    assert.equal(res.ok, true);
    assert.equal(res.verdict, 'BLOCK');
    assert.ok(!fs.existsSync(path.join(runDirOf(proj), 'published.md')), 'announcer skipped on non-SHIP');
    assert.ok(!events.some((e) => e.name === 'team-stage-started' && e.stage === 'announcer'), 'announcer never started');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});
