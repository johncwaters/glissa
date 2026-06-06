## Accuracy

Re-derived the range myself: `git describe --tags --abbrev=0` = `v0.13.0`; `git log v0.13.0..HEAD --oneline`
returns 18 commits. I did not trust the Curator's mapping; I read each source commit (`git show <sha>`).

Forward (every Unreleased entry traces to a real in-range commit):

- Added "Teams: `changelog` team" -> `5201dc7` (4 stages analyst -> curator -> auditor -> announcer, reconciles
  CHANGELOG.md against git) + `295cd60` (announcer drafts on final SHIP, "drafts only, never posted" verbatim in
  the commit body, so the parenthetical is sourced, not overstated). Confirmed.
- Added "Teams: operator conversation during a run" -> `ea78189` (QUESTION sentinel, chat pane, bounded by
  maxQuestions + answerTimeoutSec). Confirmed.
- Added "Teams: project-level shared pack" -> `b68601b` (`pack.shared` from `.glissa/pack/`, voice-guide/
  avoid-list/brand filled once and reused). Confirmed.
- Added "Deterministic post-turn auto-fix on turn completion" -> `b53c1b7` (strip em/en dash + ellipsis, trim
  trailing whitespace, final newline, strip BOM, on by default) + `b88d6a8` (the card-badge report). Confirmed;
  `b53c1b7` explicitly left the card badge uncommitted and `b88d6a8` lands it, so the dual-source is correct.
- Added "Jump to the next session needing input" (`Alt+W`) -> `b88d6a8` ("Alt+W jumps to the next session that
  needs input"; WAITING is the needs-input state). Confirmed.
- Changed "Notifications delivered via browser Web Notifications" -> `b7a0481` (native browser Notification is the
  default channel, BurntToast/msg demoted to opt-in `osToast`, Desktop Notifications settings toggle). Confirmed.
- Changed "Skip-permissions (YOLO) is the session default" -> `f4bd510` (`--dangerously-skip-permissions` default
  unless project opts out, Add Session dialog inverted to opt-out "Require permission prompts", widens trust
  boundary). Confirmed.
- Changed "Legible minimized rail with peek tray" -> `b88d6a8` (status pills glyph + label + colour, fly-up peek
  tray showing the live terminal, replacing the 120px single-dot chip). Confirmed.
- Removed "Teams: standalone `release-notes` team" -> `295cd60` (release-notes team and its test retired, work
  absorbed by the changelog team's reconciliation + announcer). Confirmed.
- Fixed "Team run output stranded on its worktree branch" -> `b260ac1` (untracked header-only `log.md` blocked
  the ff-only merge-back; integrate() now clears the blocking collisions first). Confirmed.
- Fixed "Stale stage header in the Teams view" -> `b260ac1` (second fix in the same commit: header no longer
  sticks on the finished stage during the next stage's spawn). Confirmed; split into its own entry per
  one-change-per-entry.
- Fixed "Dropped terminal history on reconnect under backpressure" -> `332eb4a` (reconnect replay frame dropped
  under backpressure left history stranded; rewind sentOffset so the backfill re-pulls it). Confirmed; distinct
  from the 0.13.0 live-output backpressure fix, which is left untouched.
- Fixed "WebGL glyph ghosts on expand and maximize" -> `6bf95e7` (forced full repaint on expand/maximize clears
  stale cached glyphs). Confirmed; distinct from the 0.12.0 resize/scroll ghost fix, which is left untouched.

Reverse (every user-facing in-range commit is represented): `5201dc7`, `295cd60`, `ea78189`, `b68601b`,
`b53c1b7`, `b88d6a8` (all three halves: post-turn badge, Alt+W, minimized rail), `b7a0481`, `f4bd510`, `b260ac1`
(both fixes), `332eb4a`, `6bf95e7` are all present. No user-facing commit is missing.

Exclusions re-verified by `git show --stat`: `a74672f`, `62faf2e`, `c1a3b33`, `af5ba5a` touch only `.glissa/`
(config-excluded); `660f59c` is a single screenshot PNG (asset); `1de8877` is a merge commit; `ebc5445` is
internal dead-config cleanup whose ONLY user-visible removal (the Feed Debounce input, inspected in its
`settings-dialog.html`/`dialogs.js` diff) is already logged under [0.13.0] "Feed Debounce setting removed", and
the remaining keys (`autoRecoverSeconds`, `inputGraceSeconds`, `promptDetectionMs`) had no UI. All correctly
left out; no released section needs correction.

## Format

Matches `changelog-config.md`. Keep a Changelog 1.1.0 + SemVer header intact. `## [Unreleased]` sits at the very
top, directly above `## [0.13.0] - 2026-06-01`. Within Unreleased the `###` groups read Added, Changed, Removed,
Fixed, which is the configured relative order (Deprecated/Security simply absent). No reference link was added for
Unreleased; the bottom link block still begins at `[0.13.0]`. No duplicate entries, no mis-ordered or re-dated
versions, no orphaned headings or broken links. `git diff HEAD -- CHANGELOG.md` shows the change is confined to
the Unreleased hunk; no released, dated section was modified.

## Style

Each entry is a bold summary phrase, a colon, and a single present-tense sentence (a few carry one short
semicolon clause, which the guide permits). No first person, no "we", no "you". No banned marketing/urgency words
and no vague filler. No emoji. Ripgrep for `[\x{2014}\x{2013}\x{2026}]` over the file matched only released
sections (lines 95-350), which the style guide explicitly exempts as older-convention entries; the Unreleased
section (lines 8-33) has zero em dashes, en dashes, or ellipses. The `analyst -> curator -> auditor -> announcer`
arrows are plain ASCII (hyphen + `>`), and "em and en dashes" appears only as plain words naming the auto-fix
behavior. American "color" matches the file's existing convention.

## Summary

The Curator rebuilt a near-empty, mis-grouped Unreleased section into a complete, correctly grouped one. I
re-derived the 18-commit range from git and checked both directions: all 13 entries trace to real commits with no
fabrication or overstatement, and every user-facing commit is represented (with `b88d6a8` correctly split across
Added and Changed and `b260ac1`/`295cd60` correctly yielding two entries each). Exclusions are sound and no
released section was touched or needs correcting. Format and style conform to the pack. The Curator reported no
Unresolved items, and I found none. Ships.

VERDICT: SHIP
