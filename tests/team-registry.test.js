'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadTeam, listTeams, validateAndNormalize } = require('../teamlib/team-registry');
const teamOutput = require('../teamlib/team-output');

const REPO_TEAMS = path.join(__dirname, '..', 'teams');
const MKT_DIR = path.join(REPO_TEAMS, 'marketing');
const SHARED_ROLES = ['researcher', 'strategist', 'writer', 'editor', 'publisher'];

test('loadTeam("marketing") loads 5 ordered stages with resolved agent paths', () => {
  const team = loadTeam('marketing', REPO_TEAMS);
  assert.equal(team.id, 'marketing');
  assert.equal(team.outputPath, '.glissa/teams/marketing');
  assert.deepEqual(team.packRequired, ['voice-guide.md', 'avoid-list.md', 'brand.md', 'content-calendar.md', 'channels.md']);
  assert.ok(team.packTemplatesDir.endsWith(path.join('teams', 'marketing', 'pack-templates')));
  assert.equal(team.permissions.mode, 'yolo');
  assert.ok(Array.isArray(team.permissions.deny) && team.permissions.deny.length > 0);
  assert.deepEqual(
    team.stages.map((s) => s.id),
    ['researcher', 'strategist', 'writer', 'editor', 'publisher'],
  );
  for (const s of team.stages) {
    assert.ok(fs.existsSync(s.agentPath), `agent file exists for ${s.id}`);
  }
  assert.deepEqual(team.schedule.days, ['tue', 'thu', 'sat']);
});

test('listTeams includes the marketing team', () => {
  assert.ok(listTeams(REPO_TEAMS).includes('marketing'));
});

// Each invalid definition must throw with the offending field named in the message.
// teamDir = the real marketing dir so the agent-file existence check is never the failure point
// for these earlier-field cases.
const okStage = { id: 'researcher', produces: 'brief.md' };
const invalidCases = [
  ['missing id', { outputPath: 'team/x', stages: [okStage] }, /\bid\b/],
  ['missing outputPath', { id: 'x', stages: [okStage] }, /outputPath/],
  ['stages not an array', { id: 'x', outputPath: 'y', stages: 'no' }, /stages/],
  ['empty stages', { id: 'x', outputPath: 'y', stages: [] }, /stages/],
  ['stage missing id', { id: 'x', outputPath: 'y', stages: [{ produces: 'a.md' }] }, /\bid\b/],
  ['stage missing produces', { id: 'x', outputPath: 'y', stages: [{ id: 'researcher' }] }, /produces/],
  ['bad schedule.days', { id: 'x', outputPath: 'y', schedule: { days: ['funday'] }, stages: [okStage] }, /schedule\.days/],
  ['bad schedule.time', { id: 'x', outputPath: 'y', schedule: { time: '5am' }, stages: [okStage] }, /schedule\.time/],
  ['bad permissions.mode', { id: 'x', outputPath: 'y', permissions: { mode: 'bogus' }, stages: [okStage] }, /permissions\.mode/],
  ['permissions.mode "scoped" is rejected (headless stages cannot answer a prompt)', { id: 'x', outputPath: 'y', permissions: { mode: 'scoped' }, stages: [okStage] }, /permissions\.mode/],
  ['permissions.mode "interactive" is rejected (headless stages cannot answer a prompt)', { id: 'x', outputPath: 'y', permissions: { mode: 'interactive' }, stages: [okStage] }, /permissions\.mode/],
  ['non-array permissions.deny', { id: 'x', outputPath: 'y', permissions: { deny: 'no' }, stages: [okStage] }, /permissions\.deny/],
  ['non-number stageTimeoutSeconds', { id: 'x', outputPath: 'y', stageTimeoutSeconds: '900', stages: [okStage] }, /stageTimeoutSeconds/],
  ['non-positive stageTimeoutSeconds', { id: 'x', outputPath: 'y', stageTimeoutSeconds: 0, stages: [okStage] }, /stageTimeoutSeconds/],
  ['non-array writeScope', { id: 'x', outputPath: 'y', writeScope: 'src/**', stages: [okStage] }, /writeScope/],
  ['non-string writeScope element', { id: 'x', outputPath: 'y', writeScope: ['src/**', 5], stages: [okStage] }, /writeScope/],
  ['non-array testGlobs', { id: 'x', outputPath: 'y', testGlobs: '**/*.test.*', stages: [okStage] }, /testGlobs/],
  ['non-string testGlobs element', { id: 'x', outputPath: 'y', testGlobs: ['**/*.test.*', 5], stages: [okStage] }, /testGlobs/],
  ['non-object chat', { id: 'x', outputPath: 'y', chat: 'no', stages: [okStage] }, /\bchat\b/],
  ['bad chat.allowQuestions', { id: 'x', outputPath: 'y', chat: { allowQuestions: 'yes' }, stages: [okStage] }, /chat\.allowQuestions/],
  ['empty chat.questionMarker', { id: 'x', outputPath: 'y', chat: { questionMarker: '' }, stages: [okStage] }, /chat\.questionMarker/],
  ['bad chat.maxQuestions', { id: 'x', outputPath: 'y', chat: { maxQuestions: 0 }, stages: [okStage] }, /chat\.maxQuestions/],
  ['bad chat.answerTimeoutSec', { id: 'x', outputPath: 'y', chat: { answerTimeoutSec: -1 }, stages: [okStage] }, /chat\.answerTimeoutSec/],
  ['non-object runtime', { id: 'x', outputPath: 'y', runtime: 'no', stages: [okStage] }, /\bruntime\b/],
  ['bad runtime.shareLocalContext', { id: 'x', outputPath: 'y', runtime: { shareLocalContext: 'yes' }, stages: [okStage] }, /runtime\.shareLocalContext/],
  ['bad runtime.enableProjectMcp', { id: 'x', outputPath: 'y', runtime: { enableProjectMcp: 1 }, stages: [okStage] }, /runtime\.enableProjectMcp/],
  ['empty runtime.baseBranch', { id: 'x', outputPath: 'y', runtime: { baseBranch: '  ' }, stages: [okStage] }, /runtime\.baseBranch/],
  ['non-object capture', { id: 'x', outputPath: 'y', stages: [{ ...okStage, capture: 'Topic' }] }, /capture/],
  ['empty capture.section', { id: 'x', outputPath: 'y', stages: [{ ...okStage, capture: { section: ' ', slot: 'topic' } }] }, /capture\.section/],
  ['bad capture.slot', { id: 'x', outputPath: 'y', stages: [{ ...okStage, capture: { section: 'Topic', slot: 'headline' } }] }, /capture\.slot/],
];

