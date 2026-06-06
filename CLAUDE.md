# Glissa — Agent Instructions

## Project Purpose

Glissa is a lightweight Node.js background process that spawns and manages Claude Code sessions, streams output to a browser dashboard via WebSocket, and alerts via Windows toast notifications.

## File Structure

```
server.js          # Production entry point (thin wrapper)
backend.js         # Express + WebSocket server factory (shared by server.js and Vite plugin)
sessions.js        # Session class: lifecycle, PTY spawn/kill, timers, hooks; consumes StatusSource; delegates pure logic to session-core/
session-core/      # Pure cores of a SEAM EXTRACTION from sessions.js — the stateful Session class stays at root by design (moving it in = deferred follow-up)
  spawn-command.js # classifyClaudeKind, resolveClaudeCommand, buildSpawnCommand, CLAUDE_CMD (resolve-then-branch spawn)
  spawn-env.js     # Pure buildSpawnEnv(baseEnv) — the 5-var scrub + always-on NO_FLICKER, returns a copy
  state-machine.js # TRANSITIONS, GUARDS, ENTRY_HOOKS, EXIT_HOOKS (lifecycle tables, relocated verbatim)
  status-mapper.js # Pure mapSignalToEvent(signal, state, confidence) -> event|null (the _onStatus decision)
detection/
  status-source.js     # Merges hook + title signals (precedence, conflict window, dedup)
  osc-title-source.js  # OSC-0 title fallback signal (working/ready/unknown only)
  hook-source.js       # HookRouter: validates per-session token, maps Claude Code hooks -> signals
  settings-injector.js # Per-session `--settings` file with HTTP hooks (token in URL)
  replay.js            # Version-aware replay harness (drives recordings through detection)
notification-manager.js  # Notification lifecycle state machine
channels/web-notification.js  # PRIMARY: broadcasts `notify` over control WS; browser raises native Notification (Windows Action Center)
channels/toast.js  # Opt-in fallback (config.osToast): Windows OS toast via BurntToast/msg; off by default (unreliable across machines)
vite.config.js     # Vite frontend build config + backend plugin (ESM)
public/
  index.html       # Dashboard shell (Tailwind utility classes)
  app.js           # Browser-side entry point (ES module)
  tailwind.css     # Tailwind CSS entry (theme + imports)
  style.css        # Component styles, state-driven rules, animations
  control-ws.js    # WebSocket control channel client
  dialogs.js       # Add Session and Settings dialog factories
  session-card/    # Session card modules (decomposed from session-card.js)
    card-registry.js   # Shared state owner: sessionUIs Map + 3 DOM singletons
    toast.js           # showErrorToast — leaf, no local deps
    naming.js          # countSessionsByName, suggestSessionName (wraps naming-core.mjs)
    naming-core.mjs    # Pure: nextSuggestedName, countAutoNames, isAutoNameOf
    webgl-pool.js      # WebGL context pool with LRU cap (wraps webgl-core.mjs)
    webgl-core.mjs     # Pure: pickEvictionVictims
    card-dom.js        # Card builder, badge, inline rename, confirm dialog, debug overlay
    terminal.js        # xterm.js setup, data WebSocket, OSC-52 clipboard
    layout.js          # Minimize/maximize/split/sleep cluster (mutually recursive)
    drag-drop.js       # Container-level drag-and-drop, setupDragAndDrop
    geometry-core.mjs  # Pure: closestCardByCenter (used by drag-drop)
    lifecycle.js       # createSessionCard, removeSessionCard, applyState, etc.
    aggregate-core.mjs # Pure: computeAggregate (used by lifecycle)
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
  team-git.js        # per-run git worktree isolation + fast-forward merge back
  team-prompt.js     # stage prompt builder (embeds pack + run paths)
  team-setup.js      # guided pack setup: interview prompt + interactive setup-session helpers
  team-settings.js   # per-stage spawn options and permission config
  team-blacklist.js  # glob deny-list enforcement (test-only, not published)
config.json        # Runtime configuration
dist/              # Vite production build output (gitignored)
```

## Development Workflow

- `npm run dev` — Vite dev server with HMR on port 5173, Express + WebSocket backend attached via plugin (single process)
- `npm run dev:server-only` — Express backend only on port 3000 (for debugging backend without Vite)
- `npm run build` — Production build to `dist/`
- `npm start` — Production server (serves from `dist/` if it exists, otherwise `public/`)
- `npm run preview` — Preview production build via Vite

## Platform and Runtime

- **OS:** Windows 11
- **Node:** v24+
- **Module system:** CommonJS (`require` / `module.exports`) for server — no ESM. Frontend uses ES modules bundled by Vite.

