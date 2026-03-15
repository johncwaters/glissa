<!-- Generated: 2026-03-11 -->

# AGENTS.md — Glissa Project Map

Glissa is a lightweight Node.js background process that spawns and manages Claude Code sessions, streams PTY output to a browser dashboard via WebSocket, and sends Windows toast notifications for session events.

---

## Root-Level Files

### Core Server & Sessions

| File | Lines | Purpose | Key Exports |
|------|-------|---------|-------------|
| **server.js** | ~601 | Express HTTP server, dual WebSocket architecture (control + data), session lifecycle, config hot-reload, settings management, graceful shutdown | `app`, `server`, `wss`, `sessionMap`, `controlWss` |
| **sessions.js** | ~455 | Session class with 7-state machine (INITIALIZING → STARTING → RUNNING → WAITING → IDLE → DONE/FAILED). Spawns Claude CLI via node-pty, PTY lifecycle, pattern detection integration, replay buffer, watchdog/idle/escalation/auto-recover timers | `Session`, `STATES`, `TRANSITIONS`, `GUARDS` |
| **patterns.js** | ~316 | PatternDetector class (EventEmitter) with 3-layer prompt detection: Layer 1 (exact string matches), Layer 2 (regex patterns), Layer 3 (silence heuristic). ANSI stripping, self-test harness | `PatternDetector`, `stripAnsi()`, self-test via `node patterns.js` |
| **notify.js** | ~55 | Windows toast notifications via BurntToast PowerShell module with `msg *` fallback. Lazy-detects BurntToast availability on first use | `notify(title, message)` |

### Configuration & Manifests

| File | Purpose |
|------|---------|
| **config.json** | Runtime configuration: port, timeout settings (watchdog, silence, idle, escalation, autoRecoverSeconds), repo roots, project definitions. Hot-reloaded by server.js via fs.watch |
| **package.json** | Project manifest with CommonJS scripts. Dependencies: express, ws, node-pty, @xterm/xterm, @xterm/addon-fit, @xterm/addon-webgl |
| **CLAUDE.md** | Hard constraints and design decisions for agents working in this codebase |


---

## Subdirectories

### `public/` — Browser Dashboard

| File | Purpose |
|------|---------|
| **index.html** | HTML shell. Loads xterm.js and app.js via ES modules. Contains session card container |
| **app.js** | Browser-side WebSocket client. Manages xterm.js Terminal instances per session. Handles control messages, input/resize, settings panel, repo scanner, session reordering. ~1158 lines |
| **style.css** | Dashboard styling: session cards, terminal containers, control panel, responsive layout. ~880 lines |

See `public/AGENTS.md` for detailed documentation of browser-side modules.

### `spike/` — Exploration & Testing

Throwaway scripts for testing and prototyping:
- `test-piped-stdio.js` — Testing Claude CLI with piped stdio (validates need for real PTY)
- `test-json-output.js` — Testing JSON output handling
- `test-stream-json.js` — Testing streaming JSON responses
- `test-permissions.js` — Testing file/directory permissions
- `test-interactive.js`, `test-interactive2.js`, `test-interactive3.js`, `test-interactive4.js` — Testing interactive mode prompt detection
- `run-all-tests.js` — Runner for all test scripts
- `run-remaining-tests.js` — Runner for failed tests
- `results.txt`, `results2.txt`, `interactive-results.txt`, `interactive-results2.txt` — Test output logs

See `spike/AGENTS.md` for detailed spike documentation.

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
  - `{ type: 'sessions-reordered', order: [sessionName, ...] }` — Session list reordered (broadcast)
  - `{ type: 'settings', requestId, settings }` — Settings response (unicast)
  - `{ type: 'settings-error', requestId, message }` — Settings error (unicast)
  - `{ type: 'settings-updated', settings }` — Settings broadcast (multicast)
  - `{ type: 'repo-roots-scanned', requestId, directories }` — Repo scan result (unicast)
  - `{ type: 'error', message }` — Generic error (unicast)
