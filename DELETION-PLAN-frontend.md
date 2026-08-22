# Frontend simplification plan (public/)

Scope after the operator's mid-round correction: **no feature deletion.** Nothing that belonged to a
server feature cut in the recent simplification rounds (usage vendors/warehouse/budgets/anomaly/
savings/heatmap, posthog recurrence/traffic-spike, pack chip/notice/distiller, navigator intent,
ingest surfaces) is touched, because that residue may go live again. What is left: duplication folds,
code that was **already dead at 18a9e53** (before any simplification round), and defensive branches
for payloads that never existed. No operator-visible behavior changes.

Load-bearing seams untouched, per AGENTS.md: `decideLayout`'s AND rule, the single-borrower
`card-host` invariant, re-parenting over duplication, the render-scheduler write budget, the
touch-scroll and soft-keyboard takeover paths, the notify-dedupe cross-tab claim, the resize
arbitration `unview` protocol, and every live review-sidebar merge/discard path.

## 1. Folds (duplication)

| What | Where | Why |
|---|---|---|
| Two near-identical confirm-dialog builders | `session-card/card-dom.js` `showConfirmDialog` and `dialogs.js` `createConfirmDialog` | Byte-for-byte the same 35-line builder apart from a `danger` class. The copy exists only to dodge a `dialogs.js` <-> `card-dom.js` cycle, and both files already import `session-card/modal.js`, which is the cycle-free home. One `openConfirmDialog` there; both call sites delegate. |
| Eleven hand-written `get`/`set` pref pairs | `ui-prefs.js` | Each pair repeats load/mutate/save plus a normalize line in `load()`. A per-key spec with one normalizer collapses the boilerplate and puts each key's default and validation in one place instead of two. |
| Raw `localStorage` for the sidebar width | `sidebar/review-sidebar.js` | Two bare `try`/`catch` blocks and a hand-rolled clamp, against `public/AGENTS.md`'s rule that persistent UI state goes through `ui-prefs.js`. Moved there under the SAME storage key (`glissa:sidebar-width`) so an operator's saved width survives. |
| `buildSection(title, hint)` | `radar-panel.js`, `usage-panel.js` | Identical builder, different class prefix. One `buildPanelSection(prefix, title, hint)` in `dom-helpers.js`. |
| `summaryStat(label, value, tone)` | `radar-panel.js`, `pr-panel.js` | Same, prefix-parameterized. |
| `projectsOf(snapshot)` | `radar-panel.js`, `pr-panel.js` | Same three-line array guard. |
| `isHidden()` | `usage-panel.js`, `navigator-panel.js` | Same `closest('[hidden]')` check. |

## 2. Deletions (verified dead at 18a9e53, unrelated to any simplification round)

| What | Why dead |
|---|---|
| `focus-view.js` `focusSessionInCenter` + its comment | Its only consumer, the guided-setup handler, is long gone; the sole surviving mention is a prose comment in `app.js`. |
| `form-factor.js` `getLayout` | Exported, referenced nowhere but its own definition and a comment. `isPhoneLayout` is what callers use. |
| `app.js` `'session-worktree-ready': () => {}` | An empty handler. The dispatcher already ignores unhandled types, so the entry changes nothing. |
| `control-ws.js` empty `error` listener | A listener whose whole body is a comment saying `close` fires next. `addEventListener` needs no error listener to stay safe (unlike a Node EventEmitter). |
| `style.css` `.sessions` grid rules + its two responsive `@media` blocks | `#sessions-container { display: none; }` is unconditional; the grid geometry and its narrow-window gap overrides have had no rendered element since the Sessions tab was removed. |
| `dialogs.js` stale usage-vendors comment | Describes a vendors checkbox that is not in the dialog. Comment only; no code path. |
| `ui-prefs.js` `themeId` corrupt-value fallback disagreeing with the default | `DEFAULT_PREFS.themeId` is `phyrexian` (matching `theme.js` and the inline critical CSS) while the corrupt-value branch says `golgari`. Reachable only from a stored non-string, i.e. a payload that never existed. Unified on `phyrexian`. |

## 3. Report only (no edit)

- `usage-view-core.mjs` `LANE_LABELS` still names the removed `pack-distill` lane and does not name the live `navigator` lane, so a navigator lane row renders its raw id. Left alone: the distiller may return, and adding a label is operator-visible.
- `pr-view-core.mjs` carries four phases the PR lane never emits (`changes-requested`, `conflicting`, `resolving-conflicts`, `in-review`) across four tables. Dead at 18a9e53 too, but it is lane vocabulary rather than residue, so it is reported instead of trimmed.
- `navigator-view-core.mjs` `normalizeActivityEvent` normalizes `kind` and `sessionId`, neither of which any renderer reads. In-scope of the ingest surfaces being restored, so untouched.
- Server messages with no client consumer: `sessions-reordered` (broadcast, nothing handles it). Server control handlers with no client sender: `kill`, `sleep`, `wake`, `reorder-sessions`, `merge-session`, `finish-session`.

## 4. Delta

317 lines removed, 195 added, net **-122** across 21 files (18 of them under `public/`, three AGENTS
prose files). No test file needed a change: `npm test` is 2649 pass / 0 fail before and after, and
`npm run build` is clean. No message type, no rendered string, and no stored value changes.

One narrow behavior note: `ui-prefs.load()` now rebuilds the prefs object from the declared keys, so an
unrecognized key in a stored blob is dropped on the next write instead of being carried forward. The
schema is closed and no build has ever written one, so nothing real is lost.
