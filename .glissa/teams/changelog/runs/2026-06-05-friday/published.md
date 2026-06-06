## Summary

This run reconciled the `v0.13.0..HEAD` range (18 commits, 11 user-facing) against `CHANGELOG.md`. The Unreleased section was rebuilt from two mis-grouped entries into 13 complete entries across four groups: 5 Added, 3 Changed, 1 Removed (tightened from a verbose wall), and 4 Fixed. The Auditor re-derived the range independently, verified both directions, and found no inaccuracies. The Curator left no Unresolved items and the Auditor left no caveats. No follow-up is required.

## Announcement draft

The next version number is the operator's call. The scope (new features across sessions, notifications, and teams) suggests a minor bump. The draft below uses `v0.14.0` as a placeholder; replace with the actual tag before publishing. Note: the GitHub release body is the authoritative published form; `scripts/release.js` will cut it from `CHANGELOG.md` at release time, so this draft is a sanity-check preview.

---

### GitHub release body

**Release title:** v0.14.0

This release ships new session defaults, a redesigned minimized rail, browser-native notifications, three new Teams capabilities, and four fixes since v0.13.0.

#### Added

- **Teams: `changelog` team**: A new on-demand team (analyst, curator, auditor, announcer) reconciles `CHANGELOG.md` against git history and, on a final SHIP, drafts a release announcement in the project's voice. Drafts only; never posted automatically.
- **Teams: operator conversation during a run**: A manual run can pause when a stage emits a `QUESTION` and resume once the operator answers in a chat pane, bounded by a question budget and timeout.
- **Teams: project-level shared pack**: Cross-team pack files (voice-guide, avoid-list, brand) are filled once per project under `.glissa/pack/` and reused by every team that declares them as shared, so multi-team projects fill the shared config once instead of once per team.
- **Deterministic post-turn auto-fix on turn completion**: When a session completes a turn, Glissa runs text-hygiene fixes over its git-changed files (strip em and en dashes and ellipses, trim trailing whitespace, ensure a final newline, strip a UTF-8 BOM) and reports the result on the card. On by default.
- **Jump to the next session needing input**: `Alt+W` moves focus to the next session in the `WAITING` state.

#### Changed

- **Notifications delivered via browser Web Notifications**: Notifications now raise a native browser notification by default. The BurntToast/msg path is demoted to opt-in via `osToast`, and a Desktop Notifications settings toggle gates the new channel.
- **Skip-permissions (YOLO) is the session default**: New sessions spawn with `--dangerously-skip-permissions` unless their project opts out. The Add Session dialog now shows an opt-out "Require permission prompts" instead of an opt-in flag.
- **Legible minimized rail with peek tray**: Minimized cards are now status pills (glyph, label, and color) with a fly-up peek tray that shows the live terminal, replacing the single-dot 120px chip.

#### Removed

- **Teams: standalone `release-notes` team**: Removed. Its git-range research and GitHub release draft are now covered by the `changelog` team's reconciliation and announcer.

#### Fixed

- **Team run output stranded on its worktree branch**: An untracked header-only `log.md` blocked the fast-forward merge-back of a finished run. The merge-back now clears blocking collisions first so the run lands in the project.
- **Stale stage header in the Teams view**: The run header no longer sticks on the finished stage while the next stage spawns.
- **Dropped terminal history on reconnect under backpressure**: A reconnect replay frame dropped under backpressure left scrollback history stranded. The drop now rewinds the send offset so the backfill re-pulls the missed history.
- **WebGL glyph ghosts on expand and maximize**: Expanding or maximizing a card now forces a full repaint, clearing stale cached glyphs.

---

### X / Twitter post

Glissa v0.14.0: sessions now run with skip-permissions on by default, and notifications go through the browser instead of BurntToast. The minimized rail is redesigned into status pills with a live peek tray. https://github.com/johncwaters/glissa
