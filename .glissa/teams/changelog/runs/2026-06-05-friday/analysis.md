## Topic

Unreleased reconcile (18 commits since v0.13.0): 10 user-facing changes missing from `Unreleased`, 1
present but mis-categorized, 7 correctly excluded. The `Unreleased` section currently logs only the
announcer fold-in and is otherwise empty, so almost a full release of work is undocumented.

## Range

- Analyzed `v0.13.0..HEAD`.
- Derivation: `git describe --tags --abbrev=0` returns `v0.13.0` (the configured latest tag); the config
  sets the range to `<latest tag>..HEAD`. `v0.13.0` resolves to commit `09b61da`
  ("chore(release): finalize 0.13.0 changelog with post-bump work", 2026-06-01). HEAD is `b88d6a8`
  ("feat(sessions): legible minimized rail with fly-up peek tray", 2026-06-05).
- Topology note: four in-range commits (`ebc5445` 2026-05-29, `6bf95e7` / `660f59c` / `332eb4a`
  2026-06-01) carry dates at or before the tag date but are NOT ancestors of `v0.13.0`. They sit on a
  side branch that was merged into the tagged line via merge commit `1de8877`, so `v0.13.0..HEAD`
  correctly includes them. The merge's own conflict list (`config-store.js`,
  `public/components/settings-dialog.html`, `public/dialogs.js`) confirms `ebc5445`'s removals were
  reconciled at that merge.

## Current state

- Format is Keep a Changelog 1.1.0 + SemVer, matching `pack/changelog-config.md`. Version headings are
  `## [x.y.z] - YYYY-MM-DD`, newest first, with bottom reference links per released version. This is
  correct and well-formed.
- Newest section is `## [Unreleased]`, sitting above `## [0.13.0] - 2026-06-01`. Correct placement.
- `Unreleased` holds exactly two entries, both tracing to a single commit (`295cd60`):
  - `### Changed` "the changelog team now also drafts release announcements"
  - `### Removed` "the standalone release-notes team"
- Structural problems:
  1. `Unreleased` is grossly incomplete: 10 user-facing commits since v0.13.0 are absent (the new
     `changelog` team, the team operator-conversation loop, the shared project pack, the post-turn
     auto-fix, Web Notifications, YOLO-by-default, the redesigned minimized rail, plus three fixes).
  2. The lone `### Changed` entry describes the `changelog` team's announcer as a change to an existing
     team, but that team's own introduction (`5201dc7`) is itself unreleased and unlogged. Within one
     `Unreleased` window the team and its announcer should read as a single Added feature, not a
     change to a released one.
  3. There is no `### Added` group, which by the configured group order must come first.
  4. Both existing `Unreleased` entries are multi-sentence walls that exceed the new-entry length the
     style guide allows (terse bold-summary-plus-one-sentence). The `### Removed` entry is factually
     correct (the `release-notes` team shipped in 0.13.0 and is now gone); it just needs tightening.

## Discrepancies

- MISSING `5201dc7` and `295cd60` (announcer): the `changelog` team itself (analyst -> curator ->
  auditor -> announcer, reconciles CHANGELOG.md against git and drafts an announcement on SHIP) is not
  recorded under Added. Only its later announcer tweak is mentioned.
- MISCATEGORIZED `295cd60`: the existing `### Changed` "changelog team now also drafts release
  announcements" presupposes a released team. Since the team is unreleased, this is part of the Added
  feature, not a Changed-to-existing. It will also duplicate the proposed Added entry if both remain.
- MISSING `ea78189`: the operator-conversation pause/resume loop for manual team runs (QUESTION
  sentinel, chat pane, bounded budget) is undocumented.
- MISSING `b68601b`: project-level shared team pack (`pack.shared` resolving from `.glissa/pack/`, fill
  once and reuse across teams) is undocumented.
- MISSING `b53c1b7` (+ `b88d6a8` for the card badge): deterministic post-turn auto-fix on COMPLETE
  (strip em/en dashes and ellipses, trim trailing whitespace, ensure final newline, strip BOM; on by
  default; result broadcast to the card) is undocumented.
