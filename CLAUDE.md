# Glissa — Agent Instructions

## Project Purpose

Glissa is a lightweight Node.js background process that spawns and manages Claude Code sessions, streams output to a browser dashboard via WebSocket, and alerts via Windows toast notifications.

## File Structure

```
server.js          # Production entry point (thin wrapper)
backend.js         # Express + WebSocket server factory (shared by server.js and Vite plugin)
sessions.js        # Session lifecycle and state machine
notify.js          # Windows toast notifications
vite.config.js     # Vite frontend build config + backend plugin (ESM)
public/
  index.html       # Dashboard shell (Tailwind utility classes)
  app.js           # Browser-side entry point (ES module)
  tailwind.css     # Tailwind CSS entry (theme + imports)
  style.css        # Component styles, state-driven rules, animations
  session-card.js  # Session card DOM lifecycle and terminal setup
  control-ws.js    # WebSocket control channel client
  dialogs.js       # Add Session and Settings dialog factories
shared/
  states.js        # Session states (CJS, server-side)
  states.esm.js    # Session states (ESM, browser-side via Vite)
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
- **Semantic classes** in `style.css` for JS-created DOM elements (`session-card.js`, `dialogs.js`)
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

### Session Spawning (node-pty)

Sessions spawn `claude` via `pty.spawn()` from node-pty (NOT `child_process.spawn`).

- Claude CLI produces zero output with piped stdio — a real PTY is required.
- Must unset env vars before spawn: `CLAUDECODE`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_ENTRYPOINT`
- Do NOT use `shell: true` — pass args as array
- Terminal name: `xterm-256color`, default 80x24
- `dangerouslySkipPermissions` flag spawns Claude with `--dangerously-skip-permissions`

### Security: Trust Boundary

Glissa binds to `localhost` only. Both WebSocket channels (data and control) have **no authentication** — any process on the local machine can connect. This is acceptable for a single-user dev tool but means:

- Do NOT expose Glissa's port to the network (no `0.0.0.0` binding)
- The `dangerouslySkipPermissions` option is settable via the control WebSocket; any local process can create a permissionless session
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
- Pattern detection uses ANSI-stripped tap of PTY output (parallel to raw stream)

### WebSocket Transport

Use the `ws` package directly. Do NOT use Socket.IO or any abstraction over WebSockets.

## Coding Style

- CommonJS only: `const x = require('x')`, `module.exports = { ... }`
- No classes unless the pattern genuinely requires instance state
- Prefer explicit over clever
- Error handling: propagate errors via EventEmitter `error` events or callbacks, not thrown exceptions in async paths
- Keep functions small and single-purpose
