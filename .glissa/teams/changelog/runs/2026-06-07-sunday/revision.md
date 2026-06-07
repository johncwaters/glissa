## Edited

`CHANGELOG.md` at the repository root. Keep a Changelog 1.1.0 / SemVer, newest-first, with `## [Unreleased]`
at the top above `## [0.13.0] - 2026-06-01`. All edits were confined to the `Unreleased` section per
`pack/changelog-config.md`. Entry text carries no commit sha (the sha is the team's internal trace, per the
style guide); shas below are for the Auditor's tracing only.

## Changes applied

### Added (new entries, inserted at the top of `### Added`)

- **Isolated git worktree per session** -> `dc0825d`, `60a5e32`, `a1535a6`, `9ad0dfb`, `a4c4530`, `bc22bca`,
  `5eae116`, `87a0083`, `1d09552` (worktree-isolated sessions; `integrationBranch` default `develop`).
- **Session worktree review sidebar** -> `e0a4578`, `8d6844a`, `954e7ad`, `7f4a1ab`, `6f4fe12`, `3b4e4c3`
  (right-docked review/merge sidebar). Dropped the Analyst's trailing "so work merges as it goes" clause as
  redundant filler to keep the entry to one terse sentence per the style guide; meaning is unchanged.
- **Warn before discarding unmerged session work** -> `9bcdf98` (Discard & Remove relabel + data-loss warn).
- **Focus view** -> `e0a4578`, `0cd97a7`, `e115178`, `9b263f9`, `91082ef` (new default view, left roster rail
  + single-session center). Kept this to the view itself; the keyboard nav and in-place WAITING/completed
  signaling are covered by their own entries (Alt+W reword; live heartbeat) to avoid bundling.
- **Live working heartbeat** -> `e03a5ae`, `275935e` (pill glyph breathes/beats on PTY chunk, quiets on stop).
- **Name-first roster pills with a time-in-state clock** -> `e03a5ae`, `275935e`. I split the Analyst's single
  proposed "Live working heartbeat" entry into two, as the proposal permitted, because it bundled three
  distinct user-facing changes (heartbeat animation vs. name-first pill ordering vs. the focused-card clock);
  "one change per entry" reads cleaner. Both halves trace to the same source group, since the Analyst did not
  attribute the clock to a single sha and I did not invent a finer mapping.
- **Background sub-agent completion gate** -> `a575954` (held out of Complete while a background sub-agent
  runs; "N agents" chip; on by default via `detectBackgroundAgents`).

### Reworded

- **Step through sessions needing attention** (was **Jump to the next session needing input**, kept under
  Added) -> `b88d6a8`, `91082ef`, `f2895a6`. Corrected to the current Focus-rail attention-queue behavior
  (one session per press, WAITING or completed, centers and focuses the terminal). I did NOT use the
  Analyst's proposed bold phrase "Walk the sessions that need you": the style guide bans second person
  ("you"), so I reworded to "Step through sessions needing attention" with the same meaning.
- **WebGL glyph ghosts on expand** (was **...on expand and maximize**, under Fixed) -> `6f26133`. Dropped the
  "and maximize" / "or maximizing" reference because the maximize action was removed in this same Unreleased
  window; the expand-repaint fix still holds.

### Added (other groups)

- Removed: **Multi-session grid and its controls** -> `6f26133`, `09bd9b4` (grid minimize/maximize, minimized
  bar, drag-and-drop reorder, manual/split layout control, sleep/wake all gone; navigation is now the Focus
  view). Placed first in `### Removed`, above the existing release-notes-team removal.
- Fixed: **Inconsistent completion alerts** -> `679329d` (finished turn plays the alert sound; completion
  notifications debounce per session and category so simultaneous completions stop cross-suppressing; a
  process exit notifies like a turn completion).

### Removed (deleted entry)

- Deleted the Changed entry **Legible minimized rail with peek tray** (was sourced to `b88d6a8`), superseded
  by `6f26133` (grid teardown) and `e115178` (peek-tray removal). Both the minimized rail and its peek tray
  are removed later in this same Unreleased window, so the release never ships them; the entry documented
  churn that nets to nothing. `### Changed` now holds two entries (Web Notifications, YOLO default).

## Unresolved

None. Every proposed change in `analysis.md` was applied. Two intentional, style-driven deviations from the
Analyst's exact wording are noted above and do not change which commits back which entry:

1. The Alt+W bold phrase was changed from "Walk the sessions that need you" to "Step through sessions needing
   attention" to satisfy the style guide's no-"you" rule.
2. The proposed single "Live working heartbeat" entry was split into two ("Live working heartbeat" and
   "Name-first roster pills with a time-in-state clock") to honor "one change per entry"; both trace to the
   same `e03a5ae`/`275935e` source group.

I also trimmed two redundant trailing clauses (the review-sidebar "so work merges as it goes" and the Focus
view's keyboard-nav restatement) so each entry stays to one terse sentence; no sourced claim was dropped.
