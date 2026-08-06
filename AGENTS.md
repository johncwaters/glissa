<!-- Generated: 2026-06-10 | Updated: 2026-07-25 -->

# glissa

## Purpose
Glissa is a lightweight Node.js background process that spawns and manages Claude Code sessions via node-pty, streams terminal output to a browser dashboard over WebSockets, derives session status from structural signals (Claude Code hooks plus an OSC-0 title fallback, never screen scraping), and notifies the operator through browser notifications. It also ships "Teams": project-portable headless agent pipelines (marketing, changelog, qa) that run in isolated git worktrees.

## Key Files

| File | Description |
|------|-------------|
| `server.js` | Production entry point, thin wrapper around `server/backend.js` |
| `server/backend.js` | Express + WebSocket server factory, shared by `server.js` and the Vite dev plugin |
| `session/sessions.js` | Session class: lifecycle, PTY spawn/kill, timers, hooks; consumes StatusSource; delegates pure logic to `session/core/` |
| `server/control-handlers.js` | Control-WebSocket message handlers (kill, restart, rename, settings, team control) |
| `server/config-store.js` | Runtime config load/save/defaults, key whitelists for control updates. Path resolution order: `GLISSA_CONFIG` env (via `--config`), in-repo `config.json` (`__dirname/..`, dev use), then `~/.glissa/config.json` (installed CLI use), seeded there if none exists. The `settingsDefaults` option overlays per-launch defaults for ABSENT keys only (the Vite dev plugin turns `debugMode` on that way); `isUnchosenLaunchDefault` keeps such a key from being materialized into config.json by a save that merely echoed it back, so the dev overlay cannot leak into production |
| `notifications/notification-manager.js` | Notification lifecycle state machine (states in `shared/notification-states.js`) |
| `server/scheduler.js` | In-process calendar/cron for scheduled team runs; Intl-based timezone offset-solving |
| `session/session-recorder.js` | Always-on JSONL forensic recorder (v1 legacy, v2 structural-signal format). Signals (hook payloads + transitions) by default; raw PTY bytes opt-in. See "Session Recording" |
| `server/spawn-gate.js` | Process-wide async serialization of `pty.spawn` initiation (ConPTY wedge avoidance) |
| `server/ws-sender.js` | Data-WebSocket sender: batching, bufferedAmount backpressure, echo fast-flush |
| `server/post-turn-checker.js` | Thin async IO runner for post-turn hygiene checks; applies pure rules from `session/core/post-turn-rules.js` to a session's git-changed files |
| `vite.config.js` | Vite frontend build config + backend-attach plugin (ESM) |
| `biome.json` | Lint/format config (worktrees inherit the nested-config gotcha from main) |
| `package.json` | CommonJS package; `files` whitelist validated by `scripts/check-package-files.js` |
| `AGENTS.md` | Project agent instructions: architecture, conventions, design decisions. Read it first. `CLAUDE.md` is a stub that imports this file via `@AGENTS.md` |
| `DESIGN.md` / `DESIGN.json` | Dashboard visual design system |
| `PRODUCT.md` | Product definition and positioning (canonical; see `docs/archive/product-design-context.md` for the superseded design-context doc) |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `bin/` | npm CLI entry (see `bin/AGENTS.md`) |
| `server/` | Backend runtime: Express/WS wiring, control plane, config, shared server plumbing |
| `session/` | Session domain: the stateful Session class, recorder, and pure cores in `session/core/` |
| `notifications/` | Notification domain: lifecycle manager + delivery adapters (see `notifications/channels/AGENTS.md`) |
| `detection/` | Status detection: hook + title sources, watchers, replay (see `detection/AGENTS.md`) |
| `docs/` | Design docs, postmortems, plans (see `docs/AGENTS.md`) |
| `public/` | Browser dashboard frontend, ES modules bundled by Vite (see `public/AGENTS.md`) |
| `scripts/` | Release and package validation scripts (see `scripts/AGENTS.md`) |
| `session/core/` | Pure cores extracted from `sessions.js`, no IO (see `session/core/AGENTS.md`) |
| `shared/` | State constants shared by server (CJS) and browser (ESM) (see `shared/AGENTS.md`) |
| `teamlib/` | Team runtime server modules (see `teamlib/AGENTS.md`) |
| `teams/` | Team definitions: rosters, role prompts, pack templates (see `teams/AGENTS.md`) |
| `test/` | Manual/smoke tests (see `test/AGENTS.md`) |
| `tests/` | Automated `node --test` suite (see `tests/AGENTS.md`) |
| `tools/` | Auxiliary dev tooling, e.g. the company-context MCP server (see `tools/AGENTS.md`) |
| `assets/` | Repo-level static assets (see `assets/AGENTS.md`) |
| `dist/` | Vite production build output, gitignored, never edit |

## For AI Agents

### Working In This Directory
- Server code is CommonJS only (`require` / `module.exports`); frontend is ESM bundled by Vite. Node >=18 (developed on v24), Windows 11.
- Do NOT add dependencies without explicit instruction.
- Status detection is structural (hooks + OSC-0 title). Never reintroduce PTY body/content scraping.
- Spawn sessions with `pty.spawn` (never `child_process.spawn`), no `shell: true`; scrub env via `session/core/spawn-env.js`.
- All sessions share one Node event loop: no sync git/fs on recurring paths (polls, turn-end, watchers); use async `execFile` with yields. One-shot cold paths may stay sync.
- Localhost-only trust boundary: never bind `0.0.0.0`; keep the per-session bearer token check on `POST /hook/:glissaId/:event`.
- House style: no literal em dash, en dash, ellipsis character, or emoji anywhere (source, tests, docs, commits). When code must emit such a character, build it via `String.fromCharCode`.
- Avoid `else`: prefer early returns and guard clauses.
- Prefer the seam pattern: pure logic in `session/core/` or `*-core.mjs` modules, thin IO shells around them.
- Inter-module communication via Node `EventEmitter`, not globals or direct coupling.
- Sessions are keyed by stable UUID `id`; `name` is display-only.

### Testing Requirements
- Run `npm test` (node:test based suite in `tests/`) before claiming completion.
- New pure logic gets a unit test in `tests/`; detection changes should also pass the replay harness fixtures.

