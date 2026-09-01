<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# focus-view

## Purpose
The Focus view: a watch-and-steer layout with a persistent left roster rail (one pill per session, grouped by project) and a single large center holding the focused session's re-parented card. Attention (WAITING, fresh COMPLETE) is carried in place by pill treatment and the Alt+W jump; pills never reorder on state change.

## Key Files

| File | Description |
|------|-------------|
| `focus-view.ts` | The DOM layout: rail, center re-parenting, attention header ("{n} NEED YOU"), pill rendering |
| `attention-core.ts` | Pure roster ordering (non-dormant first, then numeric/case-insensitive name), attention-queue cursor (`pickNextAttention`), and THE shared "needs you" rule (`needsAttention` / `countSessionsNeedingAttention` / `attentionSummaryText`) that both the rail head and the phone Board render |
| `roster-groups.ts` | Pure project grouping over an already-ordered roster; stable partition, groups A->Z by basename. Optional 3rd arg `emptyKeys` adds session-less KEPT projects as empty groups (`rows: []`) |
| `focus-shortcuts.ts` | Single source of truth for which Alt+key combos are dashboard shortcuts; consulted by `session-card/terminal.ts` so they bubble past xterm |

## For AI Agents

### Working In This Directory
- The stable-map rule is load-bearing: order is identity-based, never status-based. A state change must never reorder a pill or a group.
- Kept projects: closing the last session of a project keeps its path as an empty rail group (header + "+" quick-add + a dismiss "×") so the operator re-adds a session without re-picking the folder. `../project-registry.ts` owns the one `knownProjectPaths` Set shared by the Focus rail and phone Board; `noteKnownProjectPath` is called from the session lifecycle in `app.ts`, and persistence stays in `ui-prefs` `keptProjects`. Membership drives the empty group; `forgetProject` removes a path permanently until a session is added on it again.
- Keep `focus-shortcuts.ts` in lockstep with the dispatch in `app.ts` and the display catalog in `../shortcuts.ts` when adding a binding.
- `*-core.ts` files stay pure (no DOM, no window, no localStorage); they run under node:test too.
- The center holds the REAL card (re-parented), not a copy; rail activity paints only on the pill, never on the centered terminal.

### Testing Requirements
- `tests/frontend-attention-roster.test.js`, `tests/roster-groups-core.test.js`, `tests/focus-shortcuts-core.test.js`; layout verified via `npm run dev`.

## Dependencies

### Internal
- `../session-card/` (cards, activity flags), `../sidebar/selection.ts` (focusing selects in the review sidebar), `../app.ts` (shortcut dispatch)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
