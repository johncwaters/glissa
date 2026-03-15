<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-11 -->

# Glissa Public Directory — Agent Guide

## Overview

This directory contains the browser-side dashboard for Glissa, a Claude Code session manager. The dashboard provides real-time terminal streaming, session state tracking, and interactive controls via a WebSocket-based architecture.

**Files:**
- `index.html` — Dashboard HTML shell (~30 lines)
- `app.js` — Browser-side logic: WebSocket client, DOM manipulation, xterm.js integration (~1158 lines)
- `style.css` — Dark theme styling (~881 lines)

**Key characteristic:** No build step, no framework, no bundler. Plain ES modules in the browser, vanilla DOM manipulation, xterm.js for terminal rendering.

---

## Architecture

### Module System

- **Browser:** ES modules (`import`/`export`)
- **HTML:** `<script type="module">` entry point
- **Imports:** xterm packages from `/xterm/*.mjs` routes (served by Express from node_modules)

### Dual WebSocket Architecture

Two WebSocket connections per browser session:

#### 1. Control WebSocket (`/control`)

- **Flow:** Request-response via JSON messages
- **Lifetime:** Single, shared across all session cards
- **Messages:**
  - `{ type: 'snapshot' }` → Get full server state (all sessions, their states, audit logs)
  - `{ type: 'kill', session: string }` → Kill a running session
  - `{ type: 'restart', session: string }` → Restart a completed/failed session
  - `{ type: 'remove-session', session: string }` → Delete session (with confirmation)
  - `{ type: 'settings', ... }` → Update dashboard settings
  - `{ type: 'add-session', projectPath: string, ... }` → Spawn new session
- **Response pattern:** `{ requestId, ... }` — correlation via `requestId` field
- **Auto-reconnect:** Every 3 seconds if disconnected

**Implementation:** `connectControlWs()`, `sendControlRequest()`, `pendingRequests` Map

#### 2. Data WebSocket (`/terminals/:sessionName`)

- **Flow:** Bidirectional raw bytes
- **Lifetime:** One per session per client
- **Direction:**
  - Server → Browser: PTY output (ANSI bytes)
  - Browser → Server: User keyboard input
- **xterm.js integration:** Directly writes server bytes to terminal
- **Auto-connect:** When session card is created
- **Auto-reconnect:** 3-second retry delay if lost

**Implementation:** `connectDataWs(sessionName, ui, term)`, per-session WebSocket in `sessionUIs` Map

### State Management

**`sessionUIs` Map:** Central UI state store
```javascript
Map<sessionName, {
  term,              // xterm.js Terminal instance
  fitAddon,          // FitAddon for resize-to-fit
  webglAddon,        // WebglAddon for GPU acceleration (or null)
  needsWebGLReload,  // Boolean flag set on context loss or DOM move
  dataWs,            // WebSocket for terminal I/O
  card,              // DOM element for session card
  badge,             // DOM span for state badge
  btnKill,           // Kill button
  btnDismiss,        // Dismiss button (visible in WAITING state)
  btnRestart,        // Restart button
  btnMinimize,       // Min/Max button for minimize/maximize toggle
  idleLabel,         // Idle duration text
  auditLog,          // Array of audit entries
  auditContainer,    // DOM element for timeline
  auditToggle,       // DOM element for toggle
  idleStart,         // Timestamp when IDLE started (null if not idle)
  idleInterval,      // setInterval ID for idle timer
  currentState       // String: INITIALIZING|STARTING|RUNNING|WAITING|IDLE|DONE|FAILED
}>
```

**Server is source of truth.** UI state is transient — rebuilt on every snapshot.

### State Badges & Visibility

States drive UI appearance:
- **INITIALIZING** → Gray badge, both Kill/Restart hidden
- **STARTING** → Purple badge, both hidden
- **RUNNING** → Green badge, Kill visible
- **WAITING** → Amber badge with pulsing animation, Kill visible
- **IDLE** → Yellow badge, Kill visible, idle counter active
- **DONE** → Blue badge, Restart visible
- **FAILED** → Red badge, Restart visible

Visibility controlled via `applyState(ui, state)` function.

### Terminal Rendering