for (const [label, def, re] of invalidCases) {
  test(`validateAndNormalize rejects: ${label}`, () => {
    assert.throws(() => validateAndNormalize(def, 'x', MKT_DIR), re);
  });
}

test('validateAndNormalize rejects a stage whose agent prompt file is missing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-team-'));
  try {
    const def = { id: 'x', outputPath: 'y', stages: [{ id: 'ghost', produces: 'g.md' }] };
    assert.throws(() => validateAndNormalize(def, 'x', tmp), /ghost/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a fully valid in-memory definition normalizes (defaults applied)', () => {
  const def = {
    id: 'marketing',
    outputPath: 'team/marketing',
    stages: [{ id: 'researcher', produces: 'brief.md' }],
  };
  const norm = validateAndNormalize(def, 'marketing', MKT_DIR);
  assert.equal(norm.name, 'marketing');
  assert.equal(norm.stageTimeoutSeconds, 900);
  assert.equal(norm.permissions.mode, 'yolo'); // default when omitted (the only supported mode)
  assert.ok(norm.stages[0].agentPath.endsWith(path.join('agents', 'researcher.md')));
});

// --- Phase A: reusable shared agent + pack-template blocks (loadTeam over a temp teams dir) ---

// A minimal valid team.json whose stages are named after the shared roles, so each agent prompt
// resolves from teams/_shared/agents/<id>.md unless overridden by a local block.
function teamDef(id, stages) {
  return {
    id,
    name: id,
    outputPath: `.glissa/teams/${id}`,
    pack: { required: ['voice-guide.md'] },
    stages,
  };
}

function defaultStages() {
  return SHARED_ROLES.map((role) => ({ id: role, produces: `${role}.md` }));
}