- **Client → Server:**
  - `{ type: 'kill', session }` — Terminate session
  - `{ type: 'restart', session }` — Restart session
  - `{ type: 'dismiss', session }` — Dismiss waiting state (return to RUNNING)
  - `{ type: 'add-session', name, path }` — Create new session
  - `{ type: 'remove-session', session }` — Delete session
  - `{ type: 'reorder-sessions', order: [sessionName, ...] }` — Reorder session list
  - `{ type: 'get-settings', requestId }` — Fetch current settings
  - `{ type: 'update-settings', requestId, settings }` — Modify settings
  - `{ type: 'scan-repo-roots', requestId }` — Scan configured repo roots

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

**States (from sessions.js STATES constant):**
- **INITIALIZING** — Session object created, env prepared, ready to spawn
- **STARTING** — PTY spawned, awaiting first output (watchdog_timeout = 30s by default)
- **RUNNING** — Claude CLI producing output, pattern detector active
- **WAITING** — Prompt detected (via PatternDetector), awaiting user input/skip/dismiss. Auto-recover available if ≥2 PTY data chunks arrive after N seconds
- **IDLE** — Silence timeout reached, no activity for N seconds
- **DONE** — Process exited cleanly (code 0)
- **FAILED** — Process exited with error or killed by user

**Transitions** governed by explicit event mapping (TRANSITIONS constant) and guards (GUARDS object).

**Auto-Recovery Transition:**
From WAITING state, if `autoRecoverSeconds` expires (default 3s) AND ≥2 data chunks arrive, transition WAITING → RUNNING via `auto_recover` event. Resets when exiting WAITING or on new prompt detection.

### Pattern Detection (3 Layers)

**Layer 1: Exact String Matches**
- `'Do you want to proceed?'`, `'Allow this action?'`, `'Press Enter to confirm'`, `'(y/n)'`, `'[yes/no]'`, etc.
- Checked first for high confidence

**Layer 2: Regex Patterns**
- Matches common prompt formats (e.g., patterns ending with `?` or containing `[yes/no]`)
- Fallback when exact match fails

**Layer 3: Silence Heuristic**
- If no output for N seconds, infer session is waiting for input or idle
- Differentiates between "user interacting" and "session paused"

All detection runs on ANSI-stripped PTY output (parallel stream, raw output untouched).

### Inter-Module Communication

Uses Node.js `EventEmitter`:
- **Session** emits: `'state-change'`, `'output'`, `'error'`, `'exit'`
- **PatternDetector** emits: `'prompt-detected'`, `'silence'`
- No global variables, no direct coupling

### Config Hot-Reload

`server.js` watches `config.json` with debounced read-modify-apply:
1. `fs.watch()` on config file
2. Debounce 500ms to coalesce rapid changes
3. Read fresh, validate, apply changes to sessionMap and timers

---

## Key Implementation Details

### Session Spawning (node-pty)

Must use **node-pty** (`pty.spawn()`) NOT `child_process.spawn()` because Claude CLI produces zero output when stdio is piped.

