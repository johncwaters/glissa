<!-- Generated: 2026-03-11 | Updated: 2026-05-31 -->

# AGENTS.md — Glissa Project Map

Glissa is a lightweight Node.js background process that spawns and manages Claude Code sessions, streams PTY output to a browser dashboard via WebSocket, and sends Windows toast notifications for session events.

---

## Root-Level Files

### Core Server & Backend

| File | Purpose | Key Exports |
|------|---------|-------------|
| **server.js** | Production entry point — creates HTTP server, wires backend, handles SIGINT | `(none — top-level script)` |
| **backend.js** | Express + WebSocket server factory. Wires control/data WebSocket servers, session lifecycle, config hot-reload, static serving, and graceful shutdown onto a provided HTTP server | `createBackend(httpServer, options)` |
| **sessions.js** | Session class with the state machine (DORMANT -> INITIALIZING -> STARTING -> RUNNING -> WAITING/IDLE/COMPLETE -> DONE/FAILED). Spawns Claude CLI via node-pty, PTY lifecycle, StatusSource-driven detection (`_onStatus` maps signals to transitions), replay buffer. NO screen scraping. | `Session` |
| **detection/status-source.js** | StatusSource (EventEmitter). Merges hook + title signals: precedence hook>title, conflict window (`awaiting-input` dominates `ready`), dedup. Emits normalized `working/ready/awaiting-input/resume/session-start/session-end`. | `StatusSource`, `createStatusSource()` |
| **detection/osc-title-source.js** | OSC-0 title fallback source. Braille spinner = `working`, idle glyph = `ready`, unknown glyph = `unknown`; NEVER emits `awaiting-input`. Ports `findOscTitle`/`isBrailleChar`. | `OscTitleSource`, `createOscTitleSource()`, `findOscTitle`, `isBrailleChar` |
| **detection/hook-source.js** | HookRouter: per-session bearer-token validation + `mapHookToSignal` (Claude Code hook event -> normalized signal). Backed by `POST /hook/:glissaId/:event`. | `HookRouter`, `mapHookToSignal` |
| **detection/settings-injector.js** | Writes per-session `--settings` file with HTTP hooks (URL carries glissaId+token), under a per-session %TEMP% subdir; `sweepOrphans` clears stale dirs. | `writeSessionSettings`, `buildHookSettings`, `sweepOrphans`, `generateToken` |
| **detection/replay.js** | Version-aware replay harness — drives recordings (v1 data-only, v2 data+hook) back through the real detection pipeline for ground-truth tests. | `parseRecording`, `replayDetection`, `summarize` |
| **session-recorder.js** | SessionRecorder class — always-on JSONL recorder (format v2). Records header, data chunks, hook callbacks, state transitions, user input, resize, footer. Auto-rotation at 50MB, retention cleanup. Factory: `createRecorder(name, config)` returns null if disabled | `SessionRecorder`, `createRecorder()` |
| **control-handlers.js** | Control WebSocket message handler registry. Handler-map dispatch pattern for all control messages (add/remove/reorder sessions, settings, kill/restart/dismiss, shutdown/restart-server, focus-change, repo scanning) | `registerControlHandlers(controlWss, deps)` |
| **config-store.js** | Configuration storage with resolution order (--config flag -> local config.json -> ~/.glissa/config.json -> auto-seed). Atomic read-modify-write, fs.watch hot-reload with self-write filtering | `createConfigStore()`, `TIMEOUT_KEYS`, `DEFAULT_CONFIG` |
| **notification-manager.js** | NotificationManager class (EventEmitter). Per-session notification state machine (IDLE/PENDING/DELIVERED/ESCALATED/ACKNOWLEDGED), pluggable channel delivery, focus suppression, category debounce, escalation ping-pong for WAITING notifications | `NotificationManager` |

### Configuration & Build

