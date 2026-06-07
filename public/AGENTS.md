<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-11 | Updated: 2026-05-30 -->

# public/ - Browser Dashboard

## Purpose

Browser-side dashboard for Glissa. Provides real-time terminal streaming via xterm.js, session state tracking, theming, and interactive controls. Modular ES module architecture, no framework, no build step required (Vite optional for dev HMR + Tailwind).

## Key Files

| File | Description |
|------|-------------|
| `index.html` | Dashboard HTML shell with inline critical CSS (loading screen, shutdown overlay), Tailwind utility classes for layout |
| `app.js` | Boot entry point - wires modules together, applies saved theme, control message dispatch, window resize handler, toolbar/menu event binding, focus tracking |
| `session-card/` | Session card modules - decomposed from the former `session-card.js` god-module. See table below for the focused sub-modules. `app.js` and `dialogs.js` import directly from the owning module (no barrel). |
| `control-ws.js` | Control WebSocket client - connection management, auto-reconnect (3s), request/response with requestId correlation and 5s timeout |
| `dialogs.js` | Add Session and Settings dialog factories - repo root scanning, project picker, validation, theme picker, sound selector |
| `theme.js` | Theme system - defines color palettes (Golgari, Midnight, Phyrexian, Compleated), applies CSS custom properties on `:root`, derives xterm.js terminal themes from CSS variables |
| `ui-prefs.js` | UI preference persistence (localStorage) - sound enabled/id, theme id, notifications enabled |
| `alert-sound.js` | Notification sounds - audio file playback (.ogg) with synth beep fallback via Web Audio API |
| `notifications.js` | Desktop notifications via the browser Notifications API. Handles `notify` control messages (raises a native Notification routed to the Windows Action Center), permission flow, and the `notificationsEnabled` pref. Replaces the server-side BurntToast toast path |
| `local-store.js` | Generic localStorage wrapper - JSON get/set with graceful degradation for private browsing |
| `dom-helpers.js` | Shared `el(tag, className, text)` and `escapeHtml()` helpers for programmatic DOM creation |
| `health-monitor.js` | Footer panel rendering memory + leak telemetry from server `health-snapshot` messages - compact summary, click to expand into a detailed panel |
| `tailwind.css` | Tailwind CSS entry with `@theme` block - color tokens reference CSS variables set by `theme.js` |
| `style.css` | Component styles for JS-created DOM elements, `[data-state]` attribute selectors, animations (`@keyframes`), dialog/toast styling |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `components/` | HTML dialog template fragments loaded via Vite `?raw` imports (see `components/AGENTS.md`) |
| `audio/` | Alert sound audio files (`.ogg`) served as static assets |
| `session-card/` | Focused ES modules decomposed from the former `session-card.js` god-module (see below) |

### session-card/ modules

The former `session-card.js` (~1600 lines) was decomposed into cohesion-sized modules. `app.js` and `dialogs.js` import directly from the owning module - there is no barrel re-exporter.

| Module | Exports / purpose |
|--------|-------------------|
| `card-registry.js` | `sessionUIs` Map, 2 DOM singletons (`container`, `aggregateEl`) |
| `toast.js` | `showErrorToast` - leaf, depends only on `dom-helpers.js` |
| `naming.js` + `naming-core.mjs` | `countSessionsByName`, `suggestSessionName`; pure name-sequence logic in `.mjs` |
| `webgl-pool.js` + `webgl-core.mjs` | `tryLoadWebGL`, `releaseWebgl`; LRU eviction policy in pure `.mjs` |
| `card-dom.js` | `buildCardDOM`, `makeBadge`, inline confirm dialog, inline rename, debug overlay, `handleDebugState*` |
| `terminal.js` | `setupTerminal`, `wireTerminalIO`, `ensureTerminalSetup`, `reconnectDataWs`, OSC-52 clipboard, terminal-settings setters |
| `session-tick.js` | Shared 1s tick (top-level side effect): advances each card's elapsed clock + polls the working-heartbeat quiet flag; exports `refreshElapsed` |
| `lifecycle.js` | `createSessionCard`, `removeSessionCard`, `applyState`, `applyTerminalSettings`, `updateAggregateStatus`, etc. - the integration layer |
| `aggregate-core.mjs` | Pure: `computeAggregate(counts)` (used by lifecycle) |