### Common Patterns
- Resolve-then-branch spawn: `claude` resolved once at module load; `.exe` spawned directly, `.cmd`/`.bat`/`.ps1` shims fall back to `cmd.exe /c claude`.
- Dual WebSocket: data WS (`/terminals/:sessionId`, raw PTY bytes) and control WS (`/control`, JSON messages).
- Table-driven state machines (`session/core/state-machine.js`, `shared/notification-states.js`) with explicit transitions.

## Dependencies

### External
- `express` - HTTP server and static file serving
- `ws` - WebSocket server (no Socket.IO, ever)
- `node-pty` - Pseudo-terminal for spawning Claude Code with real PTY support (requires VS Build Tools on Windows)
- `@xterm/xterm` - Terminal emulator (loaded in browser via ES modules, not in Node.js)
- `@xterm/addon-fit` - xterm.js addon for fitting terminal to container (browser only)
- `@xterm/addon-webgl` - xterm.js addon for WebGL rendering (browser only)

### Dev Dependencies
- `vite` - Frontend build tool (dev server with HMR, production bundling)
- `tailwindcss` - Utility-first CSS framework (v4)
- `@tailwindcss/vite` - Tailwind CSS Vite plugin

**Notes:**

- `node-pty` requires C++ build tools (Visual Studio Build Tools on Windows)
- `@xterm/*` packages are bundled by Vite for the browser, not loaded directly in Node.js

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

## Development Workflow

- `npm run dev` - Vite dev server with HMR on port 5173, Express + WebSocket backend attached via plugin (single process)
- `npm run dev:server-only` - Express backend only on port 3000 (for debugging backend without Vite)
- `npm run build` - Production build to `dist/`
- `npm start` - Production server (serves from `dist/` if it exists, otherwise `public/`)
- `npm run preview` - Preview production build via Vite

## Platform and Runtime

- **OS:** Windows 11
- **Node:** v24+
- **Module system:** CommonJS (`require` / `module.exports`) for server - no ESM. Frontend uses ES modules bundled by Vite.

## File Structure

