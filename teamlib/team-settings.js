'use strict';

// Per-stage spawn options + enforcement settings for team runs.
//
// ENFORCEMENT (Phase-0(b), .omc/plans/marketing-team-pipeline.md section 2): the deny blacklist is
// emitted as a Claude Code `permissions.deny` array (mechanism M2), written into the stage's
// --settings file by detection/settings-injector.js. The completion half (Phase-0(a)) is confirmed;
// whether `permissions.deny` is honored ALONGSIDE --dangerously-skip-permissions is the open
// Phase-0(b) question, to be settled by a benign-blacklist probe. The PRIMARY guardrail is the
// git-clean target-repo precondition (driver D3); this deny list is fail-open defense-in-depth.

function stageModel(stage) {
  return stage?.model ? stage.model : 'sonnet';
}

// Options the orchestrator passes to `new Session(...)` for one stage: headless -p, the stage's
// model, YOLO per the team's permission mode, and the ephemeral marker.
function buildStageSpawnOptions(team, stage) {
  const yolo = team?.permissions?.mode === 'yolo';
  return {
    dangerouslySkipPermissions: yolo,
    extraClaudeArgs: ['-p', '--model', stageModel(stage)],
    ephemeral: true,
    // App-runtime teams opt in to loading the project's `.mcp.json` servers (e.g. Playwright MCP) in
    // the headless stage; ordinary teams leave it off, so the stage settings stay byte-identical.
    enableProjectMcp: team?.runtime?.enableProjectMcp === true,
  };
}

// The `permissions` fragment ({ deny }) to inject into the stage's --settings file.
function teamPermissions(team) {
  const deny = team?.permissions && Array.isArray(team.permissions.deny)
    ? team.permissions.deny.slice()
    : [];
  return { deny };
}

module.exports = { buildStageSpawnOptions, teamPermissions, stageModel };
