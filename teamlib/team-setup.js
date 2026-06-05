'use strict';

const path = require('node:path');
const { PACK_SENTINEL, resolvePackLayout } = require('./team-output');

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
// [{ name, path }] (absolute paths to the already-scaffolded pack files). `projectContext` is an optional
// pre-rendered markdown block of deterministic starting facts (from project-context.js); when present it is
// injected as advisory context and PASS 1 becomes verify-not-rediscover. Pure (no fs) and brand-neutral so
// it works for any team against any project. With no (or empty) projectContext the output is byte-identical
// to the original prompt.
function buildSetupPrompt(team, {
  packDir, packFiles = [], projectPath, projectContext,
} = {}) {
  const teamName = (team && (team.name || team.id)) || 'this team';
  const fileLines = packFiles
    .map((f) => `  - ${f.path}`)
    .join('\n');
  const hasContext = !!(projectContext && String(projectContext).trim());

  const lines = [
    `You are setting up the "${teamName}" content pipeline for the project at ${projectPath}.`,
    '',
    'Your one job in this session: fill in this project\'s "pack" so the pipeline can run. The pack is',
    'a small set of project-owned input files (brand voice, words to avoid, brand facts, content',
    'calendar, and channels) that every run of the pipeline reads. They live here:',
    `  ${packDir}`,
    '',
  ];

  if (hasContext) {
    lines.push(
      '## STARTING FACTS (gathered automatically from this project\'s non-secret files; confirm before trusting)',
      String(projectContext).trim(),
      '',
    );
  }

  lines.push('Work in two passes.', '');

  if (hasContext) {
    lines.push(
      'PASS 1, LEARN THE PROJECT. The starting facts above were pulled deterministically from this',
      'project\'s README, package.json, and git config. Treat them as a starting point to confirm, not as',
      'authoritative. Verify and extend them by exploring the repository: confirm the product or brand name',
      'and what it does, who the audience is, the content and posting cadence, and which social channels it',
      'targets. Good places to look: README, package.json, any docs or content directories, marketing or',
      'site config, and any social or scheduling configuration. Do not open secrets or .env files.',
    );
  } else {
    lines.push(
      'PASS 1, LEARN THE PROJECT. Explore this repository to infer what you can on your own: the',
      'product or brand name and what it does, who the audience is, the content and posting cadence, and',
      'which social channels it targets. Good places to look: README, package.json, any docs or content',
      'directories, marketing or site config, and any social or scheduling configuration. Do not open',
      'secrets or .env files.',
    );
  }

  lines.push(
    '',
    'PASS 2, FILL THE PACK, one file at a time. Each of these files already exists with a template and',
    `a "${PACK_SENTINEL}" marker:`,
    fileLines,
  );

  // When any file is part of the project-level shared pack (.glissa/pack/), tell the agent so it knows
  // it is filling a value reused by every team, not a team-private one. Gated on a shared-scope file
  // being present, so a prompt with only team-local files is byte-identical to before this feature.
  const sharedNames = packFiles.filter((f) => f && f.scope === 'shared').map((f) => f.name);
  if (sharedNames.length > 0) {
    const verb = sharedNames.length === 1 ? 'is' : 'are';
    lines.push(
      '',
      `Note: ${sharedNames.join(', ')} ${verb} part of this project's shared pack (under .glissa/pack/),`,
      'reused by every team that needs them, so fill each once here.',
    );
  }

  lines.push(
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
  );

  return lines.join('\n');
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

// Absolute pack dir + per-file { name, path, scope } for a team in a project, via the one shared-aware
// resolver so shared files (team.packShared) resolve under the project-level .glissa/pack/ and the rest
// stay team-local. Returns the team-local packDir, the project sharedPackDir, and the flat packFiles list.
function packPaths(projectPath, team) {
  const { packDir, sharedPackDir, files } = resolvePackLayout(
    projectPath, team.outputPath, team.packRequired || [], team.packShared || [],
  );
  return { packDir, sharedPackDir, packFiles: files };
}

module.exports = {
  buildSetupPrompt,
  setupSessionId,
  setupSessionName,
  packPaths,
};