| File | Purpose |
|------|---------|
| **config.json** | Runtime configuration: port, timeout settings, repo roots, project definitions. Hot-reloaded by backend.js via config-store.js. Gitignored |
| **package.json** | Project manifest (CommonJS). Dependencies: express, ws, node-pty, @xterm/*. CLI entry: `bin/glissa.js` |
| **vite.config.js** | Vite frontend build config (ESM). Tailwind CSS plugin, backend plugin that attaches Express/WS to Vite's dev server, alias for shared/states.esm.js |
| **biome.json** | Biome linter config — excludes dist, node_modules, ESM files, vite.config.js. Formatter disabled. Tailwind CSS directives enabled |
| **CLAUDE.md** | Hard constraints and design decisions for agents working in this codebase |

---

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `assets/` | Source audio files and screenshots (see `assets/AGENTS.md`) |
| `bin/` | CLI entry point for `npx glissa` / global install (see `bin/AGENTS.md`) |
| `channels/` | Pluggable notification delivery adapters for NotificationManager (see `channels/AGENTS.md`) |
| `detection/` | Structural status detection — hook (authoritative) + OSC title (fallback) sources, merge layer, settings injector, replay harness (see `detection/AGENTS.md`) |
| `docs/` | Publishing, CLI testing, and the terminal-detection postmortem (see `docs/AGENTS.md`) |
| `public/` | Browser dashboard — xterm.js terminals, session cards, dialogs (see `public/AGENTS.md`) |
| `scripts/` | Release automation scripts (see `scripts/AGENTS.md`) |
| `shared/` | Shared state constants and notification state machine (CJS + ESM) (see `shared/AGENTS.md`) |
| `test/` | Hand-run console-harness scripts (notification manager, dormant-boot smoke) (see `test/AGENTS.md`) |
| `tests/` | Automated `node:test` suite run by `npm test` + replay fixtures (see `tests/AGENTS.md`) |

---

## Architecture Overview

### Dual WebSocket Protocol

**Control WebSocket** (`ws://localhost:PORT/control`)
- **Server -> Client:**
  - `{ type: 'snapshot', sessions: [...] }` — Initial session list
  - `{ type: 'state-change', session, from, to, event, timestamp }` — State transitions
  - `{ type: 'session-added', session, state }` — New session created (broadcast)
  - `{ type: 'session-removed', session }` — Session deleted (broadcast)
  - `{ type: 'session-modified', session, state }` — Session recreated after path change (broadcast)
  - `{ type: 'sessions-reordered', order: [...] }` — Session list reordered (broadcast)
  - `{ type: 'settings', requestId, settings }` — Settings response (unicast)
  - `{ type: 'settings-error', requestId, message }` — Settings validation error (unicast)
  - `{ type: 'settings-updated', settings }` — Settings broadcast after save (multicast)
  - `{ type: 'repo-roots-scanned', requestId, directories }` — Repo scan result (unicast)
  - `{ type: 'shutting-down' }` — Server shutdown initiated
  - `{ type: 'restarting' }` — Server restart initiated
  - `{ type: 'error', message }` — Generic error (unicast)
- **Client -> Server:**
  - `{ type: 'kill', session }` — Terminate session
  - `{ type: 'restart', session }` — Restart completed/failed session
  - `{ type: 'force-restart', session }` — Kill + restart active session
  - `{ type: 'dismiss', session }` — Dismiss WAITING/COMPLETE state
  - `{ type: 'add-session', name, path }` — Create new session
  - `{ type: 'remove-session', session }` — Delete session
  - `{ type: 'reorder-sessions', order: [...] }` — Reorder session list
  - `{ type: 'get-settings', requestId }` — Fetch current settings
  - `{ type: 'update-settings', requestId, settings }` — Modify settings
  - `{ type: 'scan-repo-roots', requestId }` — Scan configured repo roots
  - `{ type: 'shutdown' }` — Request server shutdown
  - `{ type: 'restart-server' }` — Request server restart
  - `{ type: 'focus-change', focused }` — Dashboard visibility (suppresses notifications)

**Data WebSocket** (`ws://localhost:PORT/terminals/:sessionName`)
- **Server -> Client:** Raw PTY output (string)
- **Client -> Server:**
  - `{ type: 'input', data }` — Keystrokes to PTY (max 16384 chars)
  - `{ type: 'resize', cols, rows }` — Terminal resize (validated bounds)

### Session State Machine

```
INITIALIZING -> STARTING -> RUNNING -> WAITING -> IDLE -> DONE
                               |          |               ^
                               v          v               |
                            COMPLETE ---->+----------> FAILED
```

**States (from shared/states.js):**
- **INITIALIZING** — Session object created, env prepared, ready to spawn
- **STARTING** — PTY spawned, awaiting first output or hook signal
- **RUNNING** — Claude CLI producing output; StatusSource active
- **WAITING** — `awaiting-input` signal (authoritative hook: `Notification`/`PermissionRequest`), awaiting user input/dismiss
- **IDLE** — quiescent post-turn state (rarely entered now; resume via `working`/`resume`)
- **COMPLETE** — turn finished via authoritative `ready` (`Stop` hook) or title `working`->`ready`. Notifications sent
- **DONE** — Process exited cleanly (code 0) or user killed
- **FAILED** — Process exited with error or spawn failure

**Transitions** governed by explicit event mapping (TRANSITIONS constant) and guards (GUARDS object).

### Status Detection (structural signals)

Two sources feed `StatusSource`, which maps a normalized signal to a transition in `sessions.js._onStatus`:

- **Authoritative — Claude Code hooks** (`detection/hook-source.js` + `detection/settings-injector.js`): `Stop`/`Notification(idle_prompt)` -> `ready`; `Notification(permission_prompt)`/`PermissionRequest` -> `awaiting-input`; `UserPromptSubmit` -> `resume`; `SessionStart`/`SessionEnd` -> lifecycle. Injected via `claude --settings <file>` HTTP hooks POSTing to `POST /hook/:glissaId/:event` (per-session bearer token).
- **Fallback — OSC-0 title** (`detection/osc-title-source.js`): braille spinner -> `working`; idle glyph (stabilized) -> `ready`; unknown glyph -> `unknown`. Never emits `awaiting-input`.

`StatusSource` applies precedence (hook > title), a conflict window (`awaiting-input` dominates a racing `ready`), and dedup (absorbs `Stop` double-fire). There is NO body/line content scraping. See the signal x state matrix in `.omc/plans/rewrite-terminal-detection.md` §4a and `docs/postmortem-terminal-detection.md`.

### Notification System (NotificationManager + Channels)

`notification-manager.js` owns a per-session notification state machine:

```
IDLE -> PENDING -> DELIVERED <-> ESCALATED -> ACKNOWLEDGED -> IDLE
```

- **PENDING** is transient — auto-resolves via suppress/debounce/deliver in entry hook
- **DELIVERED <-> ESCALATED** ping-pong for `waiting` category (escalation timer)
- **COMPLETE/FAILED** categories are one-shot (no escalation)
- Focus suppression and category debounce checked in PENDING entry hook
- Delivery delegates to registered channels (`channels/toast.js`)

State machine defined in `shared/notification-states.js`, mirroring the session state pattern.

The old `notify.js` is deprecated (no-op stubs).

### Inter-Module Communication

Uses Node.js `EventEmitter`:
- **Session** emits: `'state-change'`, `'data'`, `'error'`, `'exit'`, `'needs-attention'`, `'attention-cleared'`, `'session-failed'`, `'session-done'`
- **OscTitleSource** emits: `'signal'` ({signal,char,...}); **StatusSource** emits: `'status'`, `'meta'`
- **NotificationManager** emits: `'notification-state-change'`
- No global variables, no direct coupling

### Backend Factory Pattern

`createBackend(httpServer, options)` is the core wiring function used by both:
- `server.js` — Production: standalone HTTP server
- `vite.config.js` — Dev: attached to Vite's internal HTTP server via plugin

Dependencies are injected into control handlers via a deps object.

### Config Hot-Reload

`config-store.js` watches config.json with debounced read-modify-apply:
1. `fs.watch()` on config file
2. Debounce 500ms, ignore self-writes (within 500ms of last save)
3. Read fresh, validate (must have `projects` array), apply changes
4. `diffProjects()` computes added/removed/modified sessions, applies incrementally

### Client Focus Tracking

Dashboard sends `focus-change` messages when window gains/loses focus. Server suppresses toast notifications when any dashboard client is focused (`setNotifySuppressed`).

---

## Key Implementation Details

### Session Spawning (node-pty)

Must use **node-pty** (`pty.spawn()`) NOT `child_process.spawn()` because Claude CLI produces zero output when stdio is piped.

**Requirements:**
- Real PTY with `cols=80, rows=24` (xterm-256color)
- Unset env vars before spawn: `CLAUDECODE`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_ENTRYPOINT`, `GLISSA_PORT`, `GLISSA_CONFIG`
- **Resolve-then-branch spawn (Windows):** `claude` is resolved once at module load (`resolveClaudeCommand` -> `{ path, kind }`). The pure `buildSpawnCommand` then picks the form: a real PE image (`.exe`/`.com`) is spawned directly via `pty.spawn(<abs path>, args)`; `.cmd`/`.bat`/`.ps1` shims (or a failed resolution) fall back to `cmd.exe /c claude`. Spawning the `.exe` directly avoids cmd's double command-line parse and its console-title write. Tests inject the resolved command via the `spawnCommand` option. See `tests/spawn-command.test.js`
- Pass args as array, NOT `shell: true`

### Replay Buffer

Sessions maintain a ring buffer (~100KB cap) of PTY output for dashboard reconnections.

### Timers & Cleanup

Sessions use explicit setTimeout with cleanup on transition/exit/destroy:
- **sleep-kill** (auto-kill a sleeping session after 15 min)
- **kill-poll** (force-kill escalation after a graceful kill)

Status no longer uses idle/silence/auto-recover/startup-grace timers — those were part of the deleted content-scraping detector. Turn-end and needs-input now come from hooks (or the OSC-title fallback). Notification escalation lives entirely in `NotificationManager`. All timers and both detection sources are cleared on `destroy()` to prevent leaks.

### Session Recording (SessionRecorder)

`session-recorder.js` provides an optional always-on JSONL recording of PTY sessions (format v2). Each session can have a recorder that captures data chunks, hook callbacks, state transitions, user input, and resize events. Recordings are stored in `.pty-capture/` with automatic rotation at 50MB and retention cleanup after 7 days. Enabled via `capture` config block. `detection/replay.js` replays recordings (v1 + v2) back through the detection pipeline.

### Graceful Shutdown

`shutdown()` destroys all sessions, closes WebSocket servers. On Windows, `kill()` uses non-blocking poll with `taskkill /T /F` fallback after 3 seconds.

---

## Hard Constraints (from CLAUDE.md)

**DO NOT introduce:**
- TypeScript, React, or any frontend framework
- Additional server frameworks (only Express)
- ESM (`import`/`export`) in Node.js code (server-side is CommonJS only)
- XState or formal state machine libraries
- Global variables
- New dependencies without explicit instruction

**DO use:**
- CommonJS (`require`/`module.exports`) for server code
- ES modules for browser code (bundled by Vite)
- Node.js `EventEmitter` for inter-module communication
- Explicit state transitions with guards
- Tailwind utility classes for HTML, semantic classes in style.css for JS-created DOM
- `ws` package directly (no Socket.IO)

---

## Platform & Runtime

- **OS:** Windows 11
- **Node:** v18+ (engines field), v24+ in development
- **Module System:** CommonJS (server), ES modules (browser/Vite)
- **Build:** Vite + Tailwind CSS v4
- **Build Tools:** Visual Studio Build Tools (required for node-pty C++ module)

---

## Dependencies

| Package | Version | Usage |
|---------|---------|-------|
| `express` | ^4.18.2 | HTTP server, static file serving |
| `ws` | ^8.16.0 | WebSocket server (direct, no Socket.IO) |
| `node-pty` | ^1.1.0 | PTY spawning for Claude CLI |
| `@xterm/xterm` | ^6.0.0 | Terminal emulator (browser only) |
| `@xterm/addon-fit` | ^0.11.0 | Terminal resize (browser only) |
| `@xterm/addon-webgl` | ^0.19.0 | GPU-accelerated rendering (browser only) |
| `vite` | ^7.3.1 | Dev server with HMR, production bundling (dev only) |
| `tailwindcss` | ^4.2.1 | Utility-first CSS framework (dev only) |
| `@tailwindcss/vite` | ^4.2.1 | Tailwind CSS Vite plugin (dev only) |

---

## Testing & Validation

### Unit / integration tests
```bash
npm test            # node --test "tests/**/*.test.js"
```
Covers `detection/*` (osc-title, status-source, hook-source, settings-injector), the §4a
signal x state matrix (`tests/sessions-detection.test.js`), and the replay harness over
recorded fixtures (`tests/replay-harness.test.js`, fixtures in `tests/fixtures/`).

### CLI Testing
See `docs/testing-cli.md` for comprehensive manual test scenarios.

---

## Entry Points for Agents

| Task Type | Start Here | Key Files |
|-----------|-----------|-----------|
| Add session feature | `sessions.js` (Session class) | STATES, TRANSITIONS, GUARDS, entry/exit hooks |
| Add/remove/reorder sessions | `control-handlers.js` | handler map, config-store save |
| Add WebSocket message | `control-handlers.js` (handler map) | backend.js (broadcastControl) |
| Improve status detection | `detection/status-source.js`, `detection/hook-source.js` | signal x state matrix (`_onStatus`), hook mapping, conflict window |
| Hook injection / settings | `detection/settings-injector.js` | per-session `--settings`, bearer token, HTTP hooks |
| OSC title fallback | `detection/osc-title-source.js` | braille spinner, idle glyph, KNOWN_IDLE_CODEPOINTS |
| Session recording / replay | `session-recorder.js` (v2), `detection/replay.js` | JSONL format, hook records, replay harness |
| Fix dashboard UI | `public/session-card.js`, `public/app.js` | xterm.js setup, session card lifecycle |
| Add notification channel | `channels/toast.js` (pattern) | `notification-manager.js` registerChannel |
| Notification state/logic | `notification-manager.js` (NotificationManager) | `shared/notification-states.js`, `channels/` |
| Debug state transitions | `sessions.js` (transition guards) | GUARDS object, entry/exit hooks |
| Hot-reload config | `config-store.js` | watchForChanges, save, load |
| Tune auto-recovery | `sessions.js` (_resetAutoRecoverTimer) | autoRecoverSeconds, data chunk counting |
| Change settings UI | `public/dialogs.js` | createSettingsDialog, sendControlRequest |
| Add/modify themes | `public/theme.js` | THEMES object, terminal color mapping, CSS variable names |
| CLI flags/options | `bin/glissa.js` | arg parsing, env bridge |
| Build/bundling | `vite.config.js` | glissaBackendPlugin, Tailwind, aliases |
| Release/publish | `scripts/release.js` | npm publish, git tag, GitHub release |

---

## Related Documentation

- `CLAUDE.md` — Project constraints and coding style
- `detection/AGENTS.md` — Structural status detection (hook + OSC title sources, merge, replay)
- `channels/AGENTS.md` — Notification delivery channels
- `public/AGENTS.md` — Browser-side module documentation
- `shared/AGENTS.md` — Shared state and notification constants
- `bin/AGENTS.md` — CLI entry point documentation
- `docs/AGENTS.md` — Publishing and testing guides
- `scripts/AGENTS.md` — Release automation
- `tests/AGENTS.md` — Automated `node:test` suite and fixtures
- `test/AGENTS.md` — Hand-run console-harness scripts

---

## Design Context

Glissa's design system has two source-of-truth files at the project root. Read them before any UI work.

- **`PRODUCT.md`** (strategic — who/what/why): register, users, purpose, brand personality, anti-references, design principles, accessibility.
- **`DESIGN.md`** (visual — how it looks): the "Phyrexian Console" system — colors, typography, elevation, components, do's and don'ts.

**Register:** `product` (the design serves the tool; the operator console is the primary surface).

**Felt goal:** "I trust the board." Every signal is earned, so the operator can act on what they see without re-checking.

**Five principles** (full text in PRODUCT.md):
1. **Earned signal** — color/motion only on a real state change.
2. **The terminal is the product** — chrome recedes; cut any pixel that doesn't route attention to data.
3. **Quiet by default, loud only on change** — calm at rest, raises its voice only when a session needs a human.
4. **State is structural, never guessed** — hooks + OSC-0 title; show unknown as unknown.
5. **One voice** — single accent, single mono family; hierarchy from weight, tracking, color, and case.

These are maintained via the `impeccable` skill (`$impeccable teach` / `document`).

<!-- MANUAL: -->
