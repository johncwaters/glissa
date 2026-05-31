'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadTeam, listTeams, validateAndNormalize } = require('../teamlib/team-registry');

const REPO_TEAMS = path.join(__dirname, '..', 'teams');
const MKT_DIR = path.join(REPO_TEAMS, 'marketing');

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
  ['non-array permissions.deny', { id: 'x', outputPath: 'y', permissions: { deny: 'no' }, stages: [okStage] }, /permissions\.deny/],
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
  assert.equal(norm.permissions.mode, 'interactive'); // default when omitted
  assert.ok(norm.stages[0].agentPath.endsWith(path.join('agents', 'researcher.md')));
});
