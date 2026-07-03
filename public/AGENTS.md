<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-07-02 -->

# public

## Purpose
The browser dashboard frontend: ES modules bundled by Vite (dev server with HMR on 5173, production build to `dist/`). Renders session cards with xterm.js terminals, a Focus view, a review sidebar, a Teams panel, dialogs, themes, and notifications. The server is a dumb pipe; ALL ANSI rendering happens here.

## Key Files

| File | Description |
|------|-------------|
| `index.html` | Dashboard shell (Tailwind utility classes) |
| `app.js` | Thin boot entry: wires modules, owns the document-level Alt+key shortcut dispatch |
| `control-ws.js` | Control WebSocket client: connection, reconnect, request/response |
| `dialogs.js` | Add Session and Settings dialog factories (HTML imported `?raw` from `components/`) |
| `teams-panel.js` | Barrel for the Teams tab (re-exports the 4-symbol public API from `teams-panel/`) |
| `render-scheduler.mjs` | Global xterm WRITE scheduler: callback-gated round-robin with per-frame budget (distinct from root `scheduler.js`, which is a cron) |
| `notifications.js` | Native Web Notifications (browser routes to Windows Action Center); replaces the server-side toast path |
| `notify-dedupe-core.mjs` | Pure cross-tab claim (short-TTL localStorage) so exactly one open tab raises each notification |
| `alert-sound.js` | Notification sounds: audio files from `audio/` + synth-beep fallback |
| `health-monitor.js` | Footer panel rendering server memory/leak telemetry from `health-snapshot` messages |
| `theme.js` | Theme definitions applied as CSS custom properties; terminal theme derived at runtime |
| `ui-prefs.js` / `local-store.js` | localStorage persistence for UI state (sound, theme, active view) with quota-safe wrappers |
| `shortcuts.mjs` | Pure display catalog of keyboard shortcuts for the Settings dialog; handlers live in `app.js` and `session-card/terminal.js`, keep in sync |
| `dom-helpers.js` | `el()` / `escapeHtml()` DOM utilities |
| `style.css` | Component styles, `[data-state]` rules, animations, `::before` pseudo-elements |
| `tailwind.css` | Tailwind v4 entry: `@theme` block mapping colors, fonts, radii |
| `perf.html` / `perf-harness.js` / `perf-corpus.mjs` | Dev-only manual perf harness (K xterm terminals under dense ANSI load); never bundled into production |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `session-card/` | Session card modules: terminal, lifecycle, DOM, naming, WebGL pool (see `session-card/AGENTS.md`) |
| `teams-panel/` | Teams tab package: `lifecycle.js` orchestrator + registry, instance panel, pipeline, runs list, schedule editor, chat, setup banner, pure `format-core.mjs` |
| `focus-view/` | Focus view: roster rail + centered card, attention queue (see `focus-view/AGENTS.md`) |
| `sidebar/` | Review sidebar: diff rendering, selection, merge actions (see `sidebar/AGENTS.md`) |
| `components/` | Static HTML fragments imported `?raw` (see `components/AGENTS.md`) |
| `audio/` | Notification sound files (OGG) |

## For AI Agents

### Working In This Directory
- ESM only (this is the Vite side; the server is CJS). `.mjs` files are PURE modules (no DOM) shared with node:test; keep them dependency-free.
- CSS convention: Tailwind utilities in `index.html`; semantic classes in `style.css` for JS-created DOM; state-driven styles via `[data-state]`; keyframes and pseudo-elements in `style.css`; theme tokens in `tailwind.css`.
- All terminal writes go through `render-scheduler.mjs`; never call `term.write` with unbounded data outside it.
- Use `id` (stable UUID) for any session keying; `name` is display only.
- New persistent UI state goes through `ui-prefs.js`, not raw localStorage.

### Testing Requirements
- Pure `.mjs` cores have node:test coverage (`tests/frontend-*.test.js`, `shortcuts-core`, `render-scheduler`, `roster-groups-core`, `focus-shortcuts-core`); DOM modules are verified manually via `npm run dev`.

### Common Patterns
- Pure-core (`*.mjs`) + DOM-wrapper (`*.js`) pairs, mirroring the server's seam pattern.
- Control messages via `sendControlMsg` / `sendControlRequest`; state pushed from the server as snapshots and events.

## Dependencies

### Internal
- `../shared/states.esm.js` (served as `/shared/states.mjs`)
- `../backend.js` - the WS endpoints this client speaks to

### External
- `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-webgl` - bundled by Vite, browser only
- `tailwindcss` v4 via `@tailwindcss/vite`

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