// Build a temp teams dir with a populated teams/_shared library and one team under it. Returns the
// teams base dir to pass as loadTeam's second argument.
function makeTmpTeams({
  teamId = 't', stages = defaultStages(), localAgents = {}, def,
  sharedAgents = SHARED_ROLES, sharedPackTemplates = ['voice-guide.md'],
} = {}) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-reg-'));
  const sharedAgentsDir = path.join(baseDir, '_shared', 'agents');
  const sharedPackDir = path.join(baseDir, '_shared', 'pack-templates');
  fs.mkdirSync(sharedAgentsDir, { recursive: true });
  fs.mkdirSync(sharedPackDir, { recursive: true });
  for (const role of sharedAgents) {
    fs.writeFileSync(path.join(sharedAgentsDir, `${role}.md`), `# shared ${role}\n`, 'utf8');
  }
  for (const name of sharedPackTemplates) {
    fs.writeFileSync(path.join(sharedPackDir, name), `# shared template ${name}\n`, 'utf8');
  }

  const teamDir = path.join(baseDir, teamId);
  fs.mkdirSync(teamDir, { recursive: true });
  fs.writeFileSync(path.join(teamDir, 'team.json'), JSON.stringify(def || teamDef(teamId, stages)), 'utf8');

  const localNames = Object.keys(localAgents);
  if (localNames.length > 0) {
    const localAgentsDir = path.join(teamDir, 'agents');
    fs.mkdirSync(localAgentsDir, { recursive: true });
    for (const [name, body] of Object.entries(localAgents)) {
      fs.writeFileSync(path.join(localAgentsDir, `${name}.md`), body, 'utf8');
    }
  }
  return baseDir;
}

