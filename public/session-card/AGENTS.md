<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-07-02 -->

# session-card

## Purpose
Session card modules, decomposed from the old monolithic session-card.js. Each session renders as one card owning one xterm.js terminal; these modules cover card DOM, terminal wiring, lifecycle/state application, naming, the shared tick, and the WebGL context pool.

## Key Files

| File | Description |
|------|-------------|
| `card-registry.ts` | Shared state owner: `sessionUIs` Map + 2 DOM singletons |
| `lifecycle.ts` | `createSessionCard`, `removeSessionCard`, `applyState`, aggregate status wiring |
| `aggregate-core.ts` | Pure `computeAggregate` (used by lifecycle) |
| `agent-core.ts` | Pure `agentBadgeText(agent)`: which agent adapter id earns a card chip (never the default one) |
| `card-dom.ts` | Card builder, badge, inline rename, confirm dialog, debug overlay |
| `terminal.ts` | xterm.js setup, data WebSocket, OSC-52 clipboard, key handling (consults `focus-view/focus-shortcuts.ts` for which Alt+keys bubble), phone soft-keyboard input takeover |
| `ime-core.ts` | Pure soft-keyboard edit to terminal bytes: shared-prefix diff of xterm's helper textarea, plus the inputType/keydown predicates the takeover in `terminal.ts` gates on |
| `activity.ts` | Working-session heartbeat from output ARRIVAL timing only (no content reads); paints liveness/quiet on the Focus rail pill |
| `session-tick.ts` | Shared 1s tick: elapsed clock + working-heartbeat poll (`refreshElapsed`); no per-session timers |
| `naming.ts` / `naming-core.ts` | Session name suggestion; pure core: `nextSuggestedName`, `countAutoNames`, `isAutoNameOf` |
| `webgl-pool.ts` / `webgl-core.ts` | WebGL context pool with LRU cap; pure core: `pickEvictionVictims` |
| `toast.ts` | `showErrorToast` - leaf, no local deps |
| `modal.ts` | Shared modal overlay scaffold (overlay, Escape-to-close, backdrop click, opener refocus) plus `openConfirmDialog`, THE confirm prompt every destructive action uses. It lives here, not in `dialogs.ts`, because `card-dom.ts` may not import that file; before the fold both sides carried their own copy of the same builder |

## For AI Agents

### Working In This Directory
- The data path is a dumb pipe: `activity.ts` may use byte-arrival TIMING, never byte CONTENT. Do not parse terminal output here.
- One xterm per session; the Focus view re-parents the card node, so never assume a fixed parent container.
- WebGL contexts are a scarce resource: always acquire through `webgl-pool.ts`.
- No per-session `setInterval`: ride `session-tick.ts`.
- State is applied via `applyState` + `[data-state]` CSS; do not hand-toggle state classes.

### Testing Requirements
- Pure cores tested in `tests/frontend-naming.test.js`, `frontend-webgl-pool.test.js`, `frontend-aggregate-status.test.js`, `frontend-ime-core.test.js`; terminal/DOM behavior verified via `npm run dev`.

## Dependencies

### Internal
- `../control-ws.ts`, `../render-scheduler.ts`, `../theme.ts`, `../focus-view/focus-shortcuts.ts`, `#shared/states.ts`

### External
- `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-webgl`

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
