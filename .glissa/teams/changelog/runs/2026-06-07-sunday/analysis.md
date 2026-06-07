## Topic

Unreleased reconcile: the `Unreleased` section is stale against a large batch of session-worktree,
Focus-view, and review-sidebar work that landed after the prior changelog run shipped (2026-06-05). 33
new commits to fold in, plus two existing entries the new work has invalidated.

## Range

- Latest tag from `git describe --tags --abbrev=0` is `v0.13.0`. Per `pack/changelog-config.md` the range
  is `<latest tag>..HEAD`, so `v0.13.0..HEAD` (HEAD = `3b4e4c3`).
- The prior changelog run shipped at `c4ae31b` (`changelog: 2026-06-05-friday (SHIP)`) and `log.md` records
  that `2026-06-05 | (topic) | - | SHIP`. Everything at or before `c4ae31b` is already reconciled and lives
  in the current `Unreleased` section; I treat it as settled except where a newer commit contradicts it.
- The reconciliation delta is the 33 non-merge commits `c4ae31b..HEAD` (`dc0825d` through `3b4e4c3`, dated
  2026-06-05/06), none of which appear in the changelog.

## Current state

- Format matches `pack/changelog-config.md`: Keep a Changelog 1.1.0, SemVer, newest-first, `## [Unreleased]`
  at the top above `## [0.13.0] - 2026-06-01`, reference links at the bottom (no link for `Unreleased`).
  Structure is sound: no mis-ordered versions, no duplicate sections, no stale heading.
- The `Unreleased` section currently has Added (5), Changed (3), Removed (1), Fixed (4). Those entries trace
  to the pre-`c4ae31b` work (changelog team, operator-conversation pause/resume, project-level shared pack,
  post-turn auto-fix, web notifications, YOLO default, the merge-back/stage-header/reconnect/WebGL fixes)
  and were reconciled by the prior run. They remain accurate, with two exceptions the new batch broke
  (below).
- The gap is content, not structure: the entire post-`c4ae31b` arc (worktree-isolated sessions, the Focus
  view that replaced the multi-session grid, the worktree review sidebar, the working heartbeat, the
  background sub-agent completion gate) is missing, and two existing entries now describe UI that the same
  arc removed or reworked.

## Discrepancies

MISSING `dc0825d` `60a5e32` `a1535a6` `9ad0dfb` `a4c4530` `bc22bca` `5eae116` `87a0083` `1d09552` -
Worktree-isolated sessions. Every git-repo session now forks an isolated worktree off the integration
branch and runs there; the main checkout is untouched until a merge-back. New settings `integrationBranch`
(default `develop`), `worktreeRoot` (default a `.glissa-worktrees` sibling of the repo), `worktreeShare`
(gitignored context: node_modules/.env/.env.local/.claude/.omc). Nothing in the changelog.

MISSING `e0a4578` `8d6844a` `954e7ad` `7f4a1ab` `6f4fe12` `3b4e4c3` `9bcdf98` - Session worktree review and
merge. A right-docked, always-visible review sidebar shows the selected session's committed changes per
file and merges them into the integration branch ("merge as you go") while the session keeps running;
removing a session with unmerged changes warns and relabels the action "Discard & Remove" (`9bcdf98`).

MISSING `e0a4578` `0cd97a7` `e115178` `9b263f9` `91082ef` - Focus view. A new Focus view (now the default
landing view) with a left roster rail (one pill per session) and a single-session center, replacing the
multi-session grid as the navigation model.

MISSING `e03a5ae` `275935e` - Live working heartbeat and name-first roster pills. A working session's
roster pill glyph breathes and beats on each PTY chunk and goes quiet after output stops; pills lead with
the session name; the focused card header shows a time-in-state clock.

MISSING `a575954` - Background sub-agent completion gate. A session with a running background sub-agent
(Task `run_in_background` / Ctrl+B) is held out of Complete until the sub-agent finishes, killing a false
completion alert; a live "N agents" chip shows the count. On by default (`detectBackgroundAgents`).

MISSING `6f26133` `09bd9b4` - Multi-session grid removed (belongs under Removed). The grid's minimize and
maximize, the minimized bar, drag-and-drop reordering, the manual/split layout control, and sleep/wake are
gone; the Sessions tab is no longer a navigable view. Typed `refactor` but user-facing removals, so they
must be logged.

MISSING `679329d` - Completion-alert consistency (belongs under Fixed). A finished turn now plays the alert
sound (previously only WAITING did), notifications debounce per session and category so two sessions
completing together stop cross-suppressing each other, and a process exit notifies like a turn completion.

INACCURATE `b88d6a8` (superseded by `6f26133`, `e115178`) - The Changed entry "Legible minimized rail with
peek tray" describes the minimized rail and its fly-up peek tray, both of which were removed later in this
same `Unreleased` window (grid teardown `6f26133`; peek-tray removal `e115178`). It documents churn that
nets to nothing for the release and now describes UI that will not exist in it.

INACCURATE `91082ef` `f2895a6` (vs existing entry from `b88d6a8`) - The Added entry "Jump to the next
session needing input" says Alt+W "moves focus to the next session in the WAITING state." Alt+W now walks
the Focus rail's attention queue one session per press, counting WAITING and unacknowledged completed
sessions, borrows each into the center, and drops the cursor into its terminal.