## For AI Agents

### Working In This Directory

This is **browser code** using ES modules, not CommonJS.

**Key differences from server-side code:**
- Use `import`/`export`, not `require()`
- DOM APIs: `document`, `querySelector`, `createElement`, `addEventListener`
- WebSocket via native browser `WebSocket` API (not `ws` package)
- Shared states imported from `/shared/states.mjs` (Vite alias -> `shared/states.esm.js`)

### Module Architecture

```
app.js (boot)
  ├── theme.js           (theme system - applied at boot before UI renders)
  ├── control-ws.js      (control WebSocket - singleton)
  ├── session-card/lifecycle.js  (card lifecycle - the integration layer)
  │     ├── session-card/session-tick.js (1s tick: elapsed + heartbeat, top-level side effect)
  │     ├── session-card/card-dom.js    (card builder, debug overlay)
  │     ├── session-card/terminal.js    (xterm.js, data WebSocket)
  │     ├── session-card/card-registry.js  (sessionUIs Map, DOM singletons)
  │     ├── ui-prefs.js      (localStorage persistence)
  │     ├── alert-sound.js   (notification sounds)
  │     ├── dom-helpers.js
  │     └── /shared/states.mjs (state constants)
  ├── dialogs.js         (dialogs - imports naming helpers from session-card/naming.js)
  │     ├── alert-sound.js   (sound preview in settings)
  │     ├── ui-prefs.js
  │     └── components/*.html?raw (template fragments)
  └── health-monitor.js  (footer telemetry panel - depends on dom-helpers.js, control-ws.js)
```

- `local-store.js` and `dom-helpers.js` are leaf utilities (no local imports)
- `theme.js` is self-contained - defines themes, applies CSS variables, derives terminal colors
- `ui-prefs.js` depends only on `local-store.js`
- `control-ws.js` is the lowest-level network module (no imports from other local modules)
- `session-card/card-registry.js` is the deepest dependency in the session-card graph - ESM evaluates it first so the DOM singletons resolve before any card is created
- `dialogs.js` imports `countSessionsByName`/`suggestSessionName` from `session-card/naming.js` (not from a barrel)
- `app.js` imports from all major modules and wires them together

### Theme System

Colors are driven by CSS custom properties on `:root`, set by `theme.js`:
- `applyTheme(id)` sets `--bg`, `--text`, `--accent`, etc. on `document.documentElement`
- `getTerminalTheme()` builds an xterm.js theme object, resolving `--var` references via `getComputedStyle`
- Tailwind tokens in `tailwind.css` reference the same CSS variables (`--color-bg: var(--bg)`)
- Available themes: `golgari` (green/black), `midnight` (blue/purple), `phyrexian` (iridescent), `compleated` (light)
- Theme preference stored in localStorage via `ui-prefs.js`

### CSS Convention

- **Tailwind utility classes** for static HTML markup in `index.html`
- **Semantic classes** in `style.css` for JS-created DOM elements (`session-card.js`, `dialogs.js`)
- **State-driven styles** via `[data-state]` attribute selectors in `style.css`
- **Theme colors** via CSS custom properties set by `theme.js`, referenced by both `style.css` and `tailwind.css`

### Dual WebSocket Architecture

Two WebSocket connections per browser session:

**1. Control WebSocket** (`/control`) - managed by `control-ws.js`
- Single shared connection for all JSON control messages
- Request/response pattern via `requestId` correlation
- Auto-reconnect every 3s on disconnect (disabled during shutdown)

