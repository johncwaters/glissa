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

// scoped/interactive are recognized SHAPES but are guaranteed-broken at runtime: every stage runs
// headless (`claude -p`), which cannot answer a permission prompt, so either mode hangs a stage
// forever on its first tool call. yolo (plus the permissions.deny guardrail) is the only supported
// mode; reject the other two at load time instead of leaving the footgun for a run to discover.
function checkPermissionModeSupported(mode, teamId) {
  if (mode !== 'scoped' && mode !== 'interactive') return;
  fail(
    'permissions.mode',
    `"${mode}" is not supported: every stage runs headless (claude -p) and cannot answer a permission `
      + 'prompt, so this mode would hang the stage forever on its first tool call. Use "yolo" and rely '
      + 'on permissions.deny as the guardrail.',
    teamId,
  );
}

function validatePermissions(permissions, teamId) {
  if (permissions == null) return; // optional
  if (typeof permissions !== 'object') fail('permissions', 'must be an object', teamId);
  if (permissions.mode != null && !PERMISSION_MODES.has(permissions.mode)) {
    fail('permissions.mode', 'must be one of yolo, scoped, interactive', teamId);
  }
  checkPermissionModeSupported(permissions.mode, teamId);
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
  // pack.shared: the subset of required files that live in the PROJECT-LEVEL shared pack (.glissa/pack/)
  // and are reused across teams. Shape-validated here; the "shared subset of required" and the
  // "shared template ships in _shared" checks happen in validateAndNormalize (where packRequired exists).
  if (pack.shared != null) {
    if (!Array.isArray(pack.shared) || pack.shared.some((f) => typeof f !== 'string')) {
      fail('pack.shared', 'must be an array of pack file names', teamId);
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

// Validate the optional interactive-chat config (Teams chat + operator-question loop). All fields are
// optional; defaults make the feature on for manual runs. A team opts out with chat.allowQuestions:false.
function validateChat(chat, teamId) {
  if (chat == null) return; // optional: defaults applied at normalization
  if (typeof chat !== 'object' || Array.isArray(chat)) fail('chat', 'must be an object', teamId);
  if (chat.allowQuestions != null && typeof chat.allowQuestions !== 'boolean') {
    fail('chat.allowQuestions', 'must be a boolean', teamId);
  }
  if (chat.questionMarker != null
    && (typeof chat.questionMarker !== 'string' || chat.questionMarker.trim() === '')) {
    fail('chat.questionMarker', 'must be a non-empty string', teamId);
  }
  if (chat.maxQuestions != null && (!Number.isInteger(chat.maxQuestions) || chat.maxQuestions < 1)) {
    fail('chat.maxQuestions', 'must be an integer >= 1', teamId);
  }
  if (chat.answerTimeoutSec != null
    && (!Number.isInteger(chat.answerTimeoutSec) || chat.answerTimeoutSec < 1)) {
    fail('chat.answerTimeoutSec', 'must be an integer >= 1', teamId);
  }
}

// Validate the optional app-runtime config. A team opts in here when its stage must actually BOOT the
// target app and/or drive a browser (e.g. the persona QA walk), which a bare file-in/file-out worktree
// cannot do. All fields optional; defaults make the feature OFF (existing teams unchanged).
//   - shareLocalContext: junction/copy the project's gitignored local context (node_modules, .env*,
//     .claude, .omc) into the run worktree, the same machinery sessions use, so the agent can run the app.
//   - enableProjectMcp: pre-trust the project's `.mcp.json` servers in the headless (`-p`) stage.
//   - baseBranch: fork the run worktree off THIS branch (the one holding the walk inputs), not the
//     operator's currently-checked-out HEAD. The run BLOCKS if the branch is missing (orchestrator).
function validateRuntime(runtime, teamId) {
  if (runtime == null) return; // optional
  if (typeof runtime !== 'object' || Array.isArray(runtime)) fail('runtime', 'must be an object', teamId);
  if (runtime.shareLocalContext != null && typeof runtime.shareLocalContext !== 'boolean') {
    fail('runtime.shareLocalContext', 'must be a boolean', teamId);
  }
  if (runtime.enableProjectMcp != null && typeof runtime.enableProjectMcp !== 'boolean') {
    fail('runtime.enableProjectMcp', 'must be a boolean', teamId);
  }
  if (runtime.baseBranch != null
    && (typeof runtime.baseBranch !== 'string' || runtime.baseBranch.trim() === '')) {
    fail('runtime.baseBranch', 'must be a non-empty string', teamId);
  }
}

// A stage's spawn timeout budget in seconds (see team-orchestrator.js runStage). Optional; normalizes
// to 900 (below).
function validateStageTimeoutSeconds(stageTimeoutSeconds, teamId) {
  if (stageTimeoutSeconds == null) return; // optional
  if (typeof stageTimeoutSeconds !== 'number' || !Number.isFinite(stageTimeoutSeconds) || stageTimeoutSeconds <= 0) {
    fail('stageTimeoutSeconds', 'must be a positive number', teamId);
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

// Validate a stage's optional run-log capture config: `capture` publishes one handoff section's first
// line into a run-log column (the log line format is "date | topic | platforms | status").
const CAPTURE_SLOTS = new Set(['topic', 'platforms']);
function validateStageCapture(stage, teamId) {
  if (stage.capture == null) return;
  if (typeof stage.capture !== 'object' || Array.isArray(stage.capture)) {
    fail(`stages.${stage.id}.capture`, 'must be an object', teamId);
  }
  if (typeof stage.capture.section !== 'string' || !stage.capture.section.trim()) {
    fail(`stages.${stage.id}.capture.section`, 'must be a non-empty section heading', teamId);
  }
  if (!CAPTURE_SLOTS.has(stage.capture.slot)) {
    fail(`stages.${stage.id}.capture.slot`, 'must be one of topic, platforms', teamId);
  }
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
  validateStageTimeoutSeconds(def.stageTimeoutSeconds, teamId);
  validatePack(def.pack, teamId);
  validateWriteScope(def.writeScope, teamId);
  validateTestGlobs(def.testGlobs, teamId);
  validateChat(def.chat, teamId);
  validateRuntime(def.runtime, teamId);

  const baseDir = path.dirname(teamDir);

  const priorIds = [];
  const stages = def.stages.map((stage, i) => {
    if (!stage || typeof stage !== 'object') fail(`stages[${i}]`, 'is not an object', teamId);
    if (!stage.id) fail(`stages[${i}].id`, 'is required', teamId);
    if (!stage.produces) fail(`stages[${stage.id}].produces`, 'is required', teamId);
    const agentPath = resolveAgentPath(stage, teamDir, baseDir, teamId);
    validateStageCapture(stage, teamId);
    validateStageRevise(stage, priorIds, teamId);
    priorIds.push(stage.id);
    return { ...stage, agentPath };
  });

  // The project pack the team needs, plus the glissa-owned templates used to scaffold it on first run.
  // A required template resolves from the team dir first, then the shared _shared/pack-templates fallback.
  const packRequired = (def.pack && Array.isArray(def.pack.required) && def.pack.required.length > 0)
    ? def.pack.required.slice()
    : DEFAULT_PACK_FILES.slice();
  // pack.shared: the subset of required files filled once in the project-level shared pack (.glissa/pack/)
  // and reused by every team that declares them. Each must be a required file, and each templates ONLY
  // from the shared library (a shared file is project-level, not team-flavored).
  const packShared = (def.pack && Array.isArray(def.pack.shared)) ? def.pack.shared.slice() : [];
  const packTemplatesDir = path.join(teamDir, 'pack-templates');
  const packTemplatesFallbackDir = path.join(baseDir, '_shared', 'pack-templates');
  for (const name of packShared) {
    if (!packRequired.includes(name)) {
      fail('pack.shared', `entry "${name}" is not in pack.required`, teamId);
    }
  }
  for (const name of packRequired) {
    const local = path.join(packTemplatesDir, name);
    const shared = path.join(packTemplatesFallbackDir, name);
    if (packShared.includes(name)) {
      // A shared file's template must live in the shared library. A stray team-local template (if any) is
      // simply never read for a shared file (the scaffold templates shared files from _shared only); it is
      // NOT a hard failure here, so a half-applied change cannot crash loadTeam in a managed project. The
      // "no team ships a local template for a shared file" invariant is enforced by a CI guard test.
      if (!fs.existsSync(shared)) {
        fail('pack', `shared file "${name}" is missing its template in ${shared}`, teamId);
      }
      continue;
    }
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
    // yolo is the only supported mode (see checkPermissionModeSupported); default to it so a team that
    // omits permissions entirely runs instead of silently normalizing to a mode that hangs every stage.
    permissions: def.permissions || { mode: 'yolo', deny: [] },
    stageTimeoutSeconds: def.stageTimeoutSeconds || 900,
    // The SHIP-gated auto-merge boundary; default [] (a team stages only the run folder + log, so
    // marketing's addPaths stays byte-identical and nothing extra merges).
    writeScope: (def.writeScope && def.writeScope.length) ? def.writeScope.slice() : [],
    // The restore-before-audit oracle pathspec; default DEFAULT_TEST_GLOBS so the guard always has a
    // sane project-agnostic test matcher even when a team omits it. (Inert unless writeScope is set.)
    testGlobs: (def.testGlobs && def.testGlobs.length) ? def.testGlobs.slice() : DEFAULT_TEST_GLOBS.slice(),
    // Interactive Teams chat + operator-question loop. ON by default (manual runs); a team opts out with
    // chat.allowQuestions:false. The orchestrator scopes the question pause to trigger==='manual' so
    // scheduled/unattended runs never block.
    chat: {
      allowQuestions: def.chat?.allowQuestions !== false,
      questionMarker: def.chat?.questionMarker || 'QUESTION:',
      maxQuestions: Number.isInteger(def.chat?.maxQuestions) ? def.chat.maxQuestions : 3,
      answerTimeoutSec: Number.isInteger(def.chat?.answerTimeoutSec) ? def.chat.answerTimeoutSec : 600,
    },
    // App-runtime opt-in. Normalized to an always-present object with the feature OFF by default, so a
    // team that omits `runtime` behaves exactly as before (bare worktree, no project MCP, HEAD base).
    runtime: {
      shareLocalContext: def.runtime?.shareLocalContext === true,
      enableProjectMcp: def.runtime?.enableProjectMcp === true,
      baseBranch: (typeof def.runtime?.baseBranch === 'string' && def.runtime.baseBranch.trim())
        ? def.runtime.baseBranch.trim() : null,
    },
    stages,
    teamDir,
    packRequired,
    packShared,
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
  loadTeam, listTeams, validateAndNormalize,
};