function withTmp(baseDir, fn) {
  try {
    return fn();
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

// A1: a team that ships NO local agents/ resolves every stage prompt from teams/_shared/agents/<id>.md.
test('A1: stages with no local agents resolve from _shared/agents by stage id', () => {
  const baseDir = makeTmpTeams({ teamId: 't' });
  withTmp(baseDir, () => {
    const team = loadTeam('t', baseDir);
    const sharedAgentsDir = path.join(baseDir, '_shared', 'agents');
    for (const stage of team.stages) {
      assert.equal(stage.agentPath, path.join(sharedAgentsDir, `${stage.id}.md`),
        `${stage.id} resolves to the shared block`);
      assert.ok(fs.existsSync(stage.agentPath), `${stage.id} agent file exists`);
    }
    assert.ok(!fs.existsSync(path.join(baseDir, 't', 'agents')), 'team ships no local agents/');
  });
});

// A2: explicit stage.agent: "writer" resolves teams/_shared/agents/writer.md.
test('A2: explicit stage.agent resolves the named shared role', () => {
  const stages = [{ id: 'critic', produces: 'critic.md', agent: 'writer' }];
  const baseDir = makeTmpTeams({ teamId: 't', stages });
  withTmp(baseDir, () => {
    const team = loadTeam('t', baseDir);
    const expected = path.join(baseDir, '_shared', 'agents', 'writer.md');
    assert.equal(team.stages[0].agentPath, expected, 'critic uses the shared writer block via stage.agent');
  });
});

// A2: a team-local teams/<id>/agents/<id>.md OVERRIDES the shared role.
test('A2: a team-local agent overrides the shared role', () => {
  const baseDir = makeTmpTeams({ teamId: 't', localAgents: { writer: '# local writer override\n' } });
  withTmp(baseDir, () => {
    const team = loadTeam('t', baseDir);
    const writerStage = team.stages.find((s) => s.id === 'writer');
    const localPath = path.join(baseDir, 't', 'agents', 'writer.md');
    assert.equal(writerStage.agentPath, localPath, 'local writer wins over the shared block');
    const editorStage = team.stages.find((s) => s.id === 'editor');
    assert.equal(editorStage.agentPath, path.join(baseDir, '_shared', 'agents', 'editor.md'),
      'unoverridden stages still come from _shared');
  });
});

// A2: an unresolvable agent fails with a message naming the tried locations.
test('A2: an unresolvable stage agent fails naming the locations tried', () => {
  const stages = [{ id: 'nope', produces: 'nope.md' }];
  const baseDir = makeTmpTeams({ teamId: 't', stages });
  withTmp(baseDir, () => {
    assert.throws(
      () => loadTeam('t', baseDir),
      (err) => {
        assert.ok(/stages\.nope/.test(err.message), 'names the stage field');
        assert.ok(/looked in/.test(err.message), 'names that locations were tried');
        assert.ok(err.message.includes(path.join('t', 'agents', 'nope.md')), 'names the team-local path');
        assert.ok(err.message.includes(path.join('_shared', 'agents', 'nope.md')), 'names the shared path');
        return true;
      },
    );
  });
});

// A2: a stage.agent containing a path separator or ".." is rejected.
test('A2: stage.agent with a path separator or ".." is rejected', () => {
  for (const bad of ['../writer', 'sub/writer', 'sub\\writer', '..']) {
    const stages = [{ id: 's', produces: 's.md', agent: bad }];
    const baseDir = makeTmpTeams({ teamId: 't', stages });
    withTmp(baseDir, () => {
      assert.throws(
        () => loadTeam('t', baseDir),
        (err) => {
          assert.ok(/stages\.s\.agent/.test(err.message), `names the agent field for "${bad}"`);
          return true;
        },
        `rejects stage.agent "${bad}"`,
      );
    });
  }
});

// A4: listTeams() over the real repo teams dir lists the real teams (marketing, qa, changelog) and
// skips _shared (no team.json). Membership form (not an exact-array pin) so adding a future team does not
// re-break this assertion.
test('A4: listTeams lists the real teams and ignores _shared (no team.json)', () => {
  const teams = listTeams(REPO_TEAMS);
  assert.ok(teams.includes('marketing'), 'marketing is a team');
  assert.ok(teams.includes('qa'), 'qa is a team');
  assert.ok(teams.includes('changelog'), 'changelog is a team');
  assert.ok(!teams.includes('release-notes'), 'release-notes is retired');
  assert.ok(!teams.includes('_shared'), '_shared is not listed as a team');
});

// --- Phase B / criterion 9: revise + reviseReads validation (field-naming errors) ---

// A two-stage team (writer then editor) whose editor carries a verdict spec and the given revise block.
// Stages are named after shared roles so the agent prompts resolve from the temp _shared library.
function reviseTeamDef(revise, extra = {}) {
  return teamDef('t', [
    { id: 'writer', produces: 'drafts.md' },
    {
      id: 'editor',
      produces: 'review.md',
      verdict: { marker: 'VERDICT:', values: ['SHIP', 'FIX', 'BLOCK'] },
      revise,
      ...extra,
    },
  ]);
}

test('9a: revise.onVerdict outside verdict.values is rejected', () => {
  const def = reviseTeamDef({ onVerdict: 'NOPE', stages: ['writer'], maxRounds: 2 });
  const baseDir = makeTmpTeams({ teamId: 't', def });
  withTmp(baseDir, () => {
    assert.throws(() => loadTeam('t', baseDir), /stages\.editor\.revise\.onVerdict/);
  });
});

test('9b: revise.maxRounds < 1 is rejected', () => {
  const def = reviseTeamDef({ onVerdict: 'FIX', stages: ['writer'], maxRounds: 0 });
  const baseDir = makeTmpTeams({ teamId: 't', def });
  withTmp(baseDir, () => {
    assert.throws(() => loadTeam('t', baseDir), /stages\.editor\.revise\.maxRounds/);
  });
});

test('9c: revise.stages referencing an unknown stage id is rejected', () => {
  const def = reviseTeamDef({ onVerdict: 'FIX', stages: ['ghost'], maxRounds: 2 });
  const baseDir = makeTmpTeams({ teamId: 't', def });
  withTmp(baseDir, () => {
    assert.throws(() => loadTeam('t', baseDir), /stages\.editor\.revise\.stages/);
  });
});

test('9c: revise.stages referencing a non-earlier (self/forward) stage id is rejected', () => {
  // editor references itself: not an EARLIER stage, so rejected.
  const def = reviseTeamDef({ onVerdict: 'FIX', stages: ['editor'], maxRounds: 2 });
  const baseDir = makeTmpTeams({ teamId: 't', def });
  withTmp(baseDir, () => {
    assert.throws(() => loadTeam('t', baseDir), /stages\.editor\.revise\.stages/);
  });
});

test('9: a stage.reviseReads that is not an array of strings is rejected', () => {
  const def = reviseTeamDef({ onVerdict: 'FIX', stages: ['writer'], maxRounds: 2 }, { reviseReads: 'review.md' });
  const baseDir = makeTmpTeams({ teamId: 't', def });
  withTmp(baseDir, () => {
    assert.throws(() => loadTeam('t', baseDir), /stages\.editor\.reviseReads/);
  });
});

test('9: revise without a verdict spec on the same stage is rejected', () => {
  const def = teamDef('t', [
    { id: 'writer', produces: 'drafts.md' },
    { id: 'editor', produces: 'review.md', revise: { onVerdict: 'FIX', stages: ['writer'] } },
  ]);
  const baseDir = makeTmpTeams({ teamId: 't', def });
  withTmp(baseDir, () => {
    assert.throws(() => loadTeam('t', baseDir), /stages\.editor\.revise/);
  });
});

test('9: a valid revise + reviseReads team loads', () => {
  const def = reviseTeamDef({ onVerdict: 'FIX', stages: ['writer'], maxRounds: 2 }, { reviseReads: ['review.md'] });
  const baseDir = makeTmpTeams({ teamId: 't', def });
  withTmp(baseDir, () => {
    const team = loadTeam('t', baseDir);
    const editor = team.stages.find((s) => s.id === 'editor');
    assert.deepEqual(editor.revise, { onVerdict: 'FIX', stages: ['writer'], maxRounds: 2 });
    assert.deepEqual(editor.reviseReads, ['review.md']);
  });
});

// A5: scaffoldPack copies a required pack file from the fallback (_shared) dir when the team dir lacks it.
test('A5: scaffoldPack copies a required file from the fallback templates dir', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-pack-'));
  try {
    const teamTemplatesDir = path.join(tmp, 'team-templates');
    const fallbackTemplatesDir = path.join(tmp, 'shared-templates');
    fs.mkdirSync(teamTemplatesDir, { recursive: true });
    fs.mkdirSync(fallbackTemplatesDir, { recursive: true });
    // Only the fallback has voice-guide.md; the team dir does not.
    const fallbackBody = '# voice-guide\nfrom the shared fallback\n';
    fs.writeFileSync(path.join(fallbackTemplatesDir, 'voice-guide.md'), fallbackBody, 'utf8');

    const proj = path.join(tmp, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    const outputPath = '.glissa/teams/t';

    const res = teamOutput.scaffoldPack(proj, outputPath, teamTemplatesDir, ['voice-guide.md'], fallbackTemplatesDir);
    assert.ok(res.created.includes('voice-guide.md'), 'voice-guide.md was created');
    const dest = path.join(res.packDir, 'voice-guide.md');
    assert.equal(fs.readFileSync(dest, 'utf8'), fallbackBody, 'content came from the fallback dir');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- pack.shared: the project-level shared-pack declaration ---

// R1: pack.shared must be an array of strings.
test('R1: a non-array pack.shared is rejected naming pack.shared', () => {
  const def = teamDef('t', defaultStages());
  def.pack = { required: ['voice-guide.md'], shared: 'voice-guide.md' };
  const baseDir = makeTmpTeams({ teamId: 't', def });
  withTmp(baseDir, () => {
    assert.throws(() => loadTeam('t', baseDir), /pack\.shared/);
  });
});

// R2: every pack.shared entry must also be in pack.required.
test('R2: a pack.shared entry not in pack.required is rejected naming the entry', () => {
  const def = teamDef('t', defaultStages());
  def.pack = { required: ['voice-guide.md'], shared: ['brand.md'] };
  const baseDir = makeTmpTeams({ teamId: 't', def });
  withTmp(baseDir, () => {
    assert.throws(() => loadTeam('t', baseDir), /pack\.shared.*brand\.md/);
  });
});

// R3a: a shared file with no _shared template is rejected.
test('R3a: a shared file missing its _shared template is rejected', () => {
  const def = teamDef('t', defaultStages());
  def.pack = { required: ['voice-guide.md', 'brand.md'], shared: ['brand.md'] };
  // _shared ships voice-guide.md but NOT brand.md, so the shared brand.md has no template.
  const baseDir = makeTmpTeams({ teamId: 't', def, sharedPackTemplates: ['voice-guide.md'] });
  withTmp(baseDir, () => {
    assert.throws(() => loadTeam('t', baseDir), /shared file "brand\.md" is missing its template/);
  });
});

// R3b: a STRAY team-local template for a shared file does NOT throw (no hard-fail coupling).
test('R3b: a stray team-local template for a shared file does not throw loadTeam', () => {
  const def = teamDef('t', defaultStages());
  def.pack = { required: ['voice-guide.md'], shared: ['voice-guide.md'] };
  const baseDir = makeTmpTeams({ teamId: 't', def, sharedPackTemplates: ['voice-guide.md'] });
  withTmp(baseDir, () => {
    // Leftover team-local template for the shared file: it must be tolerated (just never read).
    const localTpl = path.join(baseDir, 't', 'pack-templates');
    fs.mkdirSync(localTpl, { recursive: true });
    fs.writeFileSync(path.join(localTpl, 'voice-guide.md'), '# stray local override\n', 'utf8');
    const team = loadTeam('t', baseDir);
    assert.deepEqual(team.packShared, ['voice-guide.md']);
  });
});

// R5: a team with no pack.shared normalizes packShared to [].
test('R5: no pack.shared normalizes to packShared []', () => {
  const baseDir = makeTmpTeams({ teamId: 't' });
  withTmp(baseDir, () => {
    assert.deepEqual(loadTeam('t', baseDir).packShared, []);
  });
});

// R6 (invariant guard): no real team ships a team-local template for a file it declares shared. A shared
// file templates ONLY from _shared, so a leftover team-local template would be dead and misleading.
test('R6: no team ships a team-local template for a file it declares shared', () => {
  for (const id of listTeams(REPO_TEAMS)) {
    const team = loadTeam(id, REPO_TEAMS);
    for (const name of team.packShared) {
      const localTpl = path.join(team.teamDir, 'pack-templates', name);
      assert.ok(!fs.existsSync(localTpl), `${id} must NOT ship a team-local template for shared file ${name}`);
      const sharedTpl = path.join(REPO_TEAMS, '_shared', 'pack-templates', name);
      assert.ok(fs.existsSync(sharedTpl), `${id} shared file ${name} must template from _shared`);
    }
  }
});

// R4: the real teams declare the expected shared sets (only marketing shares voice/avoid/brand;
// changelog/qa share nothing).
test('R4: real teams declare the expected packShared', () => {
  assert.deepEqual(loadTeam('marketing', REPO_TEAMS).packShared, ['voice-guide.md', 'avoid-list.md', 'brand.md']);
  assert.deepEqual(loadTeam('changelog', REPO_TEAMS).packShared, []);
  assert.deepEqual(loadTeam('qa', REPO_TEAMS).packShared, []);
});

// --- writeScope + testGlobs validation and normalization (the SHIP-gated auto-merge boundary) ---

const DEFAULT_TEST_GLOBS = ['**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**', '**/__tests__/**'];

test('writeScope omitted normalizes to [] and testGlobs omitted normalizes to DEFAULT_TEST_GLOBS', () => {
  const def = teamDef('t', defaultStages());
  const baseDir = makeTmpTeams({ teamId: 't', def });
  withTmp(baseDir, () => {
    const team = loadTeam('t', baseDir);
    assert.deepEqual(team.writeScope, [], 'writeScope defaults to []');
    assert.deepEqual(team.testGlobs, DEFAULT_TEST_GLOBS, 'testGlobs defaults to the project-agnostic set');
  });
});

test('a real writeScope + testGlobs are normalized (slice-copied) onto the team', () => {
  const def = { ...teamDef('t', defaultStages()), writeScope: ['src/**', 'lib/**'], testGlobs: ['**/*.test.*'] };
  const baseDir = makeTmpTeams({ teamId: 't', def });
  withTmp(baseDir, () => {
    const team = loadTeam('t', baseDir);
    assert.deepEqual(team.writeScope, ['src/**', 'lib/**']);
    assert.deepEqual(team.testGlobs, ['**/*.test.*']);
    assert.notEqual(team.writeScope, def.writeScope, 'writeScope is copied, not the same array');
    assert.notEqual(team.testGlobs, def.testGlobs, 'testGlobs is copied, not the same array');
  });
});

// Backward-compat lock: marketing declares neither field, so writeScope stays [] (its addPaths is
// byte-identical and nothing extra ever merges).
test('loadTeam("marketing").writeScope deep-equals [] (backward-compat lock)', () => {
  const team = loadTeam('marketing', REPO_TEAMS);
  assert.deepEqual(team.writeScope, []);
});

// --- interactive chat config (default-on for manual runs) ---

test('chat defaults to allowQuestions:true with standard bounds when omitted', () => {
  const def = teamDef('t', defaultStages());
  const baseDir = makeTmpTeams({ teamId: 't', def });
  withTmp(baseDir, () => {
    const team = loadTeam('t', baseDir);
    assert.equal(team.chat.allowQuestions, true);
    assert.equal(team.chat.questionMarker, 'QUESTION:');
    assert.equal(team.chat.maxQuestions, 3);
    assert.equal(team.chat.answerTimeoutSec, 600);
  });
});

test('chat.allowQuestions:false is honored (opt-out); other fields still normalize', () => {
  const def = { ...teamDef('t', defaultStages()), chat: { allowQuestions: false, maxQuestions: 5 } };
  const baseDir = makeTmpTeams({ teamId: 't', def });
  withTmp(baseDir, () => {
    const team = loadTeam('t', baseDir);
    assert.equal(team.chat.allowQuestions, false);
    assert.equal(team.chat.maxQuestions, 5);
    assert.equal(team.chat.answerTimeoutSec, 600);
  });
});

test('marketing, qa, and changelog all default chat on (manual interactivity)', () => {
  for (const id of ['marketing', 'qa', 'changelog']) {
    assert.equal(loadTeam(id, REPO_TEAMS).chat.allowQuestions, true, `${id} chat on by default`);
  }
});

// --- runtime: the app-runtime opt-in (share local context, project MCP, pinned base branch) ---

test('runtime omitted normalizes to the feature OFF (existing teams unchanged)', () => {
  const baseDir = makeTmpTeams({ teamId: 't' });
  withTmp(baseDir, () => {
    assert.deepEqual(
      loadTeam('t', baseDir).runtime,
      { shareLocalContext: false, enableProjectMcp: false, baseBranch: null },
    );
  });
});

test('a real runtime opt-in normalizes (booleans coerced, baseBranch trimmed)', () => {
  const def = {
    ...teamDef('t', defaultStages()),
    runtime: { shareLocalContext: true, enableProjectMcp: true, baseBranch: ' develop ' },
  };
  const baseDir = makeTmpTeams({ teamId: 't', def });
  withTmp(baseDir, () => {
    assert.deepEqual(
      loadTeam('t', baseDir).runtime,
      { shareLocalContext: true, enableProjectMcp: true, baseBranch: 'develop' },
    );
  });
});

test('marketing/qa/changelog do not opt into app runtime (backward-compat lock)', () => {
  for (const id of ['marketing', 'qa', 'changelog']) {
    assert.deepEqual(
      loadTeam(id, REPO_TEAMS).runtime,
      { shareLocalContext: false, enableProjectMcp: false, baseBranch: null },
      `${id} runtime off`,
    );
  }
});

test('loadTeam("qa-walk") opts into app runtime (share context, project MCP, develop base)', () => {
  const team = loadTeam('qa-walk', REPO_TEAMS);
  assert.equal(team.id, 'qa-walk');
  assert.equal(team.outputPath, '.glissa/teams/qa-walk');
  assert.deepEqual(team.stages.map((s) => s.id), ['walk']);
  assert.ok(fs.existsSync(team.stages[0].agentPath), 'walk agent prompt exists');
  assert.deepEqual(
    team.stages[0].requiredSections,
    ['First-timer', 'Returning-user', 'Skeptic', 'Summary'],
  );
  assert.deepEqual(
    team.runtime,
    { shareLocalContext: true, enableProjectMcp: true, baseBranch: 'develop' },
  );
  assert.equal(team.permissions.mode, 'yolo');
  assert.deepEqual(team.packRequired, ['how-to-run.md']);
});

// The real qa team loads with the expected roster, writeScope, testGlobs, schedule, and revise config.
test('loadTeam("qa") loads the 4-stage roster with writeScope/testGlobs and a fixer revise loop', () => {
  const team = loadTeam('qa', REPO_TEAMS);
  assert.equal(team.id, 'qa');
  assert.equal(team.outputPath, '.glissa/teams/qa');
  assert.deepEqual(team.stages.map((s) => s.id), ['runner-triager', 'fixer', 'auditor', 'reporter']);
  for (const s of team.stages) {
    assert.ok(s.produces, `${s.id} declares produces`);
    assert.ok(fs.existsSync(s.agentPath), `agent file exists for ${s.id}`);
  }
  assert.deepEqual(team.writeScope, ['src/**', 'lib/**'], 'tests are excluded from writeScope');
  assert.deepEqual(team.testGlobs, DEFAULT_TEST_GLOBS, 'qa uses the default testGlobs set');
  assert.equal(team.schedule.enabled, false, 'schedule ships disabled');
  assert.deepEqual(team.packRequired, ['how-to-run.md', 'flaky-and-known.md', 'fix-policy.md']);
  const auditor = team.stages.find((s) => s.id === 'auditor');
  assert.deepEqual(auditor.revise.stages, ['fixer'], 'auditor revises the earlier fixer stage');
});
