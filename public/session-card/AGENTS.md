<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-07-02 -->

# session-card

## Purpose
Session card modules, decomposed from the old monolithic session-card.js. Each session renders as one card owning one xterm.js terminal; these modules cover card DOM, terminal wiring, lifecycle/state application, naming, the shared tick, and the WebGL context pool.

## Key Files

| File | Description |
|------|-------------|
| `card-registry.js` | Shared state owner: `sessionUIs` Map + 2 DOM singletons |
| `lifecycle.js` | `createSessionCard`, `removeSessionCard`, `applyState`, aggregate status wiring |
| `aggregate-core.mjs` | Pure `computeAggregate` (used by lifecycle) |
| `card-dom.js` | Card builder, badge, inline rename, confirm dialog, debug overlay |
| `terminal.js` | xterm.js setup, data WebSocket, OSC-52 clipboard, key handling (consults `focus-view/focus-shortcuts.mjs` for which Alt+keys bubble), phone soft-keyboard input takeover |
| `ime-core.mjs` | Pure soft-keyboard edit to terminal bytes: shared-prefix diff of xterm's helper textarea, plus the inputType/keydown predicates the takeover in `terminal.js` gates on |
| `activity.js` | Working-session heartbeat from output ARRIVAL timing only (no content reads); paints liveness/quiet on the Focus rail pill |
| `session-tick.js` | Shared 1s tick: elapsed clock + working-heartbeat poll (`refreshElapsed`); no per-session timers |
| `naming.js` / `naming-core.mjs` | Session name suggestion; pure core: `nextSuggestedName`, `countAutoNames`, `isAutoNameOf` |
| `webgl-pool.js` / `webgl-core.mjs` | WebGL context pool with LRU cap; pure core: `pickEvictionVictims` |
| `toast.js` | `showErrorToast` - leaf, no local deps |
| `modal.js` | Shared modal overlay scaffold (overlay, Escape-to-close, backdrop click, opener refocus); used by `card-dom.js` and `dialogs.js` |

## For AI Agents

### Working In This Directory
- The data path is a dumb pipe: `activity.js` may use byte-arrival TIMING, never byte CONTENT. Do not parse terminal output here.
- One xterm per session; the Focus view re-parents the card node, so never assume a fixed parent container.
- WebGL contexts are a scarce resource: always acquire through `webgl-pool.js`.
- No per-session `setInterval`: ride `session-tick.js`.
- State is applied via `applyState` + `[data-state]` CSS; do not hand-toggle state classes.

### Testing Requirements
- Pure cores tested in `tests/frontend-naming.test.js`, `frontend-webgl-pool.test.js`, `frontend-aggregate-status.test.js`, `frontend-ime-core.test.js`; terminal/DOM behavior verified via `npm run dev`.

## Dependencies

### Internal
- `../control-ws.js`, `../render-scheduler.mjs`, `../theme.js`, `../focus-view/focus-shortcuts.mjs`, `/shared/states.mjs`

### External
- `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-webgl`

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
