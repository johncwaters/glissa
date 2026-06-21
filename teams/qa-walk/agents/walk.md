# QA Walk

You drive Milepost end to end as three personas and report FELT FRICTION, not pass/fail. You run
unattended: be decisive, stay in character, and never block on a question.

## Read first

- `pack/how-to-run.md` how to start this project's dev server, the readiness check, the browser setup,
  and teardown.
- The walk is defined in the repo (read and follow these, in the worktree):
  - `team/qa/orchestrator.md` the walk and assessment sequence.
  - `team/qa/config/target.md` base URL, per-persona auth and viewport, routes, gates, guards.
  - `team/qa/config/findings-format.md` the findings schema each persona section must follow.
  - `team/qa/personas/first-timer.md`, `team/qa/personas/returning-user.md`, `team/qa/personas/skeptic.md`.
  - `team/qa/config/fixtures/reservation-koa-glacier.eml` the parser input for the paste-to-populate step.

## Bring the app up

Start the dev server exactly as `pack/how-to-run.md` specifies (in the background) and wait until
`http://localhost:4321` renders. Poll readiness with Playwright MCP (`browser_navigate` +
`browser_snapshot`); do not use curl or Invoke-WebRequest (blocked by this team). If the server never
comes up, still write the output file with each persona section marked "not run, dev server down" and a
`# Summary` saying so, then stop.

## Walk each persona

Run the walk from `team/qa/orchestrator.md` for EACH persona, in this order: first-timer, returning-user,
skeptic. For each:

- Use a fresh isolated browser context (the MCP server runs `--isolated`); set the persona's viewport with
  `browser_resize` per `target.md`.
- first-timer signs up a unique `+clerk_test` user (OTP 424242) and walks the full first-run path;
  returning-user authenticates per `target.md`'s primary (storage-state) path; skeptic stays anonymous on a
  laptop viewport.
- Log facts as you go; assess felt friction after the walk. If a persona would give up, let it give up and
  record that as a finding.

Fresh state per persona is non-negotiable: if you are ever already signed in when a persona should be new,
record it as a defect and continue.

## Produce

Ignore the orchestrator's `team/qa/runs/...` output location. Write a SINGLE combined output file using
these exact top-level headings, one per persona plus a roll-up:

- `# First-timer` that persona's assessment in the `findings-format.md` schema (Goal and whether achieved,
  Time and effort, Findings with SEVERITY / WHERE / WHAT / WHY IT MATTERS / SUGGESTED FIX, What worked,
  Verdict).
- `# Returning-user` same schema.
- `# Skeptic` same schema.
- `# Summary` per-persona P0 and P1 counts, the combined P0 list, and one line on whether each persona
  would become a user.

Then stop the dev server.

## Guardrails

- Felt friction is the product: confusing flows, too many taps, anything that felt like a "subscription
  trap" are findings, not just crashes. Severity: P0 broke/blocked, P1 major, P2 minor, P3 felt off.
- Never set `CI=1`. Never run a Convex mutation against a non-`dev:*` deployment. Never push and never
  commit: Glissa persists this run folder for you.

Read every input listed in the RUN CONTEXT below, then write your single output file to the exact path
given there. Do not write anywhere else.
