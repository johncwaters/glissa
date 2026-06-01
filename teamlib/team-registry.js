'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_PACK_FILES } = require('./team-output');

// Load and validate team definitions from teams/<id>/team.json. Validation failures throw an Error
// whose message NAMES the offending field (and the team id), so a malformed definition is rejected with
// a specific reason. Glissa owns the agents (agents/*.md) and the pack scaffold templates
// (pack-templates/*.md); the project owns the filled pack at <outputPath>/pack/ in its own repo.

const DEFAULT_TEAMS_DIR = path.join(__dirname, 'teams');
const WEEKDAY_TOKENS = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
const PERMISSION_MODES = new Set(['yolo', 'scoped', 'interactive']);

// Project-agnostic default for which paths a verdict stage's oracle (the tests) lives at. Used by the
// orchestrator's restore-before-audit (team-git restoreTests) when a team declares writeScope but omits
// its own testGlobs. A team with an unusual layout overrides `testGlobs` in team.json.
const DEFAULT_TEST_GLOBS = ['**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**', '**/__tests__/**'];

function fail(field, message, teamId) {
  const who = teamId ? ` (${teamId})` : '';
  throw new Error(`Invalid team definition${who}: ${field} ${message}`);
}

function validateSchedule(schedule, teamId) {
  if (schedule == null) return; // optional: manual-only teams have no schedule
  if (typeof schedule !== 'object') fail('schedule', 'must be an object', teamId);
  if (schedule.days != null) {
    if (!Array.isArray(schedule.days)) fail('schedule.days', 'must be an array of weekday tokens', teamId);
    for (const d of schedule.days) {
      if (!WEEKDAY_TOKENS.has(String(d).toLowerCase())) {
        fail('schedule.days', `has an invalid weekday token "${d}" (use mon..sun)`, teamId);
      }
    }
  }
  if (schedule.time != null && !/^\d{2}:\d{2}$/.test(String(schedule.time))) {
    fail('schedule.time', 'must be in "HH:MM" form', teamId);
  }
}

function validatePermissions(permissions, teamId) {
  if (permissions == null) return; // optional
  if (typeof permissions !== 'object') fail('permissions', 'must be an object', teamId);
  if (permissions.mode != null && !PERMISSION_MODES.has(permissions.mode)) {
    fail('permissions.mode', 'must be one of yolo, scoped, interactive', teamId);
  }
  if (permissions.deny != null && !Array.isArray(permissions.deny)) {
    fail('permissions.deny', 'must be an array of "Tool(glob)" strings', teamId);
  }
}

function validatePack(pack, teamId) {
  if (pack == null) return; // optional: defaults to the standard pack files
  if (typeof pack !== 'object') fail('pack', 'must be an object', teamId);
  if (pack.required != null) {
    if (!Array.isArray(pack.required) || pack.required.some((f) => typeof f !== 'string')) {
      fail('pack.required', 'must be an array of pack file names', teamId);
    }
  }
}

// The repo-relative globs a run may stage back to the base branch on a final SHIP (the auto-merge
// boundary, applied SHIP-gated in team-orchestrator). Optional; normalizes to [] (stage nothing extra).
function validateWriteScope(writeScope, teamId) {
  if (writeScope == null) return; // optional
  if (!Array.isArray(writeScope) || writeScope.some((g) => typeof g !== 'string')) {
    fail('writeScope', 'must be an array of repo-relative path globs', teamId);
  }
}

// The repo-relative globs identifying the oracle (the tests) that the orchestrator restores to the run's
// base SHA before each audit (restore-before-audit, team-git restoreTests). Optional; normalizes to
// DEFAULT_TEST_GLOBS.
function validateTestGlobs(testGlobs, teamId) {
  if (testGlobs == null) return; // optional
  if (!Array.isArray(testGlobs) || testGlobs.some((g) => typeof g !== 'string')) {
    fail('testGlobs', 'must be an array of repo-relative path globs', teamId);
  }
}