**Requirements:**
- Real PTY with `cols=80, rows=24` (xterm-256color)
- Unset env vars before spawn: `CLAUDECODE`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_ENTRYPOINT`
- Pass args as array, NOT `shell: true`

### Replay Buffer

Sessions maintain a ring buffer of PTY output for:
- Dashboard reconnections (resend recent output to new clients)
- Pattern re-detection after client reconnect
- Debugging/introspection

### Timers & Cleanup

Sessions use explicit setTimeout/setInterval with cleanup on state transitions:
- **watchdog_timeout** (STARTING → FAILED if no output within `startingWatchdogSeconds`)
- **silence_timeout** (RUNNING → IDLE after `attentionTimeoutSeconds` of no output)
- **escalation_timer** (WAITING state: repeated notifications every `waitingEscalationSeconds`)
- **auto_recover_timer** (WAITING state: triggers `auto_recover` → RUNNING if ≥2 data chunks arrive after `autoRecoverSeconds`)

All timers cleared on exit to prevent leaks.

---

## Hard Constraints (from CLAUDE.md)

**DO NOT introduce:**
- TypeScript
- React or any frontend framework
- Bundlers (Webpack, Vite, esbuild, etc.)
- Additional server frameworks (only express)
- ESM (`import`/`export`) in Node.js code
- XState or formal state machine libraries
- Global variables

**DO use:**
- CommonJS (`require`/`module.exports`)
- Node.js `EventEmitter` for inter-module communication
- Explicit state transitions with guards
- Plain JS (no frameworks, no abstractions)
- Error handling via EventEmitter `error` events, not thrown exceptions

---

## Platform & Runtime

- **OS:** Windows 11
- **Node:** v24+
- **Module System:** CommonJS only
- **Build Tools:** Visual Studio Build Tools (required for node-pty C++ module)

---

## Dependencies

| Package | Version | Usage |
|---------|---------|-------|
| `express` | ^4.18.2 | HTTP server, static file serving |
| `ws` | ^8.16.0 | WebSocket server (direct, no Socket.IO) |
| `node-pty` | ^1.1.0 | PTY spawning for Claude CLI |
| `@xterm/xterm` | ^6.0.0 | Terminal emulator (browser ES modules only) |
| `@xterm/addon-fit` | ^0.11.0 | Terminal resize (browser only) |
| `@xterm/addon-webgl` | ^0.19.0 | GPU-accelerated rendering (browser only) |

**Note:** `@xterm/*` packages are NOT required in Node.js — they load in the browser via ES modules.

---

## Testing & Validation

### Built-in Self-Test
```bash
node patterns.js
```
Runs PatternDetector self-test on hardcoded prompt examples.

### Spike Scripts
See `spike/AGENTS.md` for exploration and manual testing scripts.

### No Formal Test Framework
Project uses manual testing and spike scripts. No Jest, Mocha, or similar.

---

## Common Patterns & Anti-Patterns

### Good Patterns
- **EventEmitter for communication** — Session emits state changes, server subscribes
- **Explicit state machine** — TRANSITIONS map guards behavior, no implicit state
- **Config read-modify-write** — Fresh read, validate, write back
- **Timer cleanup** — Explicitly clear timers on state exit
- **ANSI stripping in parallel** — Keep raw PTY untouched, strip copy for pattern detection

### Anti-Patterns to Avoid
- Throwing exceptions in async error paths (use EventEmitter `error` events)
- Direct module coupling (use EventEmitter)
- Implicit state mutations (use explicit transitions)
- Global variables (use module scope + exports)
- Bundlers or transpilers (keep it plain Node.js)

---

## File Sizes (Lines of Code)

```
server.js      ~601 lines
sessions.js    ~455 lines
patterns.js    ~316 lines
notify.js       ~55 lines
public/app.js ~1158 lines
public/style.css ~880 lines
```

---

## Entry Points for Agents

| Task Type | Start Here | Key Files |
|-----------|-----------|-----------|
| Add session feature | `sessions.js` (Session class) | STATES, TRANSITIONS, GUARDS, entry/exit hooks |
| Add/remove/reorder sessions | `server.js` (handleControl) | add-session, remove-session, reorder-sessions messages |
| Add WebSocket message | `server.js` (handleControl, handleData) | Control/Data WS server setup |
| Improve prompt detection | `patterns.js` (PatternDetector) | EXACT_MATCHES, REGEX_PATTERNS, silence heuristic |
| Fix dashboard UI | `public/app.js` | xterm.js setup, session card rendering, drag-reorder |
| Add notification | `notify.js` (notify function) | BurntToast detection, msg fallback |
| Debug state transitions | `sessions.js` (transition guards) | GUARDS object, entry/exit hooks |
| Hot-reload config | `server.js` (config watcher) | fs.watch, debounce logic, apply changes |
| Tune auto-recovery | `sessions.js` (constructor, _handleAutoRecoverTimer) | autoRecoverSeconds param, data chunk counting |

---

## Next Steps for New Agents

1. **Read CLAUDE.md** — Understand hard constraints and design philosophy
2. **Review the state machine** in `sessions.js` (STATES, TRANSITIONS, GUARDS)
3. **Understand dual WebSocket architecture** — Control WS for JSON, Data WS for raw PTY bytes
4. **Use EventEmitter** for inter-module communication
5. **Keep it plain Node.js** — No TS, no frameworks, no bundlers
6. **Test thoroughly** — Use spike scripts for exploration, run `node patterns.js` for pattern testing

---

## Related Documentation

- `CLAUDE.md` — Project constraints and coding style
- `public/AGENTS.md` — Browser-side module documentation
- `spike/AGENTS.md` — Exploration and testing script documentation