- **xterm.js** handles 100% of ANSI rendering and interaction
- **Server role:** Dumb pipe — forwards raw PTY bytes unchanged
- **Client role:** Writes bytes to terminal, reads keyboard input
- **Addons:**
  - `FitAddon` — Resizes terminal to container on open and when audit toggle expands/collapses
  - `WebglAddon` — GPU acceleration (graceful canvas fallback if unavailable)

---

## File Reference

### index.html

**Purpose:** Static HTML shell, loads stylesheets and app.js module.

**Structure:**
```html
<header>
  <h1>Glissa</h1>
  <div class="header-right">
    <button id="btn-settings">Settings</button>
    <button id="btn-add-session">+ Add Session</button>
    <span id="aggregate-status"></span>      <!-- Running/waiting/done count -->
    <span id="connection-status"></span>    <!-- Control WS connection indicator -->
  </div>
</header>
<main id="sessions-container">
  <!-- Session cards injected by app.js -->
</main>
<script type="module" src="/app.js"></script>
```

**Element IDs** (referenced by app.js):
- `btn-settings` — Settings button
- `btn-add-session` — Add session button
- `aggregate-status` — Aggregate status text
- `connection-status` — WebSocket connection indicator
- `sessions-container` — Parent container for session cards

### app.js

**Purpose:** Complete browser-side application logic.

**Lines:** ~1158

**Key Functions:**

#### Initialization
- `main()` — Entry point, connects control WS, requests snapshot
- `connectControlWs()` — Establishes control WebSocket, sets up message handlers
- `requestSnapshot()` — Sends snapshot request, rebuilds entire session UI

#### State & UI Updates
- `applySnapshot(snapshot)` — Processes server state, creates/updates/removes session cards
- `applyState(ui, state)` — Updates card styling, badges, button visibility for a session
- `updateAggregateStatus()` — Updates header status text and document title
- `updateButtonVisibility(ui)` — Shows/hides Kill/Restart based on current state
- `updateIdleCounter(ui, isActive)` — Starts/stops idle duration timer

#### Session Card Creation
- `createSessionCard(sessionName, initialState, auditLog)` — Creates DOM structure for one session
- `makeBadge(state)` — Creates a state badge span element

#### Data WebSocket (per-session I/O)
- `connectDataWs(sessionName, ui, term)` — Establishes per-session data WS for terminal I/O
- Writes server bytes to `term.write()`
- Reads from `term.onData(data => ws.send(data))` for keyboard input
- Auto-reconnects on close

#### Control Messages
- `sendControlRequest(msg)` → Promise — Sends JSON message, waits for `requestId` response
- Button click handlers send `kill`, `restart`, `remove-session` messages
- Settings dialog sends `settings` update
- Add-session dialog sends `add-session` request

#### Audit Log
- `appendAuditEntry(ui, entry)` — Adds timestamped event to session's audit timeline
- Events: state changes, process exit, errors
- Toggle expands/collapses timeline, triggers terminal refit

#### Dialogs
- `showAddSessionDialog()` — Modal overlay with project path input
- `showSettingsDialog()` — Modal overlay with configuration options
- Programmatically created DOM, not pre-existing templates

#### Formatting Helpers
- `formatTime(timestamp)` — HH:MM:SS format
- `formatIdleDuration(ms)` — "Xm Ys" or "Ys" format

**Constants:**
- `RECONNECT_DELAY_MS = 3000` — Control WS retry interval
- `TERM_THEME` — xterm.js color scheme (dark blue/purple palette)
- `BADGE_LABELS` — Human-readable state labels
- `KILLABLE_STATES` — States where Kill button is visible
- `RESTARTABLE_STATES` — States where Restart button is visible

**Global State:**
- `sessionUIs` Map — Central UI state
- `controlWs` — Shared control WebSocket
- `controlRetryTimer` — Retry timer ID
- `pendingRequests` Map — Correlation ID → response Promise

### style.css

**Purpose:** Dashboard styling, dark theme, responsive layout.

**Lines:** ~881

