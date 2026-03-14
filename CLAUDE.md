# Glissa — Agent Instructions

## Project Purpose

Glissa is a lightweight Node.js background process that spawns and manages Claude Code sessions, streams output to a browser dashboard via WebSocket, and alerts via Windows toast notifications.

## File Structure

```
server.js          # Express + WebSocket server, entry point
sessions.js        # Session lifecycle and state machine
notify.js          # Windows toast notifications
public/
  index.html       # Dashboard shell
  app.js           # Browser-side WebSocket client and UI logic
  style.css        # Dashboard styles
config.json        # Runtime configuration
```

## Platform and Runtime

- **OS:** Windows 11
- **Node:** v24+
- **Module system:** CommonJS (`require` / `module.exports`) — no ESM

## Production Dependencies

- `express` — HTTP server and static file serving
- `ws` — WebSocket server
- `node-pty` — Pseudo-terminal for spawning Claude Code with real PTY support
- `@xterm/xterm` — Terminal emulator (loaded in browser via ES modules, not in Node.js)
- `@xterm/addon-fit` — xterm.js addon for fitting terminal to container (browser only)
- `@xterm/addon-webgl` — xterm.js addon for WebGL rendering (browser only)

**Notes:**
- `node-pty` requires C++ build tools (Visual Studio Build Tools on Windows)
- `@xterm/*` packages are loaded in the browser via ES modules, not in Node.js

Do NOT add dependencies without explicit instruction.

## Hard Constraints

**Do NOT introduce:**
- TypeScript
- React or any frontend framework
- Bundlers (Webpack, Vite, esbuild, etc.)
- Additional server frameworks or libraries
- ESM (`import`/`export`)
- XState or any state machine library

This is plain Node.js. Keep it that way.

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

### Session Spawning (node-pty)
Sessions spawn `claude` via `pty.spawn()` from node-pty (NOT `child_process.spawn`).
- Claude CLI produces zero output with piped stdio — a real PTY is required.
- Must unset env vars before spawn: `CLAUDECODE`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_ENTRYPOINT`
- Do NOT use `shell: true` — pass args as array
- Terminal name: `xterm-256color`, default 80x24

### Dual WebSocket Architecture
- **Data WebSocket** (`/terminals/:sessionName`): Raw PTY bytes bidirectional. One per session per client.
- **Control WebSocket** (`/control`): JSON messages for state-change, snapshot, kill, restart.
- xterm.js in the browser connects to data WebSocket; control panel uses control WebSocket.

### Dashboard Rendering (xterm.js)
- Each session card contains an xterm.js Terminal instance
- xterm.js handles ALL ANSI rendering — server is a dumb pipe
- `@xterm/addon-fit` for resize, `@xterm/addon-webgl` for GPU rendering
- Browser loads @xterm/* via ES modules (`<script type="module">`)
- Pattern detection uses ANSI-stripped tap of PTY output (parallel to raw stream)

### WebSocket Transport
Use the `ws` package directly. Do NOT use Socket.IO or any abstraction over WebSockets.

## Coding Style

- CommonJS only: `const x = require('x')`, `module.exports = { ... }`
- No classes unless the pattern genuinely requires instance state
- Prefer explicit over clever
- Error handling: propagate errors via EventEmitter `error` events or callbacks, not thrown exceptions in async paths
- Keep functions small and single-purpose