```
server.js          # Production entry point (thin wrapper)
vite.config.js     # Vite frontend build config + backend plugin (ESM)
server/            # Backend runtime (Express + WS wiring, control plane, shared server plumbing)
  backend.js         # Express + WebSocket server factory (shared by server.js and Vite plugin)
  control-handlers.js  # Control-WS message dispatch
  control-replay-core.js  # Pure control-broadcast replay log: monotonic seq stamping + retention of replayable message types
  server-lifecycle.js  # Boot/shutdown lifecycle
  ws-sender.js         # Data-WS send/backfill (monotonic offsets)
  scheduler.js         # Team schedule computation + timers
  post-turn-checker.js # Async IO runner for post-turn hygiene checks (rules from session/core/post-turn-rules.js)
  spawn-gate.js        # Concurrent-spawn limiter
  config-store.js      # config.json load/save/merge (dev resolves the in-repo config.json via __dirname/..; see Key Files for the full resolution order)
  child-process-safe.js  # THE ONLY module allowed to import node:child_process (windowsHide)
  update-check.js      # Startup npm-registry version check (abortable, advisory only) behind config.checkForUpdates
  ephemeral-session.js # Shared ephemeral-Session registration: map insert, exit cleanup, destroy() wrap; used by the team and PR-review lanes
  team-session-factory.js  # Team Session construction: makeStageSession (headless stage) + startPackSetup (interactive guided setup)
  pr-poller.js         # GitHub PR auto-review poller (opt-in): lists/filters/reviews/merges own PRs; IO-free, deps injected
  pr-gh.js             # gh/git wrappers for the PR poller (via child-process-safe); pure classifyChecks (four-way)
  pr-telegram.js       # PR-only Telegram push helper (never throws; NOT a NotificationManager channel)
  pr-review-wiring.js  # PR auto-review IO shell: review session + spawn, poller start/restart/stop, pure prompt/result/gate/cfg-key
  core/pr-review-core.js  # Pure PR-review decisions (prKey/filterActionablePrs/planReviews/planMerges/nextState/pingFor)
  core/branch-sync-core.js  # Pure ahead/behind parsing + decisions for the review sidebar's branch-sync indicator
session/           # Session domain: the stateful Session class + its pure cores
  sessions.js        # Session class: lifecycle, PTY spawn/kill, timers, hooks; consumes StatusSource; delegates pure logic to session/core/
  session-recorder.js  # hook + state recording by default, PTY bytes opt-in (~/.glissa/recordings)
  core/              # Pure cores of a SEAM EXTRACTION from sessions.js (no IO, no Session import)
    spawn-command.js # classifyClaudeKind, resolveClaudeCommand, buildSpawnCommand, CLAUDE_CMD (resolve-then-branch spawn)
    spawn-env.js     # Pure buildSpawnEnv(baseEnv) - the 5-var scrub + always-on NO_FLICKER, returns a copy
    state-machine.js # TRANSITIONS, GUARDS, ENTRY_HOOKS, EXIT_HOOKS (lifecycle tables, relocated verbatim)
    status-mapper.js # Pure mapSignalToEvent(signal, state, confidence, activeAgents) -> event|null (the _onStatus decision; activeAgents>0 suppresses ready->task_complete)
    agent-tracker.js # Pure background-work bookkeeping: counted sub-agents (Map<agent_id, ts>), declared background_tasks parsing, idle-id gate math
    gate-release.js  # Pure decideGateRelease(...) -> cancel|gated|wait|release: the ONE judge of whether a gate-held (deferred) ready may complete the card
    anti-slop-prompt.js  # Fixed deterministic anti-slop note for --append-system-prompt; no double quotes (cmd.exe shim re-parse safety)
    auto-resume.js       # Pure pickAutoResume(projects, config): boot-time selection of DORMANT projects to auto-spawn with resumeSessionId
    conversation-history.js  # Pure cross-worktree Claude transcript discovery: cwd -> encoded <claudeHome>/projects/<dir> path
    decision-log.js      # Pure ring for the per-session DECISION TRACE (signal/gate/notify entries), with gate-repeat collapse; surfaced by getDebugState + the recorder
    exit-transition.js   # Pure decideExitTransition(state, exitCode, signal, receivedFirstOutput) -> { event, detail }, extracted from Session._handlePtyExit
    merge-gate.js         # Pure review-gate demotion decisions (worktree diff signature -> mergeStatus), extracted from Session.checkWorktreeChange/getDiff
    merge-prompt.js       # Pure builder of the manual-merge handoff prompt pasted into a parked worktree's PTY
    notify-gate.js        # Pure explainNotification(to, gate, event, opts) -> { category, reason } (decideNotification is its category-only wrapper): once-per-work-cycle notification gate for terminal categories
    output-ring.js        # Pure O(1) ring buffer of recent PTY output chunks; backs since()-based WS backfill
    post-turn-rules.js    # Pure idempotent post-turn hygiene rules, (content) -> { content, findings }; applied by server/post-turn-checker.js
    slop-code-patterns.js # Pure regex-based code-slop detection (detectCodeSlop), Noise/Lies/Soul taxonomy, offsets only
    wakeup-tracker.js     # Pending self-revival bookkeeping (ScheduleWakeup/CronCreate/CronDelete); advisory only, never gates a transition
detection/
  status-source.js     # Merges hook + title signals (precedence, conflict window, dedup)
  osc-title-source.js  # OSC-0 title fallback signal (working/ready/unknown only)
  hook-source.js       # HookRouter: validates per-session token, maps Claude Code hooks -> signals
  settings-injector.js # Per-session `--settings` file with HTTP hooks (token in URL)
  replay.js            # Version-aware replay harness (drives recordings through detection)
  worktree-watch.js         # fs.watch on the per-worktree gitdir; nudges sessions.js to recompute the diff
  integration-ref-watch.js  # Reflog-based listener for integration-branch movement no local worktree event would surface
  watch-debounce.js         # Shared debounce-into-trailing-call + stop lifecycle for the two fs.watch listeners
  integration-watcher-pool.js  # Ref-counted pool: one fs.watch per (commonGitDir, branch), fanned out to sibling sessions
notifications/     # Notification domain
  notification-manager.js  # Notification lifecycle state machine
  channels/web-notification.js  # PRIMARY: broadcasts `notify` over control WS; browser raises native Notification (Windows Action Center)
  channels/toast.js  # Opt-in fallback (config.osToast): Windows OS toast via BurntToast/msg; off by default (unreliable across machines)
public/
  index.html       # Dashboard shell (Tailwind utility classes)
  app.js           # Browser-side entry point (ES module)
  tailwind.css     # Tailwind CSS entry (theme + imports)
  style.css        # Component styles, state-driven rules, animations
  control-ws.js    # WebSocket control channel client
  dialogs.js       # Add Session and Settings dialog factories
  teams-panel.js   # Barrel for the Teams tab (re-exports the public API from teams-panel/)
  render-scheduler.mjs  # Global xterm WRITE scheduler: callback-gated round-robin with per-frame budget
  notifications.js # Native Web Notifications (browser routes to Windows Action Center)
  notify-dedupe-core.mjs  # Pure cross-tab claim (short-TTL localStorage) so exactly one open tab raises each notification
  alert-sound.js   # Notification sounds: audio files from audio/ + synth-beep fallback
  health-monitor.js  # Footer panel rendering server memory/leak telemetry
  theme.js         # Theme definitions applied as CSS custom properties
  ui-prefs.js / local-store.js  # localStorage persistence for UI state, quota-safe wrappers
  shortcuts.mjs    # Pure display catalog of keyboard shortcuts for the Settings dialog
  dom-helpers.js   # el() / escapeHtml() DOM utilities
  components/      # Static HTML dialog fragments, imported by dialogs.js via Vite ?raw
  session-card/    # Session card modules (decomposed from session-card.js)
    card-registry.js   # Shared state owner: sessionUIs Map + 2 DOM singletons
    toast.js           # showErrorToast - leaf, no local deps
    naming.js          # countSessionsByName, suggestSessionName (wraps naming-core.mjs)
    naming-core.mjs    # Pure: nextSuggestedName, countAutoNames, isAutoNameOf
    webgl-pool.js      # WebGL context pool with LRU cap (wraps webgl-core.mjs)
    webgl-core.mjs     # Pure: pickEvictionVictims
    card-dom.js        # Card builder, badge, inline rename, confirm dialog, debug overlay
    terminal.js        # xterm.js setup, data WebSocket, OSC-52 clipboard
    session-tick.js    # Shared 1s tick: elapsed clock + working-heartbeat poll (refreshElapsed)
    lifecycle.js       # createSessionCard, removeSessionCard, applyState, etc.
    aggregate-core.mjs # Pure: computeAggregate (used by lifecycle)
  teams-panel/     # Teams tab package: lifecycle orchestrator, instance panel, pipeline, runs list, schedule editor, chat, setup banner
  focus-view/      # Focus view: persistent left roster rail + one re-parented focused card
  sidebar/         # Right-docked review sidebar: changed-files diffs + merge/discard actions
  audio/           # Notification sound files (OGG)
shared/
  states.js        # Session states (CJS, server-side)
  states.esm.js    # Session states (ESM, browser-side via Vite)
teams/             # Glissa-owned team definitions (reusable blocks + per-team config)
  _shared/agents/*.md      # reusable brand-neutral role prompts (referenced by any team)
  _shared/pack-templates/  # reusable pack scaffolds (fallback for any team)
  <id>/team.json        # roster: stages (+ agent/reviseReads/revise), schedule, permissions.deny, pack.required, pack.shared (project-level files in .glissa/pack/), outputPath
  <id>/agents/*.md      # OPTIONAL per-team role override (else the shared role is used)
  <id>/pack-templates/  # OPTIONAL per-team pack scaffolds (else _shared is used)
teamlib/           # Team runtime server modules
  team-registry.js   # load/validate team.json (+ pack.required, pack.shared, pack-templates)
  team-orchestrator.js  # run engine: scaffold+halt gate, worktree-isolated stage pipeline
  team-output.js     # .glissa/teams/<id>/ paths, pack scaffold/status, run log + summaries
  team-git.js        # per-run git worktree isolation + fast-forward merge back; generic listWorktreeBranches (used by the PR poller)
  team-prompt.js     # stage prompt builder (embeds pack + run paths)
  team-setup.js      # guided pack setup: interview prompt + interactive setup-session helpers
  team-settings.js   # per-stage spawn options and permission config
  markdown.js        # Shared markdown ATX-heading regex core (pack/handoff section checks, topic/platforms extraction)
  project-context.js # fs-only shell reading a top-level allowlist of non-secret files for first-run setup context
  project-context-core.js  # Pure parser/renderer of that context: string in, deterministic ASCII-clean summary out
  verdict.js         # Shared VERDICT: token extraction core (strict orchestrator parse, loose run-summary scan)
config.json        # Runtime configuration
dist/              # Vite production build output (gitignored)
```