// Resolve a stage's agent prompt file. First match wins:
//   a. explicit `stage.agent` (a bare role name, rejected if it has a path separator or ".."):
//      <baseDir>/_shared/agents/<stage.agent>.md
//   b. team-local: <teamDir>/agents/<stage.id>.md (a team can override one shared block)
//   c. shared-by-name: <baseDir>/_shared/agents/<stage.id>.md (a stage named after a shared role)
//   d. else fail, naming the locations tried.
// `baseDir` is path.dirname(teamDir), so the shared library lives at teams/_shared/.
function resolveAgentPath(stage, teamDir, baseDir, teamId) {
  const sharedAgentsDir = path.join(baseDir, '_shared', 'agents');
  if (stage.agent != null) {
    const agent = String(stage.agent);
    if (agent.includes('/') || agent.includes('\\') || agent.includes('..')) {
      fail(`stages.${stage.id}.agent`, 'must be a bare role name (no path separators or "..")', teamId);
    }
    return path.join(sharedAgentsDir, `${agent}.md`);
  }
  const localPath = path.join(teamDir, 'agents', `${stage.id}.md`);
  if (fs.existsSync(localPath)) return localPath;
  const sharedPath = path.join(sharedAgentsDir, `${stage.id}.md`);
  if (fs.existsSync(sharedPath)) return sharedPath;
  fail(`stages.${stage.id}`, `is missing its agent prompt file (looked in ${localPath}, ${sharedPath})`, teamId);
  return null; // unreachable; fail() throws
}

// Validate a stage's optional revise loop config (the generic FIX-revision mechanism). `priorIds` is
// the set of stage ids that appear BEFORE this stage, so revise.stages can only point at earlier stages
// (a forward or self reference is rejected). A field-naming error is thrown on any violation.
function validateStageRevise(stage, priorIds, teamId) {
  if (stage.reviseReads != null) {
    if (!Array.isArray(stage.reviseReads) || stage.reviseReads.some((f) => typeof f !== 'string')) {
      fail(`stages.${stage.id}.reviseReads`, 'must be an array of handoff file names', teamId);
    }
  }
  if (stage.revise == null) return;
  if (typeof stage.revise !== 'object' || Array.isArray(stage.revise)) {
    fail(`stages.${stage.id}.revise`, 'must be an object', teamId);
  }
  const verdictValues = (stage.verdict && Array.isArray(stage.verdict.values)) ? stage.verdict.values : null;
  if (!verdictValues) {
    fail(`stages.${stage.id}.revise`, 'requires a verdict spec on the same stage', teamId);
  }
  if (typeof stage.revise.onVerdict !== 'string' || !verdictValues.includes(stage.revise.onVerdict)) {
    fail(`stages.${stage.id}.revise.onVerdict`, `must be one of this stage's verdict values (${verdictValues.join(', ')})`, teamId);
  }
  if (stage.revise.maxRounds != null
    && (!Number.isInteger(stage.revise.maxRounds) || stage.revise.maxRounds < 1)) {
    fail(`stages.${stage.id}.revise.maxRounds`, 'must be an integer >= 1', teamId);
  }
  if (!Array.isArray(stage.revise.stages) || stage.revise.stages.length === 0) {
    fail(`stages.${stage.id}.revise.stages`, 'must be a non-empty array of earlier stage ids', teamId);
  }
  for (const id of stage.revise.stages) {
    if (typeof id !== 'string' || !priorIds.includes(id)) {
      fail(`stages.${stage.id}.revise.stages`, `references "${id}", which is not the id of an earlier stage`, teamId);
    }
  }
}

