## Edited

`CHANGELOG.md` at the repository root. Keep a Changelog 1.1.0 + SemVer, `## [x.y.z] - YYYY-MM-DD` headings newest first, `###` change groups, bottom reference links per released version. All edits confined to the `## [Unreleased]` section; no dated/released section was touched and no `Unreleased` reference link was added.

## Changes applied

Rebuilt the `Unreleased` section from two mis-grouped walls into the configured group order (Added, Changed, Removed, Fixed), each entry terse (bold summary, colon, one present-tense sentence).

Added (new group, created at the top of `Unreleased`):

- `5201dc7` (+ `295cd60`) **Teams: `changelog` team** entry. Folds in the announcer detail that previously lived as the standalone `### Changed` "the changelog team now also drafts release announcements" wall.
- `ea78189` **Teams: operator conversation during a run**.
- `b68601b` **Teams: project-level shared pack**.
- `b53c1b7` (+ `b88d6a8` for the card-badge report) **Deterministic post-turn auto-fix on turn completion**.
- `b88d6a8` **Jump to the next session needing input** (`Alt+W`).

Changed (group replaced):

- `b7a0481` **Notifications delivered via browser Web Notifications** (new entry).
- `f4bd510` **Skip-permissions (YOLO) is the session default** (new entry).
- `b88d6a8` **Legible minimized rail with peek tray** (new entry; the minimized-rail half of the commit, distinct from its `Alt+W` and post-turn-badge halves which went to Added).
- Removed the prior `### Changed` "the changelog team now also drafts release announcements" entry: its content folds into the Added `changelog` team entry per the analysis. Removing it also avoids the duplication the analysis flagged.

Removed (existing entry reworded):

- `295cd60` **Teams: standalone `release-notes` team**. Tightened the prior multi-sentence wall to one terse sentence; the fact (the `release-notes` team shipped in 0.13.0 and is now gone, its non-redundant piece absorbed by the announcer) is unchanged.

Fixed (new group, after Removed):

- `b260ac1` **Team run output stranded on its worktree branch**.
- `b260ac1` **Stale stage header in the Teams view** (the second user-facing fix in that commit, written as its own entry per one-change-per-entry).
- `332eb4a` **Dropped terminal history on reconnect under backpressure** (distinct from the 0.13.0 live-output backpressure fix, which is left untouched).
- `6bf95e7` **WebGL glyph ghosts on expand and maximize** (distinct from the 0.12.0 resize/scroll ghost fix, which is left untouched).

Minor normalizations, faithful to source: backticked the team name (`changelog`, `release-notes`) to match the file's existing convention; used American "color" to match the file (the analysis used "colour"). No em dashes, en dashes, or emoji introduced; "em and en dashes" appears only as plain words describing the auto-fix feature.

## Unresolved

None. Every proposed change in `analysis.md` was applied. The excluded commits (`a74672f`, `c1a3b33`, `62faf2e`, `af5ba5a`, `660f59c`, `1de8877`, `ebc5445`) were left out as the analysis directed, and no released/dated section was modified.
