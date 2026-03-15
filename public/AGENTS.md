<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-11 | Updated: 2026-03-15 -->

# public/ — Browser Dashboard

## Purpose

Browser-side dashboard for Glissa. Provides real-time terminal streaming via xterm.js, session state tracking, drag-and-drop reordering, and interactive controls. Modular ES module architecture — no framework, no build step required (Vite optional for dev HMR + Tailwind).

## Key Files

| File | Description |
|------|-------------|
| `index.html` | Dashboard HTML shell with inline critical CSS (loading screen, shutdown overlay), Tailwind utility classes for layout |
| `app.js` | Boot entry point — wires modules together, control message dispatch, window resize handler, toolbar/menu event binding |
| `session-card.js` | Session card DOM lifecycle: card creation, terminal setup (xterm.js + WebGL), data WebSocket per session, drag-and-drop, minimize toggle, state application, audit log, idle counter |
| `control-ws.js` | Control WebSocket client — connection management, auto-reconnect (3s), request/response with requestId correlation and 5s timeout |
| `dialogs.js` | Add Session and Settings dialog factories — programmatic DOM creation, repo root scanning, validation |
| `tailwind.css` | Tailwind CSS entry with `@theme` block defining colors, fonts, radii |
| `style.css` | Component styles for JS-created DOM elements, `[data-state]` attribute selectors, animations (`@keyframes`), dialog/toast styling |

## For AI Agents

### Working In This Directory

This is **browser code** using ES modules, not CommonJS.

**Key differences from server-side code:**
- Use `import`/`export`, not `require()`
- DOM APIs: `document`, `querySelector`, `createElement`, `addEventListener`
- WebSocket via native browser `WebSocket` API (not `ws` package)
- Shared states imported from `/shared/states.mjs` (Vite alias → `shared/states.esm.js`)

### Module Architecture

```
app.js (boot)
  ├── control-ws.js    (control WebSocket — singleton)
  ├── session-card.js  (card lifecycle — depends on control-ws.js)
  │     └── /shared/states.mjs (state constants)
  └── dialogs.js       (dialogs — depends on session-card.js + control-ws.js)
```

- `control-ws.js` is the lowest-level module (no imports from other local modules)
- `session-card.js` imports from `control-ws.js` for `sendControlMsg`
- `dialogs.js` imports from both `control-ws.js` and `session-card.js`
- `app.js` imports from all three and wires them together

### CSS Convention

- **Tailwind utility classes** for static HTML markup in `index.html`
- **Semantic classes** in `style.css` for JS-created DOM elements (`session-card.js`, `dialogs.js`)
- **State-driven styles** via `[data-state]` attribute selectors in `style.css`
- Theme colors defined in `tailwind.css` via `@theme` block

### Dual WebSocket Architecture

Two WebSocket connections per browser session:

**1. Control WebSocket** (`/control`) — managed by `control-ws.js`
- Single shared connection for all JSON control messages
- Request/response pattern via `requestId` correlation
- Auto-reconnect every 3s on disconnect (disabled during shutdown)

**2. Data WebSocket** (`/terminals/:sessionName`) — managed by `session-card.js`
- One per session per client, raw PTY byte streaming
- Writes server bytes to `term.write()`, reads keyboard via `term.onData()`
- Auto-reconnect every 3s on close

### State Management

**`sessionUIs` Map** (in `session-card.js`): Central UI state store — one entry per session card containing xterm Terminal, FitAddon, WebglAddon, data WebSocket, DOM elements, audit log, and current state.

**Server is source of truth.** UI state is transient — rebuilt from snapshots on reconnect.

### State Badges & Visibility

States drive UI via `[data-state]` CSS selectors:
- **INITIALIZING** — Gray badge
- **STARTING** — Purple badge
- **RUNNING** — Green border, Kill visible
- **WAITING** — Amber pulsing border, Dismiss + Restart visible
- **IDLE** — Yellow badge, idle counter active
- **DONE** — Blue border, Restart visible, terminal shows "Session complete"
- **FAILED** — Red border, Restart visible, terminal shows "Session failed"

### Testing Requirements

**Manual browser testing only.** No automated tests.

Verification checklist:
1. Dashboard loads (loading screen → app reveal on WS connect)
2. Session cards render with correct state badges
3. Terminal displays output, keyboard input works
4. Drag-and-drop reordering persists
5. Minimize/expand toggle works (WebGL reloads on expand)
6. Audit log expands/collapses, terminal refits
7. Add Session dialog: picker populates from repo roots, manual entry works
8. Settings dialog: loads current values, validates, saves
9. Menu: shutdown and restart work with confirmation
10. Reconnection: auto-reconnects on disconnect, reloads on restart

### Common Patterns

**Programmatic DOM creation** — All session cards, dialogs, and toasts built via `document.createElement()`. No templates, no innerHTML for content (except dialog form markup in `dialogs.js`).

**`el()` helper** (session-card.js):
```javascript
function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}
```

**Request-response pattern** (control-ws.js):
```javascript
const response = await sendControlRequest('get-settings', {});
```

**State application** (session-card.js):
```javascript
applyState(sessionName, newState); // updates badge, card, buttons, idle counter
updateAggregateStatus();           // updates header count and document title
```

### Dependencies

#### External (Loaded in Browser via Vite)
- `@xterm/xterm` — Terminal emulator library
- `@xterm/addon-fit` — Auto-fit terminal to container
- `@xterm/addon-webgl` — GPU acceleration (graceful canvas fallback)

#### Internal
- `/shared/states.mjs` → `shared/states.esm.js` (via Vite alias or Express dev route)

---

## Key Design Decisions

### Why Modular ES Modules, Not a Single app.js?
Code was refactored from a monolithic `app.js` into focused modules: `control-ws.js` (connection), `session-card.js` (UI), `dialogs.js` (modals). Each module owns its state and exports a clean API.

### Why Two WebSocket Connections?
- **Control WS:** Multiplexes all control messages over one stable connection
- **Data WS:** Dedicated per-session PTY I/O, direct byte streaming with zero serialization overhead

### Why xterm.js?
Industry standard terminal emulator. Handles ANSI rendering, keyboard events, and graceful WebGL → canvas degradation. No need to reinvent terminal emulation.

### Why No Terminal History in Server?
xterm.js scrollback buffer (5000 lines) handles history on the client. Server maintains ~100KB replay buffer only for late-joining clients.

<!-- MANUAL: -->
