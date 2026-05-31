'use strict';

const path = require('node:path');
const { PACK_SENTINEL } = require('./team-output');

// Guided pack setup. The setup phase fills a project's pack (voice, brand, audience, calendar,
// channels) so a team can run. Rather than make the operator hand-edit five template files, Glissa
// spawns one INTERACTIVE Claude session (a normal PTY session, surfaced as a terminal card) seeded
// with the prompt this module builds. That agent reads the target repo, interviews the operator for
// the subjective parts, and writes each pack file in place, removing the GLISSA:NEEDS-INPUT marker.
//
// This is intentionally NOT a headless `claude -p` stage: the interview needs back-and-forth, which a
// headless session cannot do. The per-file guidance lives in the scaffolded template files themselves
// (the agent reads them on disk), so this prompt stays small and never duplicates that content.

// Build the initial prompt for the interactive setup session. `packFiles` is
// [{ name, path }] (absolute paths to the already-scaffolded pack files). Pure and brand-neutral so
// it works for any team against any project.
function buildSetupPrompt(team, { packDir, packFiles = [], projectPath } = {}) {
  const teamName = (team && (team.name || team.id)) || 'this team';
  const fileLines = packFiles
    .map((f) => `  - ${f.path}`)
    .join('\n');

  return [
    `You are setting up the "${teamName}" content pipeline for the project at ${projectPath}.`,
    '',
    'Your one job in this session: fill in this project\'s "pack" so the pipeline can run. The pack is',
    'a small set of project-owned input files (brand voice, words to avoid, brand facts, content',
    'calendar, and channels) that every run of the pipeline reads. They live here:',
    `  ${packDir}`,
    '',
    'Work in two passes.',
    '',
    'PASS 1, LEARN THE PROJECT. Explore this repository to infer what you can on your own: the',
    'product or brand name and what it does, who the audience is, the content and posting cadence, and',
    'which social channels it targets. Good places to look: README, package.json, any docs or content',
    'directories, marketing or site config, and any social or scheduling configuration. Do not open',
    'secrets or .env files.',
    '',
    'PASS 2, FILL THE PACK, one file at a time. Each of these files already exists with a template and',
    `a "${PACK_SENTINEL}" marker:`,
    fileLines,
    '',
    'For each file: read its template first (it explains exactly what belongs there), draft strong',
    'content using what you learned in pass 1, and for anything subjective you cannot reasonably infer',
    '(brand voice and tone, words or phrases to avoid, audience nuances) ask me a short, specific',
    'question right here in the terminal and wait for my answer before writing. Confirm your inferences',
    'rather than interrogating me, and batch related questions where it reads naturally.',
    '',
    `When you write each file, REMOVE the "${PACK_SENTINEL}" marker and any leftover template`,
    'placeholder text, so nothing but real project content remains.',
    '',
    `When every file is filled and no "${PACK_SENTINEL}" marker remains anywhere in the pack, tell me`,
    'exactly: "Pack setup complete. Go to the Teams tab and click Run." Then stop and wait.',
  ].join('\n');
}

// Stable id for a (team, project) setup session, so a second "Set up" click is detected as
// already-running instead of spawning a duplicate interview.
function setupSessionId(teamId, projectId) {
  return `setup:${teamId}:${projectId}`;
}

// Display name for the setup session card.
function setupSessionName(team, projectDisplayName) {
  const teamName = (team && (team.name || team.id)) || 'team';
  return `Setup: ${teamName} ${'→'} ${projectDisplayName || 'project'}`;
}

// Absolute pack dir + per-file { name, path } for a team in a project. Mirrors the layout
// team-output/team-orchestrator use, kept here so backend wiring has one helper to call.
function packPaths(projectPath, team) {
  const packDir = path.join(projectPath, team.outputPath, 'pack');
  const packFiles = (team.packRequired || []).map((name) => ({ name, path: path.join(packDir, name) }));
  return { packDir, packFiles };
}

module.exports = {
  buildSetupPrompt,
  setupSessionId,
  setupSessionName,
  packPaths,
};
