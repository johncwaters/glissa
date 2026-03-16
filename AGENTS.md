<!-- Generated: 2026-03-11 | Updated: 2026-03-15T3 -->

# AGENTS.md — Glissa Project Map

Glissa is a lightweight Node.js background process that spawns and manages Claude Code sessions, streams PTY output to a browser dashboard via WebSocket, and sends Windows toast notifications for session events.

---

## Root-Level Files

### Core Server & Backend

| File | Purpose | Key Exports |
|------|---------|-------------|
| **server.js** | Production entry point — creates HTTP server, wires backend, handles SIGINT | `(none — top-level script)` |
| **backend.js** | Express + WebSocket server factory. Wires control/data WebSocket servers, session lifecycle, config hot-reload, static serving, and graceful shutdown onto a provided HTTP server | `createBackend(httpServer, options)` |
| **sessions.js** | Session class with 7-state machine (INITIALIZING → STARTING → RUNNING → WAITING → IDLE → DONE/FAILED). Spawns Claude CLI via node-pty, PTY lifecycle, pattern detection integration, replay buffer, watchdog/idle/escalation/auto-recover timers | `Session` |
| **patterns.js** | PatternDetector class (EventEmitter) with 3-layer prompt detection: Layer 1 (exact string matches), Layer 2 (regex patterns), Layer 3 (silence heuristic). ANSI stripping, self-test harness | `PatternDetector` |
| **control-handlers.js** | Control WebSocket message handler registry. Handler-map dispatch pattern for all control messages (add/remove/reorder sessions, settings, kill/restart/dismiss, shutdown/restart-server, repo scanning) | `registerControlHandlers(controlWss, deps)` |
| **config-store.js** | Configuration storage with resolution order (--config flag → ~/.glissa/config.json → ./config.json → auto-seed). Atomic read-modify-write, fs.watch hot-reload with self-write filtering | `createConfigStore()`, `TIMEOUT_KEYS`, `DEFAULT_CONFIG` |
| **notify.js** | Windows toast notifications via BurntToast PowerShell module with `msg *` fallback. Lazy-detects BurntToast across standard and OneDrive-redirected module paths | `notify(title, message)` |

### Configuration & Build