## Production Dependencies

- `express` — HTTP server and static file serving
- `ws` — WebSocket server
- `node-pty` — Pseudo-terminal for spawning Claude Code with real PTY support
- `@xterm/xterm` — Terminal emulator (loaded in browser via ES modules, not in Node.js)
- `@xterm/addon-fit` — xterm.js addon for fitting terminal to container (browser only)
- `@xterm/addon-webgl` — xterm.js addon for WebGL rendering (browser only)

**Dev Dependencies:**

- `vite` — Frontend build tool (dev server with HMR, production bundling)
- `tailwindcss` — Utility-first CSS framework (v4)
- `@tailwindcss/vite` — Tailwind CSS Vite plugin

**Notes:**

- `node-pty` requires C++ build tools (Visual Studio Build Tools on Windows)
- `@xterm/*` packages are bundled by Vite for the browser, not loaded directly in Node.js

Do NOT add dependencies without explicit instruction.

### CSS Convention

- **Tailwind utility classes** for static HTML markup (`index.html`)
- **Semantic classes** in `style.css` for JS-created DOM elements (`session-card/lifecycle.js`, `session-card/card-dom.js`, `dialogs.js`)
- **State-driven styles** via `[data-state]` attribute selectors in `style.css`
- **Animations** (`@keyframes`) and pseudo-elements (`::before`) in `style.css`
- **Theme** defined in `public/tailwind.css` via `@theme` block — maps colors, fonts, radii

## Key Design Decisions

### Inter-module Communication

Use Node.js `EventEmitter` for communication between modules. Do not use global variables or direct coupling.

### Session State Machine

Sessions follow a 7-state machine implemented in plain JS:

```
INITIALIZING → STARTING → RUNNING → WAITING → IDLE → DONE
                                                    ↘ FAILED
```

States are string constants. Transitions are explicit — no implicit state mutation.

### Status Detection (structural signals — NOT screen scraping)

Status is derived from machine-emitted signals, never from parsing the rendered TUI:

- **Authoritative: Claude Code hooks.** At spawn, `sessions.js` appends `--settings <file>` (written by `detection/settings-injector.js`) injecting HTTP hooks (`Stop`, `Notification`, `UserPromptSubmit`, `SessionStart`/`End`) that POST to `POST /hook/:glissaId/:event` on the existing Express server. A per-session bearer token (in the hook URL) is validated by `detection/hook-source.js` `HookRouter`. No target-repo modification; HTTP hooks need no shell.
- **Fallback: OSC-0 title** (`detection/osc-title-source.js`) — braille spinner = `working`, idle glyph = `ready`; an unknown glyph is `unknown`, never a guess. It NEVER emits `awaiting-input`.
- `detection/status-source.js` merges both (precedence hook > title), holds `ready` for a conflict window so a racing `awaiting-input` wins, and dedups. `sessions.js._onStatus` maps the normalized signal to a transition per the signal x state matrix (see `.omc/plans/rewrite-terminal-detection.md` §4a and `docs/postmortem-terminal-detection.md`).
- The PTY data path does NO content parsing beyond scanning for OSC-0 titles. Do not reintroduce body/line scraping.

### Session Spawning (node-pty)

Sessions spawn `claude` via `pty.spawn()` from node-pty (NOT `child_process.spawn`).

- Claude CLI produces zero output with piped stdio — a real PTY is required.
- Must unset env vars before spawn: `CLAUDECODE`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_ENTRYPOINT`
- Do NOT use `shell: true` — pass args as array
- Terminal name: `xterm-256color`, default 80x24
- `dangerouslySkipPermissions` flag spawns Claude with `--dangerously-skip-permissions`
- **Resolve-then-branch spawn (Windows):** `claude` is resolved once at module load (`resolveClaudeCommand` -> `{ path, kind }`, `kind` from `classifyClaudeKind`). The pure `buildSpawnCommand` then picks the spawn form: a real PE image (`.exe`/`.com`) is spawned directly via `pty.spawn(<abs path>, args)`; `.cmd`/`.bat`/`.ps1` shim installs (or a failed resolution) fall back to `cmd.exe /c claude`. Spawning the `.exe` directly avoids cmd's double command-line parse and its console-title write. The `cmd.exe /c` path is now a shim-only fallback, not the default. Tests inject the resolved command via the `spawnCommand` constructor option.

### Security: Trust Boundary

Glissa binds to `localhost` only. Both WebSocket channels (data and control) have **no authentication** — any process on the local machine can connect. This is acceptable for a single-user dev tool but means:

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
- xterm.js handles ALL ANSI rendering — server is a dumb pipe
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