**CSS Custom Properties** (root):
- `--bg`, `--bg-card`, `--bg-header`, `--bg-surface` — Background colors
- `--border`, `--border-dim`, `--border-hover` — Border colors
- `--text`, `--text-dim`, `--text-head`, `--text-muted` — Text colors
- `--accent`, `--accent-dim` — Blue accent
- `--state-*` — State-specific colors (running, waiting, failed, done, idle, etc.)
- `--radius`, `--radius-lg` — Border radius
- `--font-mono`, `--font-ui` — Font families
- `--transition-fast`, `--transition-med` — Animation durations

**Key Classes:**

*Layout:*
- `.header` — Top bar
- `.sessions` — Main container, CSS grid
- `.session-card` — Individual session container
- `.terminal-wrap` — Terminal container (400px height)

*State-driven styling:*
- `[data-state="WAITING"]` — Pulsing amber border
- `[data-state="RUNNING"]` — Green border
- `[data-state="DONE"]` — Blue border
- `[data-state="FAILED"]` — Red border

*Components:*
- `.state-badge` — Status label with state color
- `.session-actions` — Kill/Restart/Remove buttons
- `.audit-timeline` — Collapsible event log
- `.audit-toggle` — Expand/collapse arrow
- `.btn-action` — Action buttons (kill, restart, remove)

*Dialogs:*
- `.dialog-overlay` — Full-screen modal backdrop
- `.dialog` — Modal box
- `.dialog-header`, `.dialog-body`, `.dialog-footer` — Sections

*Toasts:*
- `.toast` — Error notification (bottom right)

**Responsive Design:**
- Grid layout scales from 1 to 3 columns
- Terminal container adapts to available width
- Header wraps on narrow screens

---

## For AI Agents

### Working in This Directory

This is **browser code** using ES modules, not CommonJS.

**Key differences from `../server.js`:**
- Use `import`/`export`, not `require()`
- DOM APIs: `document`, `querySelector`, `createElement`, `addEventListener`
- WebSocket via native browser `WebSocket` API (not `ws` package)
- xterm.js is a browser library, loaded via `<script type="module">`

**File paths:**
- xterm CSS: `/xterm/xterm.css` (served from node_modules by Express)
- xterm JS modules: `/xterm/xterm.mjs`, `/xterm/addon-fit.mjs`, `/xterm/addon-webgl.mjs`
- Dashboard CSS: `/style.css`
- App JS: `/app.js`

### Testing Requirements

**Manual browser testing only.** No automated tests for this directory.

**Verification checklist:**
1. Open browser to `http://localhost:3000`
2. Check: Session cards render with correct state badges
3. Check: WebSocket connects (connection indicator shows "Connected")
4. Check: Kill/Restart buttons appear/disappear based on state
5. Check: Terminal displays output (if session is running)
6. Check: Keyboard input works in terminal
7. Check: Audit log expands/collapses with toggle
8. Check: Dialogs open and close
9. Check: Settings are persisted
10. Check: Aggregate status updates as sessions change state

### Common Patterns

#### Request-Response Pattern (Control WS)
```javascript
const response = await sendControlRequest({
  type: 'kill',
  session: sessionName
});
// response.success === true/false
```