## CSS Convention

- **Tailwind utility classes** for static HTML markup (`index.html`)
- **Semantic classes** in `style.css` for JS-created DOM elements (`session-card/lifecycle.js`, `session-card/card-dom.js`, `dialogs.js`)
- **State-driven styles** via `[data-state]` attribute selectors in `style.css`
- **Animations** (`@keyframes`) and pseudo-elements (`::before`) in `style.css`
- **Theme** defined in `public/tailwind.css` via `@theme` block - maps colors, fonts, radii

## Key Design Decisions

### Inter-module Communication

Use Node.js `EventEmitter` for communication between modules. Do not use global variables or direct coupling.

### Session State Machine

Sessions follow a 7-state machine implemented in plain JS:

```
INITIALIZING → STARTING → RUNNING → WAITING → IDLE → DONE
                                                    ↘ FAILED
```

States are string constants. Transitions are explicit - no implicit state mutation.

### Status Detection (structural signals - NOT screen scraping)

Status is derived from machine-emitted signals, never from parsing the rendered TUI:

- **Authoritative: Claude Code hooks.** At spawn, `sessions.js` appends `--settings <file>` (written by `detection/settings-injector.js`) injecting HTTP hooks (`Stop`, `Notification`, `UserPromptSubmit`, `SessionStart`/`End`, `SubagentStart`/`SubagentStop`) that POST to `POST /hook/:glissaId/:event` on the existing Express server. A per-session bearer token (in the hook URL) is validated by `detection/hook-source.js` `HookRouter`. No target-repo modification; HTTP hooks need no shell.
- **Fallback: OSC-0 title** (`detection/osc-title-source.js`) - braille spinner = `working`, idle glyph = `ready`; an unknown glyph is `unknown`, never a guess. It NEVER emits `awaiting-input`.
- `detection/status-source.js` merges both (precedence hook > title), holds `ready` for a conflict window so a racing `awaiting-input` wins, and dedups. `working`/`resume` arriving inside that window CANCEL the held `ready` (the turn did not settle; letting it resolve fired a false COMPLETE right after a fast re-prompt). `sessions.js._onStatus` maps the normalized signal to a transition per the signal x state matrix (see `docs/postmortem-terminal-detection.md` for the design rationale and live-verification findings).
- **idle_prompt is demoted.** A `Notification(idle_prompt)` maps to `ready` but with `confidence: 'low'` (`mapHookConfidence` in `hook-source.js`): an idle nudge means "Claude is waiting for YOU", so it may only confirm quiescence from RUNNING, same as the title fallback. It must never complete a fresh IDLE session or a WAITING prompt.
- **/clear and /compact are quiet.** They fire `SessionEnd`+`SessionStart(source: clear|compact)` (no `UserPromptSubmit`, no `Stop`), but the TUI redraw flashes a spinner+idle glyph in the OSC title, which used to open a fake work cycle and fire a false "finished working" per /clear. On `SessionStart(source: clear|compact)` the session resets both sources (cancelling any held `ready`) and latches title signals off (`_titleQuiet`) until the next real `UserPromptSubmit`.
- **Background sub-agents (completion gate).** `SubagentStart`/`SubagentStop` (each carrying `agent_id`) are NOT transitions. `sessions.js` keeps a per-session live `agent_id` set (pure bookkeeping in `session/core/agent-tracker.js`), and `mapSignalToEvent` suppresses `ready` to `task_complete` while that set is non-empty, so a main-agent `Stop` fired while a background sub-agent (Task `run_in_background` / Ctrl+B) is still running does NOT falsely COMPLETE the card. The main agent usually auto-resumes when the sub-agent finishes and its later `Stop` (count back to 0) completes normally; when no later `Stop` ever comes (idle teammate, dropped `SubagentStop`), the suppressed `ready` is HELD (`_gateHeldReady` in `sessions.js`) and released when the count drains (via `SubagentStop`, a declared 0, or the TTL prune, bounded by a one-shot release timer), so the card cannot pin WORKING forever. The hold is cancelled by any newer activity (`working`/`resume`/`awaiting-input`), any state change, /clear, or PTY exit/restart. The live count rides `toSnapshot().activeAgents` and a `session-agents` control broadcast (rendered as an "N agents" card chip). On by default; `config.json` `detectBackgroundAgents: false` is the kill switch (signals ignored, behavior as before). A dropped `SubagentStop` is bounded by a per-id TTL prune (`session/core/agent-tracker.js`) plus a hard clear on PTY exit / restart. **Authoritative override:** `Stop`/`SubagentStop` payloads carry `background_tasks` (Claude Code v2.1.145+), which sees background work the Start/Stop counting cannot (background Bash tasks, native-team teammates). Ground truth (extracted from the CC 2.1.199 binary, memory: background-tasks-ground-truth): the field is an ARRAY of `{ id, type, status, ... }` pre-filtered by the emitter to running|pending entries; `agent-tracker.extractBackgroundTasks` parses that shape only (the `{ count, tasks }` object from claude-code#33310 is a statusLine surface, never sent to hooks) with a defensive settled-status deny-list. `sessions.js` keeps the declared entries (`_bgDeclared`) and takes `max(counted, declaredActive)` for the gate, drains the counted map when a payload declares 0 running (no waiting on the TTL), and clears the snapshot on `resume` / PTY exit / restart. Absent field (older Claude) = counting behavior unchanged. **Teammate/task lifecycle drains:** an idle-but-alive teammate stays `status: running` in Claude's registry until shutdown, so every Stop re-declares it; Glissa subscribes `TaskCreated`/`TaskCompleted`/`TeammateIdle` (tracking-only, `_trackTaskLifecycle`) to drain per-id: `TaskCompleted(task_id)` adds the id to `_idleTaskIds`, which filters declared entries out of the gate and survives `resume`; `TaskCreated` reactivates the id (and, like `SubagentStart`, invalidates a gate-held ready). `TeammateIdle(teammate_name)` resolves via the TaskCreated name->id map when available; in practice `TaskCreated` NEVER fires for named-Agent teammates (live-verified vs CC 2.1.200, memory: named-agent-teammate-hook-sequence), and a declared entry can NOT be matched to a name (its `description` is the spawn prompt, live-verified), so per-id resolution is impossible with several live teammates. Instead an unresolved `TeammateIdle` is recorded BY NAME in `_idleTeammateNames` (Map<name, ts>, persists across `resume`), and `agent-tracker.declaredActiveCount` takes a fifth `idleNameCount` argument: it subtracts that count from the surviving declared `teammate`-type entries, clamped to that teammate count so a stale/extra idle name can never mask a shell/subagent entry. This is count-based, not id-based, so N simultaneous idle teammates each drain the gate by one regardless of ambiguity. A name is re-gated (deleted from `_idleTeammateNames`) by a matching `TaskCreated`, or by a `SubagentStart` whose `agent_id` embeds the name (`a<name>-<hex>`, live-captured) since no `TaskCreated` ever fires for a teammate the lead re-wakes via mailbox. **Releasing a held ready is re-validated against live evidence, never against the count alone.** One pure arbiter, `session/core/gate-release.js decideGateRelease`, decides every hold: `cancel` (the state moved on, or a non-ready signal arrived AFTER the stash), `gated` (background work still live), `wait` (eligible, quiet window not elapsed) or `release`. `sessions.js _evaluateGateHeldReady` is the thin shell that acts on the verdict and re-arms the single gate timer; there is no separate eager-clear path deciding staleness in parallel. Staleness is ordered by a signal SEQUENCE number, not a clock, because signals routinely share a millisecond. The activity check exists because a lead that auto-resumes on a teammate mailbox message fires no `UserPromptSubmit` and, since `OscTitleSource` emits `working` only on a kind EDGE, a card RUNNING with an already-spinning title reported nothing either: a held Stop then released minutes into a NEW turn and falsely COMPLETEd a working card. `_stashGateHeldReady` therefore also calls `resyncWorkingLatch()` on the title source, so the next real braille frame proves the turn is still open (a genuinely finished turn emits no further frames, so the release path is unaffected). The `gateReleaseSettleMs` quiet window (default 10s, `DEFAULT_GATE_RELEASE_SETTLE_MS` in `gate-release.js`) is still needed on top of that: the drain usually lands 1-3s BEFORE the mailbox wake, so an instant release would fire a false COMPLETE + notification before any spinner frame could arrive. Explicit `_clearGateHeldReady` calls remain only where no signal ever reaches `_onStatus` to carry the evidence: `SubagentStart`/`TaskCreated` (tracking-only signals, and fresh background work invalidates an older Stop), `SessionStart(clear|compact)`, the `resume` branch (it must beat the `_clearBgDeclared` drain in the same call), and PTY start/exit/destroy. A genuinely settled idle teammate still completes the card in ~10s instead of at the TTL. `_idleTeammateNames` is TTL-pruned lazily in `_activeAgentCount` (bound by `agentTtlMs`) so a stale name can never mask a future same-named teammate forever. **Scheduled self-revival never gates:** a declared entry of `type: 'dream'` (a pending `ScheduleWakeup`) is skipped entirely by `declaredActiveCount` (`NON_GATING_TASK_TYPES` in `agent-tracker.js`) - per `session/core/wakeup-tracker.js`'s own design a Stop with a pending wakeup IS a finished turn, surfaced via the advisory wakeup chip, not the completion gate. **Hook-less task types:** declared `shell`/`monitor` entries never get ANY completion hook, so past `shellTaskTtlMs` (default 5 min) since the declaring Stop they stop counting (`WEAK_TASK_TYPES` in `agent-tracker.js`) and the held-ready release timer re-checks at `min(agentTtlMs, shellTaskTtlMs, teammateTaskTtlMs)`; without this a background dev server or orphaned test shell pinned the card WORKING for the full 30-minute agent TTL after every turn. **Declared teammate entries are also TTL-bounded** (`teammateTaskTtlMs`, default 90s): real teammate work is already covered by the counted `SubagentStart`/`SubagentStop` map, so a declared `teammate` entry only matters for a dropped `SubagentStart`, while an idle-but-alive teammate is declared running forever and its drain depends on `TeammateIdle`/`TaskCompleted` hooks that sometimes never arrive; a short TTL bounds that stuck-WORKING failure at seconds instead of the 30-minute agent TTL.
- The PTY data path does NO content parsing beyond scanning for OSC-0 titles. Do not reintroduce body/line scraping.

### Notifications (lifecycle + delivery)

- The backend `state-change` listener acknowledges the old entry BEFORE deciding/triggering the new one (a WAITING -> COMPLETE hop must deliver the completion, not land on a live DELIVERED entry). The per-state decision is `session/core/notify-gate.js decideNotification(to, gate, event, { signal, hookSeen })`: terminal categories fire once per work cycle, and `user_kill` is always silent (killing a session is not "finished working"). **A work cycle starts only on a USER-driven RUNNING entry** - `INITIALIZING` (restart), event `user_input` (the user answered a WAITING prompt), or signal `resume` (an authoritative `UserPromptSubmit`). A self-wake RUNNING entry (title `working` after an orchestrator lead auto-resumes on a teammate mailbox message, which fires no `UserPromptSubmit`) does NOT reset the cycle, so a lead that wakes N times per prompt can fire 'complete' at most once per prompt instead of once per orchestration round. A degraded title-only session (`hookSeen: false`, and omitted opts) keeps the legacy reset-on-every-RUNNING behavior since it has no resume signal to key off. Because `working` (title) and `resume` (hook) are both IMMEDIATE in `status-source.js`, the title spinner can win the IDLE/COMPLETE->RUNNING transition and carry signal `working` for a REAL user prompt; the session therefore also emits a dedicated `user-prompt` event from the hook-only `resume` branch of `ingestHookSignal`, and the backend resets the cycle on it directly (`sess.on('user-prompt', ...)`), so the reset never depends on winning that race.
- `NotificationManager.trigger` validates the transition before mutating the entry; a trigger on a DELIVERED/ESCALATED entry REPLACES it (timers cleared), so an unacknowledged entry (e.g. a team pseudo-session) can notify again.
- Focus suppression DEFERS, never drops: while the dashboard is focused a notification parks in SUPPRESSED and is delivered when the window blurs (or discarded if acknowledged first).
- Delivery needs an open dashboard tab: the primary channel broadcasts `notify` over the control WS and the browser raises the native Notification. With multiple tabs open, a short-TTL localStorage claim (`public/notify-dedupe-core.mjs`) lets exactly one tab raise it. No tab open = no notification (opt-in `config.osToast` is the OS-level fallback).

### Session Spawning (node-pty)

Sessions spawn `claude` via `pty.spawn()` from node-pty (NOT `child_process.spawn`).

- Claude CLI produces zero output with piped stdio - a real PTY is required.
- Must unset env vars before spawn: `CLAUDECODE`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_ENTRYPOINT`
- Do NOT use `shell: true` - pass args as array
- Terminal name: `xterm-256color`, default 80x24
- `dangerouslySkipPermissions` flag spawns Claude with `--dangerously-skip-permissions`
- **Resolve-then-branch spawn (Windows):** `claude` is resolved once at module load (`resolveClaudeCommand` -> `{ path, kind }`, `kind` from `classifyClaudeKind`). The pure `buildSpawnCommand` then picks the spawn form: a real PE image (`.exe`/`.com`) is spawned directly via `pty.spawn(<abs path>, args)`; `.cmd`/`.bat`/`.ps1` shim installs (or a failed resolution) fall back to `cmd.exe /c claude`. Spawning the `.exe` directly avoids cmd's double command-line parse and its console-title write. The `cmd.exe /c` path is now a shim-only fallback, not the default. Tests inject the resolved command via the `spawnCommand` constructor option.

### Auto-Resume and Shutdown (crash-safe by construction)

- **Live session-id capture.** Every MAIN-agent hook payload carries Claude's `session_id`, and that value names the resumable transcript, so `sessions.js ingestHookSignal` captures it from WHICHEVER hook arrives (`_captureClaudeSessionId`): it validates against `RESUME_ID_RE` (exported from `session/core/auto-resume.js`, same shape the manual Resume dialog enforces), sets the live `_resumeSessionId`, and emits `claude-session-id`. Do NOT key this off one event name: Claude Code does not reliably fire `SessionStart` (2.1.220 fires none at startup, live-probed both interactive and headless), and keying the capture there left the id, and therefore boot auto-resume, permanently dead in production. The tracking-only background-agent signals (`SubagentStart`/`SubagentStop`, `TaskCreated`/`TaskCompleted`/`TeammateIdle`, wakeups) return before the capture on purpose: they can describe a different Claude session than the one this card resumes. The emit fires only on an actual id CHANGE, because every hook now feeds it and the backend's listener writes config.json synchronously. The backend persists it to that project's `resumeSessionId` immediately (`persistSessionField` in `backend.js`, no-op for ephemeral team/setup sessions). Claude assigns a NEW id on every resume, so re-capturing keeps the chain current. Persisting at hook time (not shutdown time) is what makes a hard kill of Glissa lossless: there is deliberately no shutdown flush.
- **`wasActive` marker.** Per-project boolean persisted on flips only: true when a session enters STARTING/RUNNING, false on `user_kill` / DONE / FAILED. A crash mid-run leaves it true on disk, which is exactly the boot signal.
- **Boot auto-resume.** `session/core/auto-resume.js pickAutoResume(projects, config)` (pure) selects projects with `wasActive` + a `resumeSessionId`; `runAutoResume` in `backend.js` starts each matching DORMANT session through the spawn gate (ConPTY wedges under concurrent spawns) after the worktree reconciliation pass. Spawn appends `--resume <id>` (pre-existing plumbing at `sessions.js` spawn-args assembly). No captured id = stays dormant, never guess with `--continue`. Kill switch: top-level `autoResume: false` (default true; Settings dialog toggle). A stale id fails the session to FAILED, which flips `wasActive` false, so there is no retry loop.
- **Shutdown signals.** `server.js` routes SIGINT/SIGTERM/SIGBREAK/SIGHUP through one guarded handler that awaits the PTY kill reaps (`awaitReaps`, bounded 3000ms) before exit, matching the dashboard-triggered lifecycle path. Still no `uncaughtException` handler by design. Shutdown never writes config: `wasActive` staying true across a server shutdown IS the resume-next-boot case.

### GitHub PR Auto-Review (opt-in, off by default)

An optional background lane that reviews the operator's OWN GitHub PRs and merges the clean ones, unattended. Inert unless BOTH `config.prReview.enabled` and `config.telegram` (botToken + chatId) are set; absent = byte-identical prior behavior. Configured from the dashboard Settings dialog's PR Review tab (`public/components/settings-dialog.html`, `public/dialogs.js`), persisted via the existing get-settings/update-settings control-WS flow. Unlike `osToast`, toggling takes effect immediately: `backend.js applySettingsReload` calls `pr-review-wiring.js restartIfConfigChanged()`, which restarts the poller only when a settings save or config.json hand-edit reload actually changes the `prReview`/`telegram` config key (`prReviewCfgKey`), so an unrelated save (cursorBlink, etc.) never disturbs a running poller. The restart itself is serialized through a `prPollerChain` promise chain: it awaits the old instance's `stop()` (which drains its in-flight reviews and pending state write, see `pr-poller.js`) before starting a fresh one gated by `prPollerShouldStart`, so a stale review can never race a new instance over the same result-file path, worktree, or state file. No server restart needed. Distinct from the Teams product feature.

- **Poller.** `server/pr-poller.js createPrPoller(deps)` is IO-FREE (every side effect injected) and unit-tested with fakes like `scheduler.js`. A `setInterval(intervalMinutes).unref()` (default 15m; the calendar `scheduler.js` cannot express intervals) drives one `tick()` per cycle behind a `tickRunning` re-entrancy guard. `stop()` is async: it clears the timer, then awaits a `running` Set of in-flight `runReview()` calls and the pending state-write chain, so a caller that reuses the same dependencies (a settings-triggered restart, or `shutdown()`) never races a stale review over the same result-file path, worktree, or state file. Wired at boot after `runAutoResume`; torn down in `shutdown()` (stop the poller, fire-and-forget since the process is exiting anyway, + reap the `reviewSessions` map alongside `teamSessions`).
- **Per project (`config.prReview.projects`, an explicit opt-in list of project ids).** `gh pr list` -> filter to the operator's own non-draft branches (skip forks/drafts/bots; pure `server/core/pr-review-core.js filterActionablePrs`) -> `planReviews` (head SHA changed since last review) and `planMerges` (phase `awaiting-checks`). State is one cross-project file (`~/.glissa/pr-review-state.json`, atomic tmp+rename), keyed `owner/repo#N` -> `{ reviewedHead, phase, inFlight, wasConflicting, pingedError }`; `inFlight` is reset on boot; entries are pruned when a PR leaves the open list (merged/closed elsewhere).
- **Review session.** One ephemeral headless `claude -p` per new head SHA, spawned through the shared `spawnGate` (START only, so reviews run concurrently under `maxConcurrentReviews`), keyed on the `exit` event, into a dedicated `reviewSessions` map (not surfaced as a card). A hard timeout (`spawnWithTimeout`, `reviewTimeoutSeconds` default 900) aborts a hung session (AbortController -> `sess.destroy()`) and frees the concurrency slot, so a stuck review cannot pin the cap forever. The verdict travels via a RESULT FILE the agent writes (`readReviewResult` in `backend.js`; missing/invalid/unknown -> ERROR, never a false clean), because `gh pr review` 422s on your OWN PR; findings go out as a `gh pr comment`.
- **Two lanes.** A clean PR is reviewed IN PLACE (diff-only: `gh pr diff` + reads at HEAD + `gh` remote ops, no checkout/worktree, no working-tree mutation), so it coexists with a live interactive session in the same repo. A CONFLICTING PR runs in an isolated `team-git` worktree (`gitWorkspace.create`, branch `glissa/pr-review/pr-N`), where the agent runs `gh pr checkout` + rebase onto `origin/<base>` + resolve + `git push`; a branch-in-use precheck (`gitWorkspace.listWorktreeBranches`) degrades to ERROR before spawning a doomed checkout, and every exit path `discard`s the worktree and deletes the leaked pr-head branch. `pr-poller` NEVER shells `git worktree` (it goes through `team-git`, the only module allowed to, per `tests/no-direct-git-worktree.test.js`); all `gh`/`git` go through `child-process-safe`.
- **Merge gate (poller only; the AGENT never merges).** `tryMerge` merges (`gh pr merge --rebase`) ONLY when: reviewedHead still equals the current head (a commit pushed after review is re-reviewed, never merged stale) AND `gh pr checks` is `green` (four-way `classifyChecks` in `pr-gh.js`: no checks -> `none`, never green; handles both CheckRun and legacy StatusContext shapes) AND the PR touches no `.github/workflows/` file (a gh error on that files query returns `null` -> fail CLOSED, defer to next tick). Own-non-fork-non-draft is already enforced by the actionable filter. Both no-checks and unknown-workflow fail closed, so a CI-less repo or a transient gh error never auto-merges.
- **Telegram.** `server/pr-telegram.js sendPrPing` (fire-and-forget, never throws) fires on ACTIONABLE transitions only (changes requested / conflicts resolved / merged / error); a clean-awaiting-checks PR is silent. PR-only: it is NOT a `NotificationManager` channel (no focus-suppression interaction, no session-complete pings).
- **Security.** The review session runs `--dangerously-skip-permissions` bounded by a best-effort `PR_REVIEW_DENY` deny-list (the real safety is that only the poller merges, behind the full gate above; the deny-list is a guard, not the guard). Consistent with the localhost single-user trust boundary below. Prereq when opted in: `gh` authenticated on the host.

### Session Recording (forensics)

Every real session writes a JSONL recording to `~/.glissa/recordings` (never a cwd-relative directory: recording is on by default and must not scatter through whichever repo the server was launched from). Two verbosity levels, ONE v2 format, declared in the header's `records` field so a reader can tell them apart without scanning:

- **`signals` (default, kill switch `recordSignals: false`).** Header, every hook callback with its payload VERBATIM (`background_tasks`, `session_id`, teammate fields: the exact evidence a detection post-mortem needs), every state transition with its detail, every `decision` record (the per-session decision trace from `session/core/decision-log.js`: each signal's mapper/gate outcome, each `decideGateRelease` verdict, and each notification decision with its reason), footer. Tiny. The detection design is only debuggable after the fact if this is on, so it is on: a completion-gate incident with recording off costs a forensic reconstruction from Claude transcripts instead of one grep.
- **`full` (opt-in, `capture: { enabled: true }`).** The above plus raw PTY bytes, user input and resizes. Bulky, and only replay-harness work (`detection/replay.js`, whose fixtures are v2 recordings) needs it.

Bounds, because this runs unattended: the file opens LAZILY on the first record (a DORMANT session that never starts leaves nothing behind), rotates at `maxFileSizeMB`, and each `open()` kicks off a fire-and-forget async sweep that keeps the newest `retainFiles` (default 20) recordings PER SESSION and drops anything past `retainDays` (default 7). The sweep is fully async by design (all sessions share one event loop) and best-effort: a locked file is skipped, never retried. Nothing awaits it except tests (`recorder.retentionDone`).

### Security: Trust Boundary

Glissa binds to `localhost` only. Both WebSocket channels (data and control) have **no authentication** - any process on the local machine can connect. This is acceptable for a single-user dev tool but means:

- Do NOT expose Glissa's port to the network (no `0.0.0.0` binding)
- The `dangerouslySkipPermissions` option is settable via the control WebSocket; any local process can create a permissionless session
- There is ONE HTTP write ingress, `POST /hook/:glissaId/:event` (Claude Code hook callbacks). It is localhost-only and gated by a per-session bearer token (unguessable, written into that session's managed settings file), so the trust level is "can read this session's settings file" = same as reading the PTY. Keep that token check if you touch the route.
- If network exposure is ever needed, add authentication to the control WebSocket first

### Session Identity

Sessions are keyed by a stable UUID (`id`), not the mutable display `name`. The `id` is auto-assigned on first load (via `ensureProjectIds`) and persisted to `config.json`. All Maps, WebSocket routes, and control messages use `id` as the primary key. The `name` is display-only and can be changed via inline rename.

### Dual WebSocket Architecture

- **Data WebSocket** (`/terminals/:sessionId`): Raw PTY bytes bidirectional. One per session per client.
- **Control WebSocket** (`/control`): JSON messages for state-change, snapshot, kill, restart, rename.
- xterm.js in the browser connects to data WebSocket; control panel uses control WebSocket.

### Dashboard Rendering (xterm.js)

- Each session card contains an xterm.js Terminal instance
- xterm.js handles ALL ANSI rendering - server is a dumb pipe
- `@xterm/addon-fit` for resize, `@xterm/addon-webgl` for GPU rendering
- Vite bundles @xterm/* for production; dev mode proxies to Express
- Status detection does NOT tap the rendered body; it scans only OSC-0 titles (fallback) and consumes Claude Code hooks (authoritative). See "Status Detection" above.

### WebSocket Transport

Use the `ws` package directly. Do NOT use Socket.IO or any abstraction over WebSockets.

### Teams (project-portable agent pipelines)

A team is a sequential pipeline (e.g. marketing: researcher -> strategist -> writer -> editor -> publisher) that runs against ANY project Glissa manages. Ownership is split:

- **Glissa owns the agents, as reusable blocks.** Generic brand-neutral role prompts live in `teams/_shared/agents/*.md` and pack scaffolds in `teams/_shared/pack-templates/*.md`; a team's `teams/<id>/` holds its `team.json` and optionally its own `agents/`/`pack-templates/` overrides. A stage resolves its prompt by explicit `stage.agent` (a shared role by name, path-traversal rejected) > team-local `agents/<id>.md` > shared `_shared/agents/<id>.md`, so a new team composes from the shared blocks instead of copying. Agent prompts never contain a specific project's brand/voice/URLs.
- **The project owns the pack.** Each run reads project specifics (voice-guide, avoid-list, brand, content-calendar, channels) from `<project>/.glissa/teams/<id>/pack/`. Everything Glissa writes into a target repo lives under `.glissa/` (the team's `outputPath`).
- **Project-level shared pack.** A team's `team.json` may list a subset of its `pack.required` files under `pack.shared`. Those files resolve from a project-level shared pack at `<project>/.glissa/pack/` (sibling of `.glissa/teams/`) instead of the per-team pack, so cross-team setup files (voice-guide, avoid-list, brand) are filled ONCE per project and reused by every team that declares them, rather than re-interviewed and duplicated per team. The one resolver `teamlib/team-output.js resolvePackLayout(projectPath, outputPath, packRequired, packShared)` maps each required file to either the shared dir or the team-local `pack/` and is the single source consumers (scaffold, status, setup, orchestrator, backend, team-git) use. A shared file templates ONLY from `teams/_shared/pack-templates/` (it is project-level, not team-flavored). Filling a shared file once configures every team that shares it; the second team's guided setup skips already-filled shared files. Migration is non-destructive: a pre-existing filled team-local copy of a now-shared file is promoted up into `.glissa/pack/` on the next scaffold (a byte-different second copy is reported as `divergent` and left for manual reconcile, never auto-merged or deleted). `team-git` copies `.glissa/pack/` into the run worktree; like the team pack it is never staged back. Today marketing shares voice-guide/avoid-list/brand; changelog/qa share nothing (they are self-contained).
- **First-run setup gate.** When the pack is missing or still holds a `GLISSA:NEEDS-INPUT` sentinel, the orchestrator scaffolds it from `pack-templates/`, emits `team-run-needs-setup`, and halts (zero stages). The operator fills the pack either by hand or through guided setup (next bullet), then re-runs.
- **Guided setup.** The dashboard's "Set up automatically" button sends `setup-team-pack`, which spawns ONE interactive Claude session (a normal PTY card, NOT a headless `-p` stage, because the interview needs back-and-forth). Seeded by `team-setup.js`, it reads the target repo, interviews the operator for the subjective pack fields (voice, avoid-list, audience), writes each pack file with the `GLISSA:NEEDS-INPUT` sentinel removed, and on exit broadcasts `team-pack-updated` so the dashboard drops the setup banner. The session is ephemeral: it lives in the `sessions` map, is never persisted to config.json, and is skipped by config-reload diffing.
- **Worktree isolation.** Each run executes in a throwaway git worktree from HEAD (`team-git.js`); the pack is copied in, the run is committed and fast-forwarded back to the base branch, so the working tree is never dirtied mid-run. A non-git target runs in place.
- **Stack assumption (v1):** Postiz + a content calendar. The publisher pushes Postiz drafts using the pack's `channels.md`.
- Each stage is a headless `claude -p` session; completion = process exit 0; the editor emits a `SHIP` / `FIX` / `BLOCK` verdict (the publisher runs only on `SHIP`). Stage gating is by required markdown sections in the handoff file.
- **Bounded FIX revision loop.** A verdict stage may declare `revise: { onVerdict, stages, maxRounds }` (and re-run stages declare `reviseReads`). On a matching verdict (e.g. `FIX`) the orchestrator re-runs the named earlier stages with their `reviseReads` (the writer gets the editor's `review.md` + its prior `drafts.md`) then re-audits, up to `maxRounds` (default 2), archiving each round's pair under `runs/<id>/rounds/r<n>-*` (`team-output.archiveRoundArtifacts`). It stops on `SHIP`, `BLOCK`, a byte-identical no-progress bail, or the budget. The `runIfVerdict` publisher gate is unchanged: publish happens ONLY on a final `SHIP`. New event `team-revise-round`, plus `round` on the stage events and `rounds` on `team-run-complete`.

## Coding Style

- CommonJS only: `const x = require('x')`, `module.exports = { ... }`
- No classes unless the pattern genuinely requires instance state
- Prefer explicit over clever
- Error handling: propagate errors via EventEmitter `error` events or callbacks, not thrown exceptions in async paths
- Keep functions small and single-purpose

## Parallel Agent Work (worktree isolation)

When fanning out multiple agents to edit this repo concurrently (Claude Code native teams or several spawned agents), give each agent its own git worktree (Agent `isolation: "worktree"`) and integrate the lane back once it is clean. This avoids working-tree collisions between concurrent lanes.

- This is a working convention for editing Glissa. It is distinct from the Glissa **Teams** product feature documented above, and does not use the OMC `omc team` / tmux runtime (tmux is unavailable on native Windows).