INACCURATE (low) `6f26133` - The Fixed entry "WebGL glyph ghosts on expand and maximize" references the
maximize action, which was removed in this same window. The expand-repaint half still holds; the "maximize"
reference is now stale.

Correctly excluded (not logged): merge commits `2d513d9`, `1de8877`; chores `660f59c` (screenshot),
`c1a3b33` (team pack setup); generated team-run output `62faf2e`, `af5ba5a`, `c4ae31b`; and interim
fixes/refactors to features being added in this same window, whose end state the proposed entries already
capture: `0f7376a`, `4a25163`, `9c4ba42`, `ed7ad73`, `7db15da`, `2fc0792` (and `275935e`, `a4c4530`, which
also back the entries above). Already documented and accurate from the prior run: `ebc5445`, `6bf95e7`,
`332eb4a`, `ea78189`, `5201dc7`, `b260ac1`, `a74672f`, `b68601b`, `295cd60`, `f4bd510`, `b7a0481`,
`b53c1b7`.

## Proposed changes

Confine all edits to `Unreleased`. Add these entries (Curator may split a two-clause entry into two if the
style guide's "one change per entry" reads cleaner):

Under `### Added`:

- **Isolated git worktree per session**: Every git-repo session runs in its own worktree forked from the
  integration branch (`integrationBranch`, default `develop`), so an agent's edits stay out of the main
  checkout until they are reviewed and merged back. (`dc0825d`, `60a5e32`, `a1535a6`, `9ad0dfb`, `a4c4530`,
  `bc22bca`, `5eae116`, `87a0083`, `1d09552`)
- **Session worktree review sidebar**: A right-docked sidebar shows the selected session's committed changes
  per file and merges them into the integration branch while the session keeps running, so work merges as it
  goes. (`e0a4578`, `8d6844a`, `954e7ad`, `7f4a1ab`, `6f4fe12`, `3b4e4c3`)
- **Warn before discarding unmerged session work**: Removing a session that still holds unmerged worktree
  changes now warns that they will be lost and relabels the action "Discard & Remove". (`9bcdf98`)
- **Focus view**: A new Focus view, now the default, presents a left roster rail of one pill per session and
  a single-session center, with WAITING and completed sessions signaled in place and Up/Down plus Alt+W
  keyboard navigation. (`e0a4578`, `0cd97a7`, `e115178`, `9b263f9`, `91082ef`)
- **Live working heartbeat**: A working session's roster pill glyph breathes and beats on each terminal
  chunk, goes quiet after output stops, leads with the session name, and shows a time-in-state clock on the
  focused card. (`e03a5ae`, `275935e`)
- **Background sub-agent completion gate**: A session with a running background sub-agent (Task
  `run_in_background` or Ctrl+B) is held out of Complete until the sub-agent finishes, so a background task
  no longer fires a false completion alert, and a live "N agents" chip shows the count. On by default via
  `detectBackgroundAgents`. (`a575954`)

Under `### Changed`:

- Delete the existing **Legible minimized rail with peek tray** entry. The minimized rail and peek tray it
  describes were removed later in this same `Unreleased` window, so the release never ships them.
  (superseded by `6f26133`, `e115178`)

Under `### Removed`:

- **Multi-session grid and its controls**: The Sessions grid's minimize and maximize, the minimized bar,
  drag-and-drop reordering, the manual/split layout control, and sleep/wake are gone; sessions are now
  navigated through the Focus view. (`6f26133`, `09bd9b4`)

Under `### Fixed`:

- Reword the existing **Jump to the next session needing input** entry (currently under Added) to: **Walk
  the sessions that need you**: `Alt+W` steps through the Focus rail's attention queue one session per
  press (WAITING or completed), centering each and focusing its terminal. (`b88d6a8`, `91082ef`, `f2895a6`)
  (Keep it under Added; it is the same feature, corrected.)
- **Inconsistent completion alerts**: A finished turn now plays the alert sound, completion notifications
  debounce per session and category so simultaneous completions stop cross-suppressing each other, and a
  process exit notifies like a turn completion. (`679329d`)
- (Low priority) In the existing **WebGL glyph ghosts on expand and maximize** entry, drop "and maximize"
  (the maximize action was removed this window), leaving the expand-repaint fix. (`6f26133`)

## Sources

- Worktree-isolated sessions: `dc0825d`, `60a5e32`, `a1535a6`, `9ad0dfb`, `a4c4530`, `bc22bca`, `5eae116`,
  `87a0083`, `1d09552`
- Worktree review sidebar / merge-as-you-go: `e0a4578`, `8d6844a`, `954e7ad`, `7f4a1ab`, `6f4fe12`,
  `3b4e4c3`
- Discard warning for unmerged work: `9bcdf98`
- Focus view: `e0a4578`, `0cd97a7`, `e115178`, `9b263f9`, `91082ef`
- Live working heartbeat + name-first pills: `e03a5ae`, `275935e`
- Background sub-agent completion gate: `a575954`
- Multi-session grid removed: `6f26133`, `09bd9b4`
- Completion-alert consistency: `679329d`
- Alt+W rework (existing entry reword): `b88d6a8`, `91082ef`, `f2895a6`
- Minimized-rail/peek-tray entry deletion (superseding commits): `6f26133`, `e115178`
- WebGL-ghosts entry "maximize" reference now stale: `6f26133`

No proposed change relies on a commit outside this list.
