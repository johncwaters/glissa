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

That is the complete list. Do NOT add dependencies without explicit instruction.

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

### WebSocket Transport
Use the `ws` package directly. Do NOT use Socket.IO or any abstraction over WebSockets.

## Coding Style

- CommonJS only: `const x = require('x')`, `module.exports = { ... }`
- No classes unless the pattern genuinely requires instance state
- Prefer explicit over clever
- Error handling: propagate errors via EventEmitter `error` events or callbacks, not thrown exceptions in async paths
- Keep functions small and single-purpose