| File | Purpose |
|------|---------|
| **config.json** | Runtime configuration: port, timeout settings, repo roots, project definitions. Hot-reloaded by backend.js via config-store.js |
| **package.json** | Project manifest (CommonJS). Dependencies: express, ws, node-pty, @xterm/*. CLI entry: `bin/glissa.js` |
| **vite.config.js** | Vite frontend build config (ESM). Tailwind CSS plugin, backend plugin that attaches Express/WS to Vite's dev server, alias for shared/states.esm.js |
| **biome.json** | Biome linter config — scoped to `public/**`, formatter disabled, Tailwind CSS directives enabled, CSS specificity rule off |
| **CLAUDE.md** | Hard constraints and design decisions for agents working in this codebase |

---

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `assets/` | Source audio files and screenshots (see `assets/AGENTS.md`) |
| `bin/` | CLI entry point for `npx glissa` / global install (see `bin/AGENTS.md`) |
| `public/` | Browser dashboard — xterm.js terminals, session cards, dialogs (see `public/AGENTS.md`) |
| `shared/` | Shared state constants (CJS + ESM dual format) (see `shared/AGENTS.md`) |
| `docs/` | Publishing and CLI testing guides (see `docs/AGENTS.md`) |

---

## Architecture Overview

### Dual WebSocket Protocol

**Control WebSocket** (`ws://localhost:PORT/control`)
- **Server → Client:**
  - `{ type: 'snapshot', sessions: [...] }` — Initial session list
  - `{ type: 'state-change', session, from, to, event, timestamp }` — State transitions
  - `{ type: 'session-added', session, state }` — New session created (broadcast)
  - `{ type: 'session-removed', session }` — Session deleted (broadcast)
  - `{ type: 'session-modified', session, state }` — Session state updated (broadcast)
  - `{ type: 'sessions-reordered', order: [...] }` — Session list reordered (broadcast)
  - `{ type: 'settings', requestId, settings }` — Settings response (unicast)
  - `{ type: 'settings-error', requestId, message }` — Settings error (unicast)
  - `{ type: 'settings-updated', settings }` — Settings broadcast (multicast)
  - `{ type: 'repo-roots-scanned', requestId, directories }` — Repo scan result (unicast)
  - `{ type: 'shutting-down' }` — Server shutdown initiated
  - `{ type: 'restarting' }` — Server restart initiated
  - `{ type: 'error', message }` — Generic error (unicast)
- **Client → Server:**
  - `{ type: 'kill', session }` — Terminate session
  - `{ type: 'restart', session }` — Restart completed/failed session
  - `{ type: 'force-restart', session }` — Kill + restart active session
  - `{ type: 'dismiss', session }` — Dismiss false waiting detection
  - `{ type: 'add-session', name, path }` — Create new session
  - `{ type: 'remove-session', session }` — Delete session
  - `{ type: 'reorder-sessions', order: [...] }` — Reorder session list
  - `{ type: 'get-settings', requestId }` — Fetch current settings
  - `{ type: 'update-settings', requestId, settings }` — Modify settings
  - `{ type: 'scan-repo-roots', requestId }` — Scan configured repo roots
  - `{ type: 'shutdown' }` — Request server shutdown
  - `{ type: 'restart-server' }` — Request server restart

**Data WebSocket** (`ws://localhost:PORT/terminals/:sessionName`)
- **Server → Client:** Raw PTY output (string)
- **Client → Server:**
  - `{ type: 'input', data }` — Keystrokes to PTY
  - `{ type: 'resize', cols, rows }` — Terminal resize

### Session State Machine

```
INITIALIZING → STARTING → RUNNING → WAITING → IDLE → DONE
                                                    ↘ FAILED
```

**States (from shared/states.js):**
- **INITIALIZING** — Session object created, env prepared, ready to spawn
- **STARTING** — PTY spawned, awaiting first output (watchdog timer active)
- **RUNNING** — Claude CLI producing output, pattern detector active
- **WAITING** — Prompt detected (via PatternDetector), awaiting user input/dismiss. Auto-recover fires if ≥2 PTY data chunks arrive after autoRecoverSeconds
- **IDLE** — Silence timeout reached, no activity for attentionTimeoutSeconds
- **DONE** — Process exited cleanly (code 0) or user killed
- **FAILED** — Process exited with error, watchdog timeout, or spawn failure

**Transitions** governed by explicit event mapping (TRANSITIONS constant) and guards (GUARDS object).

### Pattern Detection (3 Layers)

**Layer 1: Exact String Matches** — `'Do you want to proceed?'`, `'(y/n)'`, etc. Checked first for high confidence.

**Layer 2: Regex Patterns** — Common prompt formats. Blacklist filters false positives (e.g., "Terminate batch job").

**Layer 3: Silence Heuristic** — If incomplete line (no newline) ends with `?` or `:` and no output arrives within silenceTimeoutMs, infer prompt.

All detection runs on ANSI-stripped PTY output (parallel stream, raw output untouched).

### Inter-Module Communication

Uses Node.js `EventEmitter`:
- **Session** emits: `'state-change'`, `'data'`, `'error'`, `'exit'`, `'needs-attention'`, `'session-failed'`, `'session-done'`
- **PatternDetector** emits: `'prompt-detected'`
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

---

## Key Implementation Details

### Session Spawning (node-pty)

Must use **node-pty** (`pty.spawn()`) NOT `child_process.spawn()` because Claude CLI produces zero output when stdio is piped.

**Requirements:**
- Real PTY with `cols=80, rows=24` (xterm-256color)
- Unset env vars before spawn: `CLAUDECODE`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_ENTRYPOINT`, `GLISSA_PORT`, `GLISSA_CONFIG`
- On Windows: spawn via `cmd.exe /c claude` (node-pty can't resolve .cmd shims directly)
- Pass args as array, NOT `shell: true`

### Replay Buffer

Sessions maintain a ring buffer (~100KB cap) of PTY output for dashboard reconnections.

### Timers & Cleanup

Sessions use explicit setTimeout/setInterval with cleanup on state transitions:
- **watchdog_timeout** (STARTING → FAILED if no output within `startingWatchdogSeconds`)
- **silence_timeout** (RUNNING → IDLE after `attentionTimeoutSeconds` of no output)
- **escalation_timer** (WAITING state: repeated notifications every `waitingEscalationSeconds`)
- **auto_recover_timer** (WAITING state: triggers `auto_recover` → RUNNING if ≥2 data chunks arrive after `autoRecoverSeconds`)

All timers cleared on `destroy()` to prevent leaks.

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

### Built-in Self-Test
```bash
node patterns.js
```
Runs PatternDetector self-test on hardcoded prompt examples.

### CLI Testing
See `docs/testing-cli.md` for comprehensive manual test scenarios.

### No Formal Test Framework
Project uses manual testing and spike scripts. No Jest, Mocha, or similar.

---

## Entry Points for Agents

| Task Type | Start Here | Key Files |
|-----------|-----------|-----------|
| Add session feature | `sessions.js` (Session class) | STATES, TRANSITIONS, GUARDS, entry/exit hooks |
| Add/remove/reorder sessions | `control-handlers.js` | handler map, config-store save |
| Add WebSocket message | `control-handlers.js` (handler map) | backend.js (broadcastControl) |
| Improve prompt detection | `patterns.js` (PatternDetector) | EXACT_MATCHES, REGEX_PATTERNS, silence heuristic |
| Fix dashboard UI | `public/session-card.js`, `public/app.js` | xterm.js setup, session card lifecycle |
| Add notification | `notify.js` (notify function) | BurntToast detection, msg fallback |
| Debug state transitions | `sessions.js` (transition guards) | GUARDS object, entry/exit hooks |
| Hot-reload config | `config-store.js` | watchForChanges, save, load |
| Tune auto-recovery | `sessions.js` (_resetAutoRecoverTimer) | autoRecoverSeconds, data chunk counting |
| Change settings UI | `public/dialogs.js` | createSettingsDialog, sendControlRequest |
| Add/modify themes | `public/theme.js` | THEMES object, terminal color mapping, CSS variable names |
| CLI flags/options | `bin/glissa.js` | arg parsing, env bridge |
| Build/bundling | `vite.config.js` | glissaBackendPlugin, Tailwind, aliases |

---

## Related Documentation

- `CLAUDE.md` — Project constraints and coding style
- `public/AGENTS.md` — Browser-side module documentation
- `shared/AGENTS.md` — Shared state constants
- `bin/AGENTS.md` — CLI entry point documentation
- `docs/AGENTS.md` — Publishing and testing guides

<!-- MANUAL: -->
