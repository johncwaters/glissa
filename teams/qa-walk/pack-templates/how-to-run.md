# How to run, Milepost QA walk

Project specifics for bringing Milepost up so the persona walk can drive it. The walk methodology,
personas, findings schema, and parser fixture are in the repo at `team/qa/` (read those directly).

## Start the app
- `npm run dev` (run it in the background). Serves `http://localhost:4321`.
- Convex is a shared remote dev deployment, so no separate process is needed.
- Glissa runs this team in an isolated worktree and brings your checkout's gitignored local context into
  it: `node_modules` (junctioned) and `.env.local` (Clerk / Convex / Mapbox keys, copied). No install step
  is needed. Do NOT set `CI=1`: it disables the returning-user sign-in helper.
- The dev server compiles routes on first hit; allow a few seconds and retry.
- Ensure nothing else is already bound to port 4321 during the run.

## Readiness check
- Poll by navigating to `http://localhost:4321` with Playwright MCP (`browser_navigate` +
  `browser_snapshot`) and retry until the page renders. Do NOT use curl / wget / Invoke-WebRequest
  (blocked by this team).

## Browser
- Playwright MCP is provisioned by the repo `.mcp.json` (headless, `--isolated`, storage + testing caps)
  and is pre-trusted for this headless run (the team sets `runtime.enableProjectMcp`), so the `browser_*`
  tools are available without an interactive trust prompt. Set each persona's viewport with `browser_resize`.

## Teardown
- Stop the dev server process after all three persona walks finish.

## Precondition
- Glissa forks each run from the `develop` branch automatically (`team.json` `runtime.baseBranch`), so you
  do not need to switch branches first. Ensure `develop` exists and contains `team/qa/` and `.mcp.json`
  (the walk inputs); the run BLOCKS with a clear log line if that branch is missing.
