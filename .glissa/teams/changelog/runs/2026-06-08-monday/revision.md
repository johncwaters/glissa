## Edited

`CHANGELOG.md` at the repository root. Keep a Changelog 1.1.0 + SemVer 2.0.0, versions newest first, per-version reference links at the bottom. All edits were confined to the `## [Unreleased]` section, which was empty and is now populated.

## Changes applied

All entries were added under `## [Unreleased]`, with group headings created in Keep a Changelog order (Added, Changed, Fixed, Performance). No released section was touched, and no `Unreleased` reference link was added (correct per the config).

Added (new `### Added` group):

- **Code-slop detector** (e3610d3, lever A): opt-in report-only post-turn `slop` rule, count surfaced on the card, off by default via `rules.slop`.
- **Preventive anti-slop prompt** (e3610d3, lever B): opt-in `antiSlopPrompt` appends a fixed note to a user session's system prompt at spawn, team/pack-setup excluded, off by default. Deliberately split from the detector entry per the one-change-per-entry rule.

Added (new `### Changed` group):

- **Pinned review sidebar controls** (98d3875): Merge/Resolve in session/Discard pinned in view as the diff scrolls; Merge always shown while a session is selected, disabled with a one-line reason when not actionable.

Added (new `### Fixed` group):

- **Worktree badge on fresh spawn** (5d13157): badge appears when the worktree is provisioned, not only after a reload.
- **Merge button on turn end** (fd2b53d): Merge button appears the instant a turn ends, not only after clicking a review file.
- **Discoverable Alt+W attention-queue placeholder** (767b48c, 39d9dab, 2313cea): merged single entry sourced to all three rail-head commits, describing the final resting-placeholder + earned-accent state. Written as ONE bullet, not three, per the analysis.

Added (new `### Performance` group):

- **Worktree git work off the event loop** (86ccf12): worktree git probes and post-turn checks moved sync to async; `liveWorktreeReview` kill-switch mentioned once here.
- **Event-driven worktree detection** (3cb0f77): 10s liveness poll replaced by an integration-branch reflog watcher.

Reworded / moved / merged / reordered: none beyond the merge noted above. The section was empty, so this was purely additive; no existing entry was reworded, moved, or reordered, and no released version was edited. `ea64bcd` (screenshot chore) was correctly excluded by the analysis and added nothing.

## Unresolved

None. Every proposed change in `analysis.md` was applied. Each new entry traces to a commit in `## Sources`, all 10 of which were confirmed present in `git log v0.14.0..HEAD`. The two arguable classifications the Analyst flagged (pinned-controls as Changed vs Fixed; merged rail-head entry as Fixed vs Changed) were applied as the Analyst recommended (Changed and Fixed respectively); they are noted here only so the Auditor can re-judge the bucket if desired. The new section was scanned and contains no em dashes, en dashes, ellipses, or stray NUL bytes.
