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

// Validate a parsed definition and return a normalized roster. `teamDir` is needed to confirm each
// stage's agent prompt file (agents/<stage.id>.md) and each pack template (pack-templates/<file>) exist;
// `teamId` is used for clear error text.
function validateAndNormalize(def, teamId, teamDir) {
  if (!def || typeof def !== 'object') fail('team.json', 'is not an object', teamId);
  if (!def.id) fail('id', 'is required', teamId);
  if (!def.outputPath) fail('outputPath', 'is required', teamId);
  if (!Array.isArray(def.stages)) fail('stages', 'must be an array', teamId);
  if (def.stages.length === 0) fail('stages', 'must not be empty', teamId);

  validateSchedule(def.schedule, teamId);
  validatePermissions(def.permissions, teamId);
  validatePack(def.pack, teamId);

  const stages = def.stages.map((stage, i) => {
    if (!stage || typeof stage !== 'object') fail(`stages[${i}]`, 'is not an object', teamId);
    if (!stage.id) fail(`stages[${i}].id`, 'is required', teamId);
    if (!stage.produces) fail(`stages[${stage.id}].produces`, 'is required', teamId);
    const relAgent = path.join('agents', `${stage.id}.md`);
    const agentPath = path.join(teamDir, relAgent);
    if (!fs.existsSync(agentPath)) {
      fail(`stages.${stage.id}`, `is missing its agent prompt file (expected ${relAgent})`, teamId);
    }
    return { ...stage, agentPath };
  });

  // The project pack the team needs, plus the glissa-owned templates used to scaffold it on first run.
  const packRequired = (def.pack && Array.isArray(def.pack.required) && def.pack.required.length > 0)
    ? def.pack.required.slice()
    : DEFAULT_PACK_FILES.slice();
  const packTemplatesDir = path.join(teamDir, 'pack-templates');
  for (const name of packRequired) {
    if (!fs.existsSync(path.join(packTemplatesDir, name))) {
      fail('pack', `is missing its scaffold template (expected pack-templates/${name})`, teamId);
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
    stages,
    teamDir,
    packRequired,
    packTemplatesDir,
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
