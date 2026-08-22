<!-- Generated: 2026-07-03 -->

# server

## Purpose
Backend runtime: the Express + WebSocket server factory and its control plane, plus shared server plumbing (config store, scheduler, spawn gate, WS sender, post-turn checks, safe child-process wrapper).

## Key Files

| File | Description |
|------|-------------|
| `backend.js` | Express + WebSocket server factory, shared by root `server.js` and the Vite dev plugin |
| `control-handlers.js` | Control-WebSocket message handlers (kill, restart, rename, settings) |
| `control-replay-core.js` | Pure control-broadcast replay log: monotonic seq stamping + retention of the replayable message types |
| `server-lifecycle.js` | Boot/shutdown lifecycle helpers. A UI restart respawns `argv` detached and exits 0 when nothing supervises the process, but exits NON-ZERO without respawning under systemd (see `core/restart-strategy.js`); shutdown exits 0 in both worlds |
| `ws-sender.js` | Data-WebSocket sender: batching, bufferedAmount backpressure, echo fast-flush |
| `post-turn-checker.js` | Async IO runner for post-turn hygiene checks (pure rules in `../session/core/post-turn-rules.js`) |
| `usage-wiring.js` | Usage lane IO shell: lazy scanner start, config restart, post-turn nudge, `usage-sessions` push, `usage-report` pull |
| `usage-scanner.js` | Claude Code transcript scanner: project-dir resolution, recursive JSONL walk, incremental reads, deduped entry store, report memo |
| `usage-pricing.js` | Claude model pricing loader: bundled LiteLLM snapshot, optional public fetch, 24h disk cache, snapshot overlay |
| `data/claude-pricing.json` | Bundled Claude pricing snapshot from LiteLLM, trimmed to fields the Usage lane reads |
| `spawn-gate.js` | Process-wide async serialization of `pty.spawn` initiation (ConPTY wedge avoidance) |
| `git-workspace.js` | THE ONLY module allowed to run `git worktree` (enforced by `tests/no-direct-git-worktree.test.js`); per-session worktree isolation + merge-back, also used by the PR-review lane |
| `config-store.js` | Runtime config load/save/defaults; resolves the repo-root `config.json` via `__dirname/..` |
| `child-process-safe.js` | THE ONLY module allowed to import `node:child_process` (enforced by `tests/no-direct-child-process.test.js`) |
| `update-check.js` | Startup GitHub release-tag check (abortable, advisory only) behind `config.checkForUpdates` |
| `pr-review-wiring.js` | PR auto-review IO shell: review-session/spawn plumbing, poller start/restart/stop, plus the pure prompt builder, result reader, start gate, and config key |
| `ephemeral-session.js` | Shared ephemeral-Session registration: map insert, exit cleanup, destroy() wrap (used by the PR-review and PostHog investigation lanes) |
| `pr-poller.js` | GitHub PR auto-review poller (opt-in): lists/filters/reviews/merges own PRs; IO-free, deps injected |
| `pr-gh.js` | `gh`/`git` wrappers for the PR poller (via `child-process-safe`); pure four-way `classifyChecks` |
| `pr-telegram.js` | PR-only Telegram push helper (never throws; NOT a `NotificationManager` channel) |
| `core/pr-review-core.js` | Pure PR-review decisions (`prKey`/`filterActionablePrs`/`planReviews`/`planMerges`/`nextState`/`pingFor`) |
| `core/branch-sync-core.js` | Pure ahead/behind parsing + decisions for the review sidebar's branch-sync indicator (IO in `session/sessions.js getBranchSync`) |
| `core/restart-strategy.js` | Pure `decideRestartStrategy(env)` -> `respawn` \| `exit-for-supervisor`, keyed on systemd's `INVOCATION_ID` |
| `core/upgrade-route.js` | Pure WS-upgrade target classification: `control` \| `data` \| `unknown` by PATHNAME (a reconnect carries `?since=<seq>`), plus the data-route session id |

## For AI Agents
- These modules live one level below the repo root: filesystem assets (`dist/`, `public/`, `config.json`, `node_modules/`) resolve via `path.join(__dirname, '..', ...)`. Keep that offset when adding paths.
- CommonJS only; no new dependencies without explicit instruction; avoid `else` (guard clauses).
- See root `AGENTS.md` for architecture and conventions.
