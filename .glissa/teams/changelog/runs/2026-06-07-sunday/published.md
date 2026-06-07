## Summary

This run reconciled the `v0.13.0..HEAD` range, accounting for 33 non-merge commits (`c4ae31b` through `3b4e4c3`, dated 2026-06-05/06). Eight new entries were added to Unreleased (seven features, one fix), one stale Changed entry was deleted (the minimized rail and peek tray were torn down later in the same Unreleased window, so the entry documented churn that nets to nothing), and two existing entries were reworded to match current behavior. The Auditor confirmed all entries in both directions and carried no caveats. There are no follow-up items.

## Announcement draft

Proposed release title and tag: `v0.14.0`

Note: the GitHub release body below mirrors what `scripts/release.js` will produce from the changelog. It is a draft for operator review only; no release, tag, or post has been created.

---

### GitHub release body

#### Navigation: Focus view replaces the multi-session grid

The multi-session grid is gone. Glissa's default view is now Focus: a left roster rail with one pill per session beside a single-session center. WAITING and completed sessions are signaled on the pill itself. `Alt+W` steps through the attention queue (waiting or completed) one press at a time, centering each session and focusing its terminal.

The grid's minimize, maximize, minimized bar, drag-and-drop reorder, manual layout control, and sleep/wake have all been removed along with the Sessions tab.

Roster pills now lead with the session name, and the focused card header shows a clock counting time in the current state. A working session's pill glyph breathes and beats on each terminal chunk and goes quiet when output stops.

#### Worktree isolation for git-repo sessions

Every session that runs inside a git repository now forks its own worktree from the integration branch (`integrationBranch`, default `develop`). The main checkout is untouched while the agent works.

A right-docked review sidebar shows the selected session's committed changes per file and merges them into the integration branch while the session keeps running. Removing a session that still holds unmerged changes now warns that the changes will be lost and relabels the action "Discard & Remove".

#### Background sub-agent completion gate

A session with a running background sub-agent (Task `run_in_background` or Ctrl+B) now stays out of Complete until the sub-agent finishes, eliminating the false completion alert that fired while background work was still running. A live "N agents" chip on the card shows the count. On by default; disable with `detectBackgroundAgents: false`.

#### Notifications and session defaults

Notifications now raise a native browser notification by default. The BurntToast/msg path is demoted to opt-in via `osToast`, and a Desktop Notifications toggle in Settings gates the channel.

New sessions spawn with `--dangerously-skip-permissions` by default (YOLO mode). The Add Session dialog offers an opt-out "Require permission prompts" for projects that need it.

Completion alerts are now consistent: a finished turn plays the alert sound, notifications debounce per session and category so simultaneous completions no longer cross-suppress each other, and a process exit notifies like a turn completion.

#### Post-turn auto-fix

When a session completes a turn, Glissa runs text hygiene over its git-changed files: strips em and en dashes, ellipses, trailing whitespace, and UTF-8 BOMs, and ensures a final newline. Results are reported on the card. On by default.

#### Teams

- `changelog` team: a four-stage pipeline (analyst, curator, auditor, announcer) that reconciles `CHANGELOG.md` against git history and, on a final SHIP verdict, drafts a release announcement. It does not post or tag.
- Operator conversation during a run: a run can pause when a stage emits a QUESTION and resume after the operator answers in a chat pane, bounded by a question budget and timeout.
- Project-level shared pack: cross-team pack files (voice-guide, avoid-list, brand) are filled once per project under `.glissa/pack/` and reused by every team that declares them shared.
- Standalone `release-notes` team removed; its git-range research and GitHub release draft are covered by the `changelog` team.

#### Fixes

- Team run output stranded on its worktree branch: the merge-back now clears blocking collisions before landing the run.
- Stale stage header in the Teams view: the run header no longer sticks on the finished stage while the next stage spawns.
- Dropped terminal history on reconnect under backpressure: a replay frame that dropped under backpressure now rewinds and re-pulls missed history in place.
- WebGL glyph ghosts on expand: expanding a card now forces a full repaint so stale cached glyphs no longer linger.

---

### X / Twitter

Glissa v0.14.0: git-repo sessions now run in isolated worktrees, with a review sidebar for merging changes while the session keeps running. The multi-session grid is replaced by a Focus view (roster rail + single center). https://github.com/johncwaters/glissa
