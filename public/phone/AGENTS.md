<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-09 | Updated: 2026-08-09 -->

# phone

## Purpose
The phone layout: four screens (Board, Terminal, Review, Teams) behind a bottom nav, rendered ONLY under `[data-layout="phone"]`. It is a first-class layout, not a narrowed desktop: the desktop shell is `display:none` on a phone, and the phone shell borrows the elements that own live state (the review sidebar, the Teams panel, the desktop header controls, a session's card) instead of rebuilding them.

The job it serves is triage, per `PRODUCT.md`: scan the board, find the session that needs a carbon unit, open it, act, go back.

## Key Files

| File | Description |
|------|-------------|
| `phone-shell.js` | Owns the screen container, the bottom nav, screen switching, history integration, visual-viewport sizing, and the activate/deactivate handoff with the desktop layout |
| `board-screen.js` | The default screen: attention-first session rows + the phone top bar (which adopts the desktop header's connection chip, "+ Session", help, and hamburger) |
| `terminal-screen.js` | One session's full-bleed terminal: back control, name, state badge, the card's adopted action cluster, and the touch key strip |
| `triage-core.mjs` | Pure attention-first ORDER (`orderSessionsForTriage`) only. The "needs you" rule and its readout wording are shared with the desktop rail head in `../focus-view/attention-core.mjs` |
| `mobile-key-strip.js` | Esc / Tab / Ctrl+C / arrows / Paste, the keys a soft keyboard cannot produce (catalog in `../mobile-keys.mjs`) |

Review and Teams have no module: each screen is a mount container that re-parents the real `#review-sidebar` / `#view-teams` element in.

## For AI Agents

### Working In This Directory
- Which layout runs is decided by `../form-factor-core.mjs` (`coarse AND narrow`) and stamped on `<html data-layout>` by `../form-factor.js`. Style phone surfaces off that attribute; never add a `max-width` override of a desktop selector.
- Re-parent, never duplicate. `dom-helpers.js` `adoptElement` / `releaseElement` for panels; `../card-host.js` `borrowCard` / `releaseCard` for a session card (single borrower GLOBALLY, shared with the Focus center).
- One state pipeline. The Board reads `session-card/card-registry` and is refreshed by the same `app.js` control-WS handlers that refresh the desktop rail. Do not subscribe to the control WS from here.
- One "needs you" rule. The Board and the desktop rail head render the same `{n} NEED YOU` readout, so the predicate and the wording live once in `../focus-view/attention-core.mjs`. Each surface supplies its own `unseen` bookkeeping (the Board a Set, the rail its pill's `data-unseen`); never re-implement the rule here.
- Row clocks ride the shared tick (`session-card/session-tick.js` `onSessionTick`), never a timer of their own.
- History: at most ONE entry is pushed above the Board, and only while the phone shell is active. Desktop must never touch history.
- Soft keyboard: the shell is sized from `window.visualViewport`, so the keyboard resizes the terminal instead of covering it; the card's existing ResizeObserver then refits cols/rows.
- Every function reachable on desktop must be reachable here or its absence justified. A desktop mechanism that has no touch meaning gets the correct touch-native one (inline rename retargets to the Terminal top bar's name via `ui.renameTargetEl`), never a dead affordance.
- `.mjs` files stay pure (no DOM, no window); they run under node:test too.

### Testing Requirements
- `tests/frontend-phone-triage.test.js` (ordering + counts) and `tests/frontend-form-factor.test.js` (the layout decision). DOM behavior is verified manually; real-device rendering is not covered by the suite.

## Dependencies

### Internal
- `../form-factor.js`, `../card-host.js`, `../dom-helpers.js`
- `../session-card/` (registry, tick, terminal input, toast), `../sidebar/review-sidebar.js` + `selection.js`, `../focus-view/attention-core.mjs` (the alphabetical base order), `../ui-prefs.js`, `../control-ws.js`

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