- MISSING `b7a0481`: notifications now delivered as native browser Web Notifications by default, with
  BurntToast/msg demoted to opt-in `osToast` and a new Desktop Notifications settings toggle. This
  changes a user-visible behavior shipped in 0.13.0 and earlier; undocumented.
- MISSING `f4bd510`: skip-permissions (YOLO) is now the session default (sessions spawn
  `--dangerously-skip-permissions` unless the project opts out; Add Session dialog inverted to an
  opt-out "Require permission prompts"). User-visible default and trust-boundary change; undocumented.
- MISSING `b88d6a8`: the minimized bar is redesigned into legible status pills with a fly-up peek tray
  (replacing the single-dot 120px chip), and `Alt+W` jumps to the next session needing input. Two
  distinct user-facing changes; undocumented.
- MISSING `b260ac1`: a finished team run was stranded on its throwaway worktree branch because an
  untracked header-only `log.md` blocked the fast-forward merge-back; the merge-back now clears the
  blocking collisions first. (Same commit also fixes a stale stage header in the Teams view.)
  Undocumented.
- MISSING `332eb4a`: on reconnect under backpressure, the replay frame's historical bytes were dropped
  and stranded (sentOffset left un-rewound) until Claude's next full repaint; the drop branch now
  rewinds sentOffset so the backfill re-pulls the missed history. Undocumented. (Distinct from the
  0.13.0 "Recover dropped terminal output in place after backpressure" entry, which covered live
  output, not the reconnect replay frame.)
- MISSING `6bf95e7`: expanding or maximizing a card left stale WebGL glyph ghosts; a forced
  full-viewport repaint now clears them. (Distinct from the 0.12.0 resize/scroll ghost fix.)
  Undocumented.

No DUPLICATE or MISORDERED entries exist among current content beyond the Added-group ordering gap noted
above. No released (dated) section is inaccurate: `ebc5445`'s only user-visible removal (the Feed
Debounce input) is already logged under [0.13.0] "Feed Debounce setting removed"; its other removed keys
(`autoRecoverSeconds`, `inputGraceSeconds`, `promptDetectionMs`) were already-inert dead config with no
remaining UI, so no released-section correction is warranted.

## Proposed changes

Confine all edits to `Unreleased`. Create the missing `### Added` group first, then `### Changed`,
`### Removed`, `### Fixed` in the configured order. Keep each entry terse (bold summary, colon, one
present-tense sentence). Concretely:

Added (new group, at the top of `Unreleased`):

- **Teams: changelog team**: A new on-demand team (analyst -> curator -> auditor -> announcer)
  reconciles `CHANGELOG.md` against git history and, on a final SHIP, drafts a release announcement in
  the project's voice. (Sources `5201dc7`, `295cd60`; fold the existing `### Changed` announcer entry
  here.)
- **Teams: operator conversation during a run**: A manual run can pause when a stage emits a
  `QUESTION` and resume once the operator answers in a chat pane, bounded by a question budget and
  timeout. (Source `ea78189`.)
- **Teams: project-level shared pack**: Cross-team pack files (voice-guide, avoid-list, brand) are
  filled once per project under `.glissa/pack/` and reused by every team that declares them as shared.
  (Source `b68601b`.)
- **Deterministic post-turn auto-fix on turn completion**: When a session completes a turn, Glissa
  runs auto-fixable text hygiene over its git-changed files (strip em and en dashes and ellipses, trim
  trailing whitespace, ensure a final newline, strip a UTF-8 BOM) and reports the result on the card;
  on by default. (Sources `b53c1b7`, `b88d6a8`.)
- **Jump to the next session needing input**: `Alt+W` moves focus to the next session in the
  WAITING state. (Source `b88d6a8`.)

Changed:

- **Notifications delivered via browser Web Notifications**: Notifications now raise a native browser
  notification by default; the BurntToast/msg path is demoted to opt-in via `osToast`, and a Desktop
  Notifications settings toggle gates the new channel. (Source `b7a0481`.)
- **Skip-permissions (YOLO) is the session default**: New sessions spawn with
  `--dangerously-skip-permissions` unless their project opts out, and the Add Session dialog now
  offers an opt-out "Require permission prompts" (widening the localhost-only trust boundary).
  (Source `f4bd510`.)
