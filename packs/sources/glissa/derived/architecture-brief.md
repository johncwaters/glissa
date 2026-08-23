<!-- glissa-distill v1 [{"path":"AGENTS.md","sha256":"fb12903efaf43b91"},{"path":"docs/AGENTS.md","sha256":"4c172cfebc99a1ae"},{"path":"docs/distribution.md","sha256":"71c98228557f22c9"},{"path":"docs/monitor-report-context-mill-visions.md","sha256":"b8fe7096caa90b27"},{"path":"docs/postmortem-terminal-detection.md","sha256":"c4d1112be5ad8c46"},{"path":"docs/testing-cli.md","sha256":"c3a3983118eb237a"}] -->

# Glissa Architecture Brief

## What it is

Glissa is a lightweight Node.js background process that spawns and manages Claude Code sessions through node-pty, streams their terminal output to a browser dashboard over WebSockets, derives each session's status from structural signals (Claude Code hooks plus an OSC-0 title fallback, never screen scraping), and notifies the operator through browser notifications. The problem it solves: an operator running many concurrent agent sessions needs to know, reliably and without watching terminals, which session finished, which is blocked on input, and which failed. It is private (never published to a registry); the GitHub repo is the source of truth and installs go through npm from the GitHub spec or the claude-setup server profile (see docs/distribution.md).

Runtime: Windows 11 primary, Node 18+ (developed on v24). Server code is CommonJS; the frontend is ES modules bundled by Vite. Localhost-only trust boundary: never bind 0.0.0.0. Remote access, when enabled, is a second loopback listener fronted by a reverse proxy, with pairing-cookie auth and listener-port trust classification (server/core/request-trust.js).

## Subsystems

