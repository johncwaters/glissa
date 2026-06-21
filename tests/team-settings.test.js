'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { buildStageSpawnOptions, teamPermissions, stageModel } = require('../teamlib/team-settings');
const { buildHookSettings } = require('../detection/settings-injector');
const { loadTeam } = require('../teamlib/team-registry');

const TEAM = loadTeam('marketing', path.join(__dirname, '..', 'teams'));
const byId = (id) => TEAM.stages.find((s) => s.id === id);

test('buildStageSpawnOptions yields -p + the stage model + YOLO + ephemeral', () => {
  const r = buildStageSpawnOptions(TEAM, byId('researcher'));
  assert.equal(r.dangerouslySkipPermissions, true); // team mode is "yolo"
  assert.deepEqual(r.extraClaudeArgs, ['-p', '--model', 'opus']);
  assert.equal(r.ephemeral, true);

  const w = buildStageSpawnOptions(TEAM, byId('writer'));
  assert.deepEqual(w.extraClaudeArgs, ['-p', '--model', 'sonnet']);
});

test('buildStageSpawnOptions: enableProjectMcp follows team.runtime.enableProjectMcp', () => {
  // marketing ships no runtime opt-in, so MCP stays off.
  assert.equal(buildStageSpawnOptions(TEAM, byId('researcher')).enableProjectMcp, false);
  const runtimeTeam = { ...TEAM, runtime: { enableProjectMcp: true } };
  assert.equal(buildStageSpawnOptions(runtimeTeam, byId('researcher')).enableProjectMcp, true);
});

test('stageModel defaults to sonnet when unset', () => {
  assert.equal(stageModel({}), 'sonnet');
  assert.equal(stageModel({ model: 'opus' }), 'opus');
});

test('teamPermissions surfaces the deny blacklist', () => {
  const deny = teamPermissions(TEAM).deny;
  assert.ok(deny.includes('Bash(rm *)'));
  assert.ok(deny.includes('Bash(git push*)'));
  assert.equal(teamPermissions({}).deny.length, 0);
});

test('buildHookSettings merges permissions.deny when provided, omits it otherwise', () => {
  const base = { port: 1234, glissaId: 'g1', token: 't1' };
  const withDeny = buildHookSettings({ ...base, permissions: teamPermissions(TEAM) });
  assert.ok(withDeny.permissions && Array.isArray(withDeny.permissions.deny));
  assert.ok(withDeny.permissions.deny.includes('Bash(rm *)'));
  assert.ok(withDeny.hooks, 'hooks still present');

  const noDeny = buildHookSettings(base);
  assert.equal(noDeny.permissions, undefined, 'user sessions get no permissions block');
});

test('buildHookSettings adds enableAllProjectMcpServers only when opted in', () => {
  const base = { port: 1234, glissaId: 'g1', token: 't1' };
  assert.equal(buildHookSettings(base).enableAllProjectMcpServers, undefined, 'absent by default');
  const on = buildHookSettings({ ...base, enableProjectMcp: true });
  assert.equal(on.enableAllProjectMcpServers, true, 'pre-trusts project MCP when opted in');
  assert.ok(on.hooks, 'hooks still present alongside the MCP flag');
});