// Validate a parsed definition and return a normalized roster. `teamDir` is needed to confirm each
// stage's agent prompt file (resolved local-then-shared, see resolveAgentPath) and each pack template
// (pack-templates/<file>, team dir or _shared fallback) exist; `teamId` is used for clear error text.
function validateAndNormalize(def, teamId, teamDir) {
  if (!def || typeof def !== 'object') fail('team.json', 'is not an object', teamId);
  if (!def.id) fail('id', 'is required', teamId);
  if (!def.outputPath) fail('outputPath', 'is required', teamId);
  if (!Array.isArray(def.stages)) fail('stages', 'must be an array', teamId);
  if (def.stages.length === 0) fail('stages', 'must not be empty', teamId);

  validateSchedule(def.schedule, teamId);
  validatePermissions(def.permissions, teamId);
  validatePack(def.pack, teamId);
  validateWriteScope(def.writeScope, teamId);
  validateTestGlobs(def.testGlobs, teamId);

  const baseDir = path.dirname(teamDir);

  const priorIds = [];
  const stages = def.stages.map((stage, i) => {
    if (!stage || typeof stage !== 'object') fail(`stages[${i}]`, 'is not an object', teamId);
    if (!stage.id) fail(`stages[${i}].id`, 'is required', teamId);
    if (!stage.produces) fail(`stages[${stage.id}].produces`, 'is required', teamId);
    const agentPath = resolveAgentPath(stage, teamDir, baseDir, teamId);
    validateStageRevise(stage, priorIds, teamId);
    priorIds.push(stage.id);
    return { ...stage, agentPath };
  });

  // The project pack the team needs, plus the glissa-owned templates used to scaffold it on first run.
  // A required template resolves from the team dir first, then the shared _shared/pack-templates fallback.
  const packRequired = (def.pack && Array.isArray(def.pack.required) && def.pack.required.length > 0)
    ? def.pack.required.slice()
    : DEFAULT_PACK_FILES.slice();
  const packTemplatesDir = path.join(teamDir, 'pack-templates');
  const packTemplatesFallbackDir = path.join(baseDir, '_shared', 'pack-templates');
  for (const name of packRequired) {
    const local = path.join(packTemplatesDir, name);
    const shared = path.join(packTemplatesFallbackDir, name);
    if (!fs.existsSync(local) && !fs.existsSync(shared)) {
      fail('pack', `is missing its scaffold template (looked in ${local}, ${shared})`, teamId);
    }
  }

  return {
    id: def.id,
    name: def.name || def.id,
    description: def.description || '',
    schemaVersion: def.schemaVersion || 1,
    outputPath: def.outputPath,
    schedule: def.schedule || null,
    permissions: def.permissions || { mode: 'interactive', deny: [] },
    stageTimeoutSeconds: def.stageTimeoutSeconds || 900,
    // The SHIP-gated auto-merge boundary; default [] (a team stages only the run folder + log, so
    // marketing's addPaths stays byte-identical and nothing extra merges).
    writeScope: (def.writeScope && def.writeScope.length) ? def.writeScope.slice() : [],
    // The restore-before-audit oracle pathspec; default DEFAULT_TEST_GLOBS so the guard always has a
    // sane project-agnostic test matcher even when a team omits it. (Inert unless writeScope is set.)
    testGlobs: (def.testGlobs && def.testGlobs.length) ? def.testGlobs.slice() : DEFAULT_TEST_GLOBS.slice(),
    stages,
    teamDir,
    packRequired,
    packTemplatesDir,
    packTemplatesFallbackDir,
  };
}

function loadTeam(teamId, baseDir = DEFAULT_TEAMS_DIR) {
  const teamDir = path.join(baseDir, teamId);
  const jsonPath = path.join(teamDir, 'team.json');
  if (!fs.existsSync(jsonPath)) {
    fail('team.json', `not found at ${jsonPath}`, teamId);
  }
  let def;
  try {
    def = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (err) {
    fail('team.json', `is not valid JSON (${err.message})`, teamId);
  }
  return validateAndNormalize(def, teamId, teamDir);
}

function listTeams(baseDir = DEFAULT_TEAMS_DIR) {
  if (!fs.existsSync(baseDir)) return [];
  return fs.readdirSync(baseDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(baseDir, d.name, 'team.json')))
    .map((d) => d.name)
    .sort();
}

module.exports = {
  loadTeam, listTeams, validateAndNormalize, DEFAULT_TEAMS_DIR,
};