#### Per-Session Data WebSocket
```javascript
function connectDataWs(sessionName, ui, term) {
  const ws = new WebSocket(`ws://localhost:3000/terminals/${sessionName}`);
  ws.onmessage = (ev) => term.write(ev.data);
  term.onData(data => ws.send(data));
  // ... reconnect on close
}
```

#### Updating UI After State Change
```javascript
applyState(ui, newState);
updateAggregateStatus();
```

#### Adding Audit Entry
```javascript
appendAuditEntry(ui, {
  timestamp: Date.now(),
  event: 'state_change',
  data: { from: 'RUNNING', to: 'IDLE' }
});
```

### DOM Manipulation Strategy

**All DOM is created programmatically** in `createSessionCard()`. No templates, no innerHTML for content.

Use `document.createElement()` to build structure, then `addEventListener()` to wire up interactions.

Example:
```javascript
const card = document.createElement('div');
card.className = 'session-card';
const btn = document.createElement('button');
btn.addEventListener('click', () => { /* ... */ });
card.appendChild(btn);
container.appendChild(card);
```

### Common Tasks

#### Add a new session
1. User clicks "+ Add Session"
2. Modal dialog collects project path
3. Send `{ type: 'add-session', projectPath }` via control WS
4. Server spawns session, broadcasts snapshot
5. Browser receives snapshot, creates new card via `applySnapshot()`

#### Kill a running session
1. User clicks Kill button
2. Send `{ type: 'kill', session: sessionName }` via control WS
3. Server kills process, updates state to DONE/FAILED, broadcasts snapshot
4. Browser receives snapshot, updates card state badge and button visibility

#### Display terminal output
1. Data WS receives PTY bytes from server
2. Write to xterm.js: `term.write(bytes)`
3. xterm.js renders ANSI sequences, updates DOM

#### Collapse audit timeline
1. User clicks toggle
2. Add/remove `open` class on `auditContainer`
3. Call `fitAddon.fit()` to resize terminal to new space

### Dependencies

#### External (Loaded in Browser)
- `@xterm/xterm` — Terminal emulator library
- `@xterm/addon-fit` — Auto-fit to container
- `@xterm/addon-webgl` — GPU acceleration (optional, graceful fallback)

#### Internal (from parent directory)
- Express server endpoints:
  - `GET /` → `index.html`
  - `GET /app.js` → app.js
  - `GET /style.css` → style.css
  - `GET /xterm/*.mjs` → xterm packages (static files from node_modules)
  - `WS /control` → control WebSocket
  - `WS /terminals/:sessionName` → data WebSocket per session

---

## Key Design Decisions

### Why Vanilla DOM, Not React?
Glissa prioritizes simplicity and minimal dependencies. xterm.js provides all interactive behavior. DOM updates are imperative and predictable. No virtual DOM overhead.

### Why Two WebSocket Connections?
- **Control WS:** Multiplexes all control messages (kill, restart, settings) over one stable connection
- **Data WS:** Dedicated per-session PTY I/O, direct byte streaming with zero serialization overhead

### Why xterm.js?
xterm.js is the industry standard, handles ANSI rendering perfectly, provides keyboard events, and has graceful degradation (WebGL → canvas). No need to reinvent terminal emulation.

### Why No Terminal Paging or History in Server?
xterm.js scrollback buffer (5000 lines) handles history entirely on the client. Server forwards raw bytes; client has all rendering responsibility.

---

## Troubleshooting

### WebSocket Reconnection Fails
- Check browser console for errors
- Verify server is running (`node server.js`)
- Check firewall rules, ensure port 3000 is open
- Restart browser tab

### Terminal Shows No Output
- Ensure session state is RUNNING (check badge)
- Verify data WS connects (check browser DevTools → Network → WS)
- Check server logs for PTY spawn errors
- Try killing and restarting the session

### Buttons Don't Appear
- Check current session state (badge label)
- Kill/Restart only appear in specific states (`KILLABLE_STATES`, `RESTARTABLE_STATES`)
- Clear browser cache and reload

### Audit Log Doesn't Populate
- Check server is broadcasting audit events in snapshot
- Verify `auditLog` array is populated in snapshot response
- Check `appendAuditEntry()` is being called

### Dialog Doesn't Close
- Ensure close handler is wired up in `showAddSessionDialog()`
- Check modal backdrop click handler
- Verify button click event listeners are attached

---

## Performance Considerations

- **Terminal scrollback:** 5000 lines (configurable via xterm.js options)
- **Audit timeline:** No hard limit, grows with session lifetime
- **Session cards:** Grid layout, CSS handles rendering
- **WebGL fallback:** Browser automatically uses canvas if WebGL unavailable
- **Idle counter:** `setInterval` ticks every 100ms while IDLE, clears on state change

For long-running sessions with large audit logs, consider pagination in the audit timeline or clearing old entries server-side.

---

## Recent Changes

As of 2026-03-10, the public directory is stable. The architecture (dual WebSocket, xterm.js, vanilla DOM) is foundational and unlikely to change.

Possible future work:
- Settings persistence (local storage)
- Dark/light theme toggle
- Customizable terminal colors
- Session filtering/search
- Multi-browser session sharing (WebSocket broadcast)