- **Legible minimized rail with peek tray**: Minimized cards are now status pills (glyph plus label
  plus colour) with a fly-up peek tray that shows the live terminal, replacing the single-dot 120px
  chip. (Source `b88d6a8`.)

Removed:

- Keep the existing release-notes removal, tightened to one terse sentence: **Teams: standalone
  release-notes team**: Removed; its git-range research and GitHub-release draft are now covered by the
  `changelog` team's reconciliation and announcer. (Source `295cd60`.)

Fixed:

- **Team run output stranded on its worktree branch**: An untracked header-only `log.md` blocked the
  fast-forward merge-back of a finished run; the merge-back now clears the blocking collisions first so
  the run lands in the project. (Source `b260ac1`.)
- **Stale stage header in the Teams view**: The run header no longer sticks on the finished stage
  while the next stage spawns. (Source `b260ac1`; optional, minor.)
- **Dropped terminal history on reconnect under backpressure**: A reconnect replay frame dropped under
  backpressure left scrollback history stranded; the drop now rewinds the send offset so the backfill
  re-pulls the missed history. (Source `332eb4a`.)
- **WebGL glyph ghosts on expand and maximize**: Expanding or maximizing a card now forces a full
  repaint, so stale cached glyphs no longer linger. (Source `6bf95e7`.)

Edits to make (for the Curator):

1. Add the `### Added` group above the existing `### Changed`, with the five Added entries above.
2. Remove the current `### Changed` "the changelog team now also drafts release announcements" entry;
   its content is folded into the new "Teams: changelog team" Added entry.
3. Replace the current `### Changed` group with the three Changed entries above (Web Notifications,
   YOLO default, minimized rail).
4. Tighten the existing `### Removed` entry to the terse form above.
5. Add a `### Fixed` group (after Removed) with the four Fixed entries above.
6. Do not touch any dated, released section; do not add a reference link for `Unreleased`.

Excluded (do not log), with rationale:

- `a74672f` (chore: add changelog team), `c1a3b33` (chore: release pipeline team setup),
  `62faf2e` and `af5ba5a` (generated team run output): touch only `.glissa/`, excluded by config.
- `660f59c` (chore: update screenshot): asset only.
- `1de8877`: merge commit.
- `ebc5445` (remove dead scraping-era config keys): its only user-visible removal (Feed Debounce input)
  is already logged in [0.13.0]; the remaining keys were inert dead config with no UI. Internal
  cleanup, not user-facing.

## Sources

Every proposed change traces to one or more of these commits:

- `5201dc7` feat(teams): add a changelog team that reconciles the changelog with git history -> Added (changelog team).
- `295cd60` refactor(teams): fold release-notes into the changelog team as an announcer -> Added (changelog team announcer), Removed (release-notes team).
- `ea78189` feat(teams): add an operator conversation with an agent-question pause/resume loop -> Added (operator conversation).
- `b68601b` feat(teams): project-level shared pack reused across teams -> Added (shared pack).
- `b53c1b7` feat(sessions): deterministic post-turn auto-fix on COMPLETE -> Added (post-turn auto-fix).
- `b88d6a8` feat(sessions): legible minimized rail with fly-up peek tray -> Added (post-turn card badge, Alt+W next-needs-input), Changed (legible minimized rail).
- `b7a0481` feat(notifications): deliver via browser Web Notifications instead of BurntToast -> Changed (Web Notifications default).
- `f4bd510` feat(sessions): make skip-permissions (YOLO) the default for sessions -> Changed (YOLO default).
- `b260ac1` fix(teams): clear untracked collisions so a run's output merges back -> Fixed (merge-back), Fixed (stale stage header).
- `332eb4a` fix(ws-sender): recover dropped replay history by rewinding sentOffset on backpressure drop -> Fixed (dropped reconnect history).
- `6bf95e7` fix(session-card): force terminal repaint on expand/maximize to clear WebGL ghosts -> Fixed (WebGL ghosts).

No PR numbers appear in any in-range commit subject; the shas above are the sole trace.
