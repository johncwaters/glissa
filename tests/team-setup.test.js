'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  buildSetupPrompt, setupSessionId, setupSessionName, packPaths,
} = require('../teamlib/team-setup');
const { PACK_SENTINEL } = require('../teamlib/team-output');

const TEAM = {
  id: 'marketing',
  name: 'Marketing Pipeline',
  outputPath: '.glissa/teams/marketing',
  packRequired: ['voice-guide.md', 'avoid-list.md', 'brand.md', 'content-calendar.md', 'channels.md'],
};

function promptFor(overrides = {}) {
  const projectPath = overrides.projectPath || '/proj';
  const packDir = path.join(projectPath, TEAM.outputPath, 'pack');
  const packFiles = TEAM.packRequired.map((name) => ({ name, path: path.join(packDir, name) }));
  return buildSetupPrompt(TEAM, { packDir, packFiles, projectPath, ...overrides });
}

test('buildSetupPrompt names the team and the project path', () => {
  const p = promptFor();
  assert.match(p, /Marketing Pipeline/);
  assert.match(p, /\/proj/);
});

test('buildSetupPrompt lists every pack file by absolute path', () => {
  const projectPath = '/proj';
  const packDir = path.join(projectPath, TEAM.outputPath, 'pack');
  const p = promptFor({ projectPath });
  for (const name of TEAM.packRequired) {
    assert.ok(p.includes(path.join(packDir, name)), `prompt should mention ${name} path`);
  }
});

test('buildSetupPrompt tells the agent to remove the sentinel and gives a completion signal', () => {
  const p = promptFor();
  assert.ok(p.includes(PACK_SENTINEL), 'prompt references the needs-input marker');
  assert.match(p, /REMOVE/);
  assert.match(p, /Pack setup complete\. Go to the Teams tab and click Run\./);
});

test('buildSetupPrompt instructs a learn-then-interview flow (no blind autofill)', () => {
  const p = promptFor();
  assert.match(p, /PASS 1/);
  assert.match(p, /PASS 2/);
  assert.match(p, /ask me/i);
  assert.match(p, /Do not open\s+secrets or \.env files\.|Do not open secrets or \.env files\./);
});

test('buildSetupPrompt contains no em or en dashes', () => {
  const p = promptFor();
  assert.equal(p.includes('—'), false, 'no em dash');
  assert.equal(p.includes('–'), false, 'no en dash');
});

test('buildSetupPrompt tolerates a team with no name (falls back to id)', () => {
  const p = buildSetupPrompt({ id: 'x', outputPath: 'o', packRequired: [] }, { packDir: '/p/o/pack', packFiles: [], projectPath: '/p' });
  assert.match(p, /"x"/);
});

test('buildSetupPrompt injects a STARTING FACTS block and reworded PASS 1 when projectContext is given', () => {
  const p = promptFor({ projectContext: '- Project: demo-app\n- Repository: https://github.com/acme/demo-app' });
  assert.match(p, /STARTING FACTS/);
  assert.ok(p.includes('- Project: demo-app'), 'embeds the provided context block');
  assert.match(p, /confirm before trusting/i);
  assert.match(p, /pulled deterministically/i);
  // The original blind-explore wording is replaced when context is present.
  assert.equal(p.includes('Explore this repository to infer what you can on your own'), false);
});

test('buildSetupPrompt output is unchanged when projectContext is absent or empty/whitespace', () => {
  const base = promptFor();
  assert.equal(base.includes('STARTING FACTS'), false, 'no block without context');
  assert.match(base, /Explore this repository to infer what you can on your own/);
  // Empty string and whitespace are treated as absent: byte-identical to the no-context prompt.
  assert.equal(promptFor({ projectContext: '' }), base);
  assert.equal(promptFor({ projectContext: '   \n  ' }), base);
});

test('buildSetupPrompt with context still contains no em or en dashes', () => {
  const p = promptFor({ projectContext: '- Project: demo\n- Description: lean and mean' });
  assert.equal(p.includes('—'), false, 'no em dash');
  assert.equal(p.includes('–'), false, 'no en dash');
});

test('setupSessionId is stable and namespaced', () => {
  assert.equal(setupSessionId('marketing', 'p1'), 'setup:marketing:p1');
});

test('setupSessionName uses the team name, an arrow, and the project name', () => {
  assert.equal(setupSessionName(TEAM, 'milepost'), 'Setup: Marketing Pipeline → milepost');
});

test('setupSessionName falls back when names are missing', () => {
  assert.equal(setupSessionName({ id: 'marketing' }, ''), 'Setup: marketing → project');
  assert.equal(setupSessionName(null, null), 'Setup: team → project');
});

test('packPaths derives the pack dir and per-file paths from outputPath + packRequired', () => {
  const { packDir, packFiles } = packPaths('/proj', TEAM);
  assert.equal(packDir, path.join('/proj', TEAM.outputPath, 'pack'));
  assert.equal(packFiles.length, TEAM.packRequired.length);
  assert.equal(packFiles[0].name, 'voice-guide.md');
  assert.equal(packFiles[0].path, path.join(packDir, 'voice-guide.md'));
});

test('packPaths handles a team with no packRequired', () => {
  const { packFiles } = packPaths('/proj', { outputPath: 'o' });
  assert.deepEqual(packFiles, []);
});
