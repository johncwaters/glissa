/*
 * Team session factories - the two places the backend builds a Session for the Teams feature:
 * one headless stage session per pipeline stage (consumed by team-orchestrator), and the single
 * interactive guided-pack-setup session.
 *
 * createBackend calls createTeamSessionFactory once with its live locals (the session maps, config,
 * hook plumbing, broadcast) and hands the returned makeStageSession to the orchestrator and
 * startPackSetup to the control handlers.
 */

'use strict';

const { Session } = require('../session/sessions');
const { registerEphemeralSession } = require('./ephemeral-session');
const { teamPermissions } = require('../teamlib/team-settings');
const { buildSetupPrompt, setupSessionId, setupSessionName, packPaths } = require('../teamlib/team-setup');
const { scanProjectContext } = require('../teamlib/project-context');
const teamOutput = require('../teamlib/team-output');

function createTeamSessionFactory({
  config, sessions, teamSessions, closeSessionDataClients, hookRouter, getHookPort,
  wireSessionEvents, broadcastControl, registry, getProjectPathById,
}) {
  // Build a real Session for one team stage, registered in teamSessions and auto-removed on end.
  function makeStageSession({ id, name, path: projectPath, initialPrompt, spawnOptions, permissions }) {
    const sess = new Session({
      id,
      name,
      path: projectPath,
      dangerouslySkipPermissions: !!spawnOptions?.dangerouslySkipPermissions,
      extraClaudeArgs: spawnOptions?.extraClaudeArgs || [],
      initialPrompt,
      ephemeral: true,
      settingsPermissions: permissions || null,
      // App-runtime team stages load the project's .mcp.json servers (e.g. Playwright MCP) headlessly.
      enableProjectMcp: !!spawnOptions?.enableProjectMcp,
      replayBufferKB: config.replayBufferKB,
      hookRouter,
      getHookPort,
    });
    // Stage sessions run headless (claude -p) and produce no watchable TUI, so they are NOT surfaced
    // as terminal cards (that just shows an empty terminal). Run progress lives in the Teams view
    // pipeline; these sessions stay out of the session-card broadcast stream entirely.
    registerEphemeralSession({ map: teamSessions, id, sess, closeSessionDataClients, logPrefix: 'team', name });
    return sess;
  }

  // Guided pack setup. Spawn ONE interactive Claude session (a normal PTY session, surfaced as a
  // terminal card) seeded with a prompt that interviews the operator and fills this project's pack.
  // Unlike a team stage it is NOT headless (the interview needs back-and-forth) and IS shown as a
  // card so the operator can answer in the terminal. It lives in the regular `sessions` map but is
  // flagged ephemeral (skips config-reload diffing and health anomaly checks) and is never persisted
  // to config.json. On exit we re-check the pack and broadcast team-pack-status so the Teams view
  // drops its setup banner. Returns { ok, sessionId, already?, error? }.
  function startPackSetup({ teamId, projectId }) {
    let team;
    try { team = registry.loadTeam(teamId); } catch { return { ok: false, error: `Unknown team "${teamId}"` }; }
    const projectPath = getProjectPathById(projectId);
    if (!projectPath) return { ok: false, error: 'Unknown project' };

    const id = setupSessionId(teamId, projectId);
    if (sessions.has(id)) return { ok: true, already: true, sessionId: id };

    // Make sure the pack files exist (idempotent) so the agent has templates to fill in place. Shared
    // files (team.packShared) scaffold into the project-level .glissa/pack/ from the _shared fallback
    // templates; a pre-filled team-local copy of a now-shared file is promoted up here too.
    teamOutput.ensureStructure(projectPath, team.outputPath);
    teamOutput.scaffoldPack(
      projectPath, team.outputPath, team.packTemplatesDir, team.packRequired,
      team.packTemplatesFallbackDir, team.packShared,
    );
    const { packDir, sharedPackDir, packFiles } = packPaths(projectPath, team);
    // Interview ONLY the files that still need filling, so an already-filled shared file (filled by an
    // earlier team's setup) is skipped instead of re-asked. A fresh project has every file unfilled, so
    // toFill == packFiles and the prompt is unchanged from before this feature.
    const status = teamOutput.packStatus(projectPath, team.outputPath, team.packRequired, team.packShared);
    const unfilled = new Set(status.unfilled);
    const toFill = packFiles.filter((f) => unfilled.has(f.name));
    // Deterministic project-context scan (total, never throws); an empty summary degrades to the
    // original prompt with no STARTING FACTS block.
    const projectContext = scanProjectContext(projectPath).summary;
    const prompt = buildSetupPrompt(team, {
      packDir, sharedPackDir, packFiles: toFill, projectPath, projectContext,
    });

    const projectDisplayName = (config.projects.find((p) => p.id === projectId) || {}).name || '';
    const name = setupSessionName(team, projectDisplayName);

    const sess = new Session({
      id,
      name,
      path: projectPath,
      // Interactive (no -p): the prompt is submitted as the first message and the operator keeps
      // typing. Writes to the pack are approved in the terminal; the team deny-list is applied as a
      // belt-and-suspenders guard via the injected settings file.
      dangerouslySkipPermissions: false,
      initialPrompt: prompt,
      ephemeral: true,
      settingsPermissions: teamPermissions(team),
      replayBufferKB: config.replayBufferKB,
      hookRouter,
      getHookPort,
    });
    sessions.set(id, sess);
    wireSessionEvents(sess);
    // Surface as a card (same shape the config-reload add path broadcasts).
    broadcastControl({ type: 'session-added', id, session: name, state: sess.state, skipPerms: false, ephemeral: true });

    sess.on('exit', () => {
      let st = null;
      try { st = teamOutput.packStatus(projectPath, team.outputPath, team.packRequired, team.packShared); } catch { /* report nothing */ }
      if (st) {
        // Distinct from the team-pack-status request REPLY so it never collides with a get-team-pack-
        // status round-trip; the Teams view routes this broadcast to refresh the setup banner.
        broadcastControl({
          type: 'team-pack-updated', teamId, projectId,
          configured: st.configured, unfilled: st.unfilled, packDir: st.packDir,
          timestamp: Date.now(),
        });
      }
      if (sessions.get(id) === sess) {
        sessions.delete(id);
        closeSessionDataClients(id);
      }
      broadcastControl({ type: 'session-removed', id, session: name });
    });
    sess.start();
    return { ok: true, sessionId: id };
  }

  return { makeStageSession, startPackSetup };
}

module.exports = { createTeamSessionFactory };