**2. Data WebSocket** (`/terminals/:sessionName`) - managed by `session-card.js`
- One per session per client, raw PTY byte streaming
- Writes server bytes to `term.write()`, reads keyboard via `term.onData()`
- Auto-reconnect every 3s on close

### State Management

**`sessionUIs` Map** (in `session-card.js`): Central UI state store - one entry per session card containing xterm Terminal, FitAddon, WebglAddon, data WebSocket, DOM elements, and current state.

**Server is source of truth.** UI state is transient - rebuilt from snapshots on reconnect.

### State Badges & Visibility

States drive UI via `[data-state]` CSS selectors:
- **INITIALIZING** - Gray badge
- **STARTING** - Pink badge
- **RUNNING** - Green border, Restart visible (force-restart)
- **WAITING** - Amber pulsing border, Restart visible, click terminal to dismiss
- **IDLE** - Yellow badge
- **COMPLETE** - Green badge, completion flash animation, sound alert
- **DONE** - Cyan border, Restart visible, terminal shows "Session complete"
- **FAILED** - Red border, Restart visible, terminal shows "Session failed"

### Testing Requirements

**Manual browser testing only.** No automated tests.

Verification checklist:
1. Dashboard loads (loading screen -> app reveal on WS connect)
2. Session cards render with correct state badges
3. Terminal displays output, keyboard input works (Ctrl+C copies selection, Ctrl+V pastes)
4. Focus rail lists all sessions; the pill heartbeat breathes on a RUNNING session and goes quiet on silence
5. Clicking a rail pill focuses that session into the center; a dormant pill starts the session
6. Add Session dialog: picker populates from repo roots, manual entry via Advanced
7. Settings dialog: loads current values, validates, saves, theme preview works
8. Menu: shutdown and restart work with confirmation
9. Reconnection: auto-reconnects on disconnect, reloads on restart
10. Theme switching applies immediately, persists across reload

### Common Patterns

**Programmatic DOM creation** - All session cards, dialogs, and toasts built via `document.createElement()`. Shared `el()` helper in `dom-helpers.js`.

**Request-response pattern** (control-ws.js):
```javascript
const response = await sendControlRequest('get-settings', {});
```

**State application** (session-card.js):
```javascript
applyState(sessionName, newState); // updates badge, card, buttons
updateAggregateStatus();           // updates header count and document title
```

### Dependencies

#### External (Loaded in Browser via Vite)
- `@xterm/xterm` - Terminal emulator library
- `@xterm/addon-fit` - Auto-fit terminal to container
- `@xterm/addon-webgl` - GPU acceleration (graceful canvas fallback)

#### Internal
- `/shared/states.mjs` -> `shared/states.esm.js` (via Vite alias or Express dev route)

---

## Key Design Decisions

### Why Modular ES Modules, Not a Single app.js?
Code was refactored from a monolithic `app.js` into focused modules: `control-ws.js` (connection), `session-card.js` (UI), `dialogs.js` (modals), `theme.js` (colors), etc. Each module owns its state and exports a clean API.

### Why Two WebSocket Connections?
- **Control WS:** Multiplexes all control messages over one stable connection
- **Data WS:** Dedicated per-session PTY I/O, direct byte streaming with zero serialization overhead

### Why CSS Variables for Theming?
Themes set CSS custom properties on `:root` so both Tailwind utilities and semantic CSS classes resolve to the active palette without rebuilding CSS. Terminal colors are derived at runtime via `getComputedStyle`.

### Why xterm.js?
Industry standard terminal emulator. Handles ANSI rendering, keyboard events, and graceful WebGL -> canvas degradation. No need to reinvent terminal emulation.

### Why No Terminal History in Server?
xterm.js scrollback buffer (hardcoded to 50000 lines) handles history on the client. Server maintains ~100KB replay buffer only for late-joining clients.

<!-- MANUAL: -->
