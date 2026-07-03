// ── Teams view ────────────────────────────────────────────────
// Dedicated tab surface for premade agent pipelines. A "team" here is an INSTANCE: a roster bound
// to one project. The same roster can target several projects, and different rosters can share a
// project; each instance is one (teamId, projectId) activation persisted in config.teams.
//
// Each instance renders as a panel with four bands (the lifecycle, top to bottom):
//   1. header   - roster name -> target, live status, next scheduled run
//   2. pipeline - the stage sequence, live during a run (active stage, elapsed vs budget)
//   3. controls - Run / Cancel, the schedule (on/off + inline day/time/tz editor), Remove, guardrails
//   4. runs     - recent runs, each expandable to its summary + buttons that open artifacts in the editor
//
// Talks to the backend over the control WebSocket (list-teams / add-team-instance /
// remove-team-instance / run-team / cancel-team-run / set-team-schedule / get-team-runs /
// open-artifact) and reacts to team-* broadcasts. Safe whether or not the view is mounted.
//
// Decomposed into public/teams-panel/ (mirrors the public/session-card/ package): registry.js owns
// shared state, format-core.mjs is the pure formatting/classification core, and the rest split by
// responsibility (chat, pipeline rail, run status, runs list, schedule editor, setup banner, add bar,
// instance panel, lifecycle). This file just re-exports the public surface app.js consumes.

export { handleTeamMessage, mountTeamsView, refreshTeamsProjects, setTabActivityCallback } from './teams-panel/lifecycle.js';
