<!-- Generated: 2026-07-03 -->

# server

## Purpose
Backend runtime: the Express + WebSocket server factory and its control plane, plus shared server plumbing (config store, scheduler, spawn gate, WS sender, post-turn checks, safe child-process wrapper).

## Key Files

| File | Description |
|------|-------------|
| `backend.js` | Express + WebSocket server factory, shared by root `server.js` and the Vite dev plugin |
| `control-handlers.js` | Control-WebSocket message handlers (kill, restart, rename, settings, team control) |
| `control-replay-core.js` | Pure control-broadcast replay log: monotonic seq stamping + retention of the replayable message types |
| `server-lifecycle.js` | Boot/shutdown lifecycle helpers |
| `ws-sender.js` | Data-WebSocket sender: batching, bufferedAmount backpressure, echo fast-flush |
| `scheduler.js` | In-process calendar/cron for scheduled team runs |
| `post-turn-checker.js` | Async IO runner for post-turn hygiene checks (pure rules in `../session/core/post-turn-rules.js`) |
| `spawn-gate.js` | Process-wide async serialization of `pty.spawn` initiation (ConPTY wedge avoidance) |
| `config-store.js` | Runtime config load/save/defaults; resolves the repo-root `config.json` via `__dirname/..` |
| `child-process-safe.js` | THE ONLY module allowed to import `node:child_process` (enforced by `tests/no-direct-child-process.test.js`) |
| `update-check.js` | Startup GitHub version check against the `main` branch `package.json` (abortable, advisory only) behind `config.checkForUpdates` |
| `team-session-factory.js` | Team `Session` construction: `makeStageSession` (headless stage) + `startPackSetup` (interactive guided setup) |
| `pr-review-wiring.js` | PR auto-review IO shell: review-session/spawn plumbing, poller start/restart/stop, plus the pure prompt builder, result reader, start gate, and config key |
| `ephemeral-session.js` | Shared ephemeral-Session registration: map insert, exit cleanup, destroy() wrap (used by the team and PR-review lanes) |
| `pr-poller.js` | GitHub PR auto-review poller (opt-in): lists/filters/reviews/merges own PRs; IO-free, deps injected |
| `pr-gh.js` | `gh`/`git` wrappers for the PR poller (via `child-process-safe`); pure four-way `classifyChecks` |
| `pr-telegram.js` | PR-only Telegram push helper (never throws; NOT a `NotificationManager` channel) |
| `core/pr-review-core.js` | Pure PR-review decisions (`prKey`/`filterActionablePrs`/`planReviews`/`planMerges`/`nextState`/`pingFor`) |
| `core/branch-sync-core.js` | Pure ahead/behind parsing + decisions for the review sidebar's branch-sync indicator (IO in `session/sessions.js getBranchSync`) |

## For AI Agents
- These modules live one level below the repo root: filesystem assets (`dist/`, `public/`, `teams/`, `config.json`, `node_modules/`) resolve via `path.join(__dirname, '..', ...)`. Keep that offset when adding paths.
- CommonJS only; no new dependencies without explicit instruction; avoid `else` (guard clauses).
- See root `AGENTS.md` for architecture and conventions.