- **server/** owns the Express + WebSocket runtime: server/backend.js is the app factory shared by server.js (production) and the Vite dev plugin; server/control-handlers.js dispatches control-WS messages (kill, restart, rename, settings); server/config-store.js loads and persists config.json (resolution order: GLISSA_CONFIG env, in-repo config.json, then ~/.glissa/config.json, seeded if absent); server/spawn-gate.js serializes pty.spawn initiation process-wide because ConPTY wedges on concurrent spawns. Pure decision modules live under server/core/.
- **session/** owns the session domain: session/sessions.js is the stateful Session class (lifecycle, PTY spawn/kill, timers, hook ingestion), a JSONL forensic recorder (session/session-recorder.js, signals on by default, raw PTY bytes opt-in), and pure cores under session/core/ (state machine tables, spawn command resolution, the completion-gate arbiter, notification gate, and more).
- **detection/** owns status detection: detection/hook-source.js (HookRouter) validates the per-session bearer token and maps Claude Code hook callbacks to signals; detection/osc-title-source.js reads the OSC-0 title; detection/status-source.js merges the two; detection/settings-injector.js writes the per-session --settings file that injects the HTTP hooks; detection/replay.js drives recordings back through detection as a regression harness.
- **notifications/** owns the notification lifecycle: notifications/notification-manager.js is a table-driven state machine (states in shared/notification-states.js). Primary channel is a notify broadcast over the control WS that the browser turns into a native Notification; opt-in channels are an OS toast and Telegram (durable at-least-once queue in notifications/telegram-outbox.js). Focus suppression defers, never drops, and is per connection (server/core/client-presence.js).
- **packs/** plus server/pack-builder.js, server/pack-service.js, and server/core/pack-core.js form the context mill: versioned, token-budgeted context directories assembled from packs/specs/*.pack.json and packs/sources/**, published atomically under ~/.glissa/packs/built/NAME/current/ and delivered to sessions with --add-dir.
- **public/** is the browser dashboard: xterm.js terminals per session card (public/session-card/), a control-WS client (public/control-ws.js), and two first-class layouts (desktop and phone) chosen by the single predicate in public/form-factor-core.mjs (decideLayout: coarse pointer AND width at or below 768px means phone). Live elements are re-parented between layouts, never duplicated; public/card-host.js enforces a single global borrower per card.

## Key seams

- **Pure core plus thin IO shell.** Decision logic lives in IO-free modules (session/core/, server/core/, *-core.mjs in the browser) with unit tests in tests/; thin shells do the fs, git, HTTP, and timer work. Example: session/core/gate-release.js decideGateRelease decides every held-ready verdict; sessions.js only acts on it.
- **EventEmitter between modules.** Inter-module communication is Node EventEmitter events (state-change, claude-session-id, user-prompt, pack-updated), never globals or direct coupling.
- **Dual WebSocket transport, deliberately not merged.** A data WS per session (/terminals/:sessionId, raw PTY bytes, backpressure and offset-based backfill in server/ws-sender.js) and one control WS (/control, JSON). The channels want opposite loss policies: data bytes drop recoverably from a ring buffer, control JSON must not drop and replays one-shot types (server/control-replay-core.js). Both are heartbeat-reaped by server/ws-heartbeat.js. Plain ws package, never Socket.IO.
- **The spawn path.** pty.spawn only, never child_process.spawn, and no shell: true. Env is scrubbed by the pure session/core/spawn-env.js buildSpawnEnv (unsets CLAUDECODE, CLAUDE_CODE_SSE_PORT, CLAUDE_CODE_ENTRYPOINT, GLISSA_PORT, GLISSA_CONFIG). Resolve-then-branch: session/core/spawn-command.js resolves claude once at module load (CLAUDE_CMD); a real .exe is spawned directly, a .cmd/.bat/.ps1 shim falls back to cmd.exe /c claude. server/child-process-safe.js is the only module allowed to import node:child_process, and server/git-workspace.js is the only module allowed to run git worktree.

## Status detection, briefly

The original design scraped the rendered TUI out of the PTY stream and failed structurally: chrome strings changed every release, three overlapping mechanisms plus timer soup made behavior unexplainable, and there was no ground-truth corpus (docs/postmortem-terminal-detection.md). The rewrite derives status from machine-emitted signals only:

- **Hooks are authoritative.** The injected --settings file adds HTTP hooks (Stop, Notification, UserPromptSubmit, SessionStart/End, SubagentStart/Stop) that POST to POST /hook/:glissaId/:event with a per-session bearer token validated by HookRouter. Live-verified: Stop and UserPromptSubmit fire under --dangerously-skip-permissions and in headless -p runs.
- **The OSC-0 title is the honest fallback.** Spinner glyph means working, idle glyph means ready, anything unrecognized is unknown, and it never emits awaiting-input. detection/status-source.js merges the sources (hook beats title), holds ready in a conflict window so a racing awaiting-input wins, and dedups double-fired Stops.
- **The background-agent completion gate exists because a main-agent Stop is not proof the work is done.** Background sub-agents, teammates, and declared background_tasks entries are reconciled into one task registry (createTaskRegistry in session/core/agent-tracker.js); while its activeCount() is nonzero, mapSignalToEvent suppresses ready so a card cannot falsely COMPLETE while a sub-agent still runs. A suppressed ready is held and released only when decideGateRelease re-validates against live evidence after a quiet window (DEFAULT_GATE_RELEASE_SETTLE_MS, 10s), bounded by per-kind TTLs (WEAK_TASK_TYPES for hook-less shell tasks, a short teammate TTL); pending ScheduleWakeup entries (NON_GATING_TASK_TYPES) never gate. Sessions are keyed by a stable UUID id; name is display-only.

## Opt-in lanes

- **PR auto-review** (config.prReview.enabled plus config.telegram credentials): server/pr-poller.js (IO-free, deps injected) lists the operator's own PRs, reviews each new head SHA with an ephemeral headless claude -p (verdict via a result file, findings via gh pr comment), and merges only behind a hard gate: reviewed head unchanged, checks green (classifyChecks in server/pr-gh.js), no .github/workflows/ change. The agent never merges; it runs under the PR_REVIEW_DENY deny-list. Conflicting PRs get an isolated worktree via git-workspace.js.
- **PostHog investigation and auto-fix** (config.posthog, with autoFix a further opt-in): a moved issue gets a diagnose-only headless session; a major issue (isMajorIssue: spiking, regressed, or new) can get a reproduce-then-fix agent in a throwaway worktree. FIX_DENY blocks git push and gh outright; the server pushes the branch and opens the PR itself, refusing if the diff touches .github/workflows/. Nothing in the lane merges.
- **Context packs**: a per-project packs list in config.json delivers built pack dirs via --add-dir; auto-rebuild is a per-source-root watcher plus a 15 minute sweep (server/pack-service.js), and staleness reaches live sessions as a Glissa-authored one-line notice on the next UserPromptSubmit hook response (session/core/pack-notice.js), never pack content. Budgets are hard gates (budgetTokens per pack, MAX_INDEX_TOKENS for the always-loaded index); an unresolvable pack never blocks a spawn. The standing monitor report (docs/monitor-report-context-mill-visions.md) tracks open findings here, notably a non-atomic publish window in pack-builder.js and a cmd.exe injection hazard on the Visions dispatch shim path; treat those as known-issue context, not behavior guarantees.

## Where to read next

- Whole-system reference and conventions: root AGENTS.md (canonical; it wins over any doc).
- Session domain and pure cores: session/sessions.js, session/core/AGENTS.md.
- Detection rationale: docs/postmortem-terminal-detection.md; code in detection/.
- Server wiring and control plane: server/backend.js, server/control-handlers.js.
- Notifications: notifications/notification-manager.js, shared/notification-states.js.
- Context mill: server/core/pack-core.js, server/pack-builder.js, packs/ specs and sources.
- Dashboard: public/app.js, public/session-card/, public/form-factor-core.mjs.
- Shipping and releases: docs/distribution.md; pre-release CLI checks: docs/testing-cli.md.
- Known open findings (Visions and mill): docs/monitor-report-context-mill-visions.md.
- Doc index and archive policy: docs/AGENTS.md.
