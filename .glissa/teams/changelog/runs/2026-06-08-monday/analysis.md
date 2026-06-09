## Topic

Unreleased reconcile (10 commits since v0.14.0; 7 user-facing and missing, 3 of them merge into one entry, 1 correctly excluded).

## Range

`v0.14.0..HEAD` = `3aa4eb4..98d3875`, 10 commits.

Derivation: `pack/changelog-config.md` says reconcile `<latest tag>..HEAD` where the latest tag comes from `git describe --tags --abbrev=0`. That returns `v0.14.0` (the config's "currently v0.13.0" note is stale; the live tag is authoritative). The `v0.14.0` tag points at commit `3aa4eb4` ("chore(release): fold the WAITING-merge fix into the 0.14.0 changelog", 2026-06-08 07:16). All 10 in-range commits land strictly after that tag, so they belong in `Unreleased`, not in the already-dated `[0.14.0]` section.

## Current state

- Format: Keep a Changelog 1.1.0 + SemVer 2.0.0, versions newest first, per-version reference links at the bottom. Conforms to the pack.
- Newest section: `[0.14.0] - 2026-06-08` (the Focus rework), fully written and matching its tag. Its reference link is present.
- `## [Unreleased]` exists at the very top but is EMPTY. That is the expected post-release state, but it is now stale: 10 commits have landed since the tag, 7 of them user-facing or notable.
- No structural defects: no mis-ordered versions, no duplicates, no stale heading, no wrong reference links. The only gap is the empty `Unreleased`.
- None of the 10 post-tag commits is already represented in `[0.14.0]` (checked: the 0.14.0 post-turn auto-fix and review-sidebar entries are distinct features from the post-tag slop detector and pinned-controls work). No cross-section duplication.

## Discrepancies

All discrepancies are MISSING entries, because `Unreleased` is empty. Each traces to a post-tag commit.

- MISSING (e3610d3, lever A): the report-only `slop` post-turn code-slop detector (card-badge surfaced, opt-in `rules.slop`, default off) is not in the changelog.
- MISSING (e3610d3, lever B): the opt-in `antiSlopPrompt` preventive system-prompt note (user sessions only, default off) is not in the changelog. Per the style guide's "one change per entry", this commit did two user-facing things and gets two entries.
- MISSING (98d3875): the review sidebar's Merge / Resolve / Discard controls are now pinned (do not scroll out of reach) and Merge is always rendered (disabled with a reason when not actionable). Not in the changelog.
- MISSING (5d13157): the worktree badge now appears on fresh spawn, not only after a page reload. Not in the changelog.
- MISSING (fd2b53d): the Merge button now appears the instant a turn ends, not only after clicking a review file. Not in the changelog.
- MISSING (767b48c + 39d9dab + 2313cea): the roster rail's attention-queue head (Alt+W) now shows a discoverable, complete resting placeholder instead of a hidden/half-finished box, and spends its accent only when something needs attention. These three are successive iterations on the same element; the final state is one change and gets ONE merged entry sourced to all three shas, not three near-duplicate bullets.
- MISSING (86ccf12): worktree git probes and per-turn post-turn checks moved off the shared event loop (sync -> async), removing the freeze/buffer stalls on slower machines. Notable performance work, not in the changelog.
- MISSING (3cb0f77): the 10s cross-session worktree liveness poll replaced by an integration-branch reflog watcher (event-driven, no recurring git spend, gates stay fresh server-side without a dashboard). Notable performance work, not in the changelog.

Correctly excluded (no discrepancy):

- ea64bcd ("chore: update screenshot"): touches only `assets/pictures/glissa-screenshot.png`. Chore / asset-only, no user-visible behavior. Excluded per the pack.

## Proposed changes

Add the following entries under `## [Unreleased]` (create the group headings in Keep a Changelog order: Added, then Changed, then Fixed, then Performance). Wording is terse, present-tense, bold summary + one sentence, no dashes, per the style guide.

Under `### Added`:

- **Code-slop detector**: An opt-in, report-only post-turn `slop` rule flags AI code-slop patterns (swallowed exceptions, narration-opener comments, placeholder stubs, debug leftovers, type escapes) and surfaces the count on the session card; off by default via `rules.slop`. (e3610d3)
- **Preventive anti-slop prompt**: An opt-in `antiSlopPrompt` appends a fixed anti-slop note to a user session's system prompt at spawn (team and pack-setup stages are excluded); off by default. (e3610d3)

Under `### Changed`:

- **Pinned review sidebar controls**: The review sidebar's Merge, Resolve in session, and Discard controls sit in a pinned region that stays in view as the diff scrolls, and Merge is always shown while a session is selected, disabled with a one-line reason when it cannot run. (98d3875)

Under `### Fixed`:

- **Worktree badge on fresh spawn**: A session's worktree badge appears the moment its worktree is provisioned, instead of only after a page reload. (5d13157)
- **Merge button on turn end**: The Merge button appears the instant a session finishes its turn, instead of only after clicking a review file to expand it. (fd2b53d)
- **Discoverable Alt+W attention-queue placeholder**: The roster rail's attention-queue head shows a persistent resting placeholder (a dim Alt+W hint with an "ALL CLEAR" label in a neutral box) and earns its accent only when sessions need attention, so the shortcut is discoverable and the resting head no longer reads as half-finished. (767b48c, 39d9dab, 2313cea)

Under `### Performance`:

- **Worktree git work off the event loop**: Worktree git probes and per-turn post-turn checks run as async, non-blocking work instead of synchronous calls on the shared event loop, so a session doing git work no longer freezes or buffers the others on slower machines; a `liveWorktreeReview` kill-switch can drop the backstop entirely. (86ccf12)
- **Event-driven worktree detection**: The 10-second cross-session worktree liveness poll is replaced by an integration-branch reflog watcher, removing the recurring git spend and keeping merge gates fresh server-side even with no dashboard open. (3cb0f77)

Notes for the Curator:

- Confine all edits to `Unreleased`; do not touch `[0.14.0]` or any dated version, and do not add a reference link for `Unreleased`.
- The `slop` detector (e3610d3) is deliberately split into two entries (detection + prevention) per the one-change-per-entry rule.
- The three rail-head commits are deliberately one merged Fixed entry; do not write three bullets.
- `liveWorktreeReview` is introduced across both performance commits; mention it once, on the off-the-event-loop entry, as above.
- Two arguable classifications, flagged not blocked: the pinned-controls entry could read as Fixed ("Merge scrolled out of reach") rather than Changed; the merged rail-head entry is presentation-heavy and could read as Changed rather than Fixed. The proposed buckets above are the recommended call.

## Sources

Every proposed change traces to a commit in `v0.14.0..HEAD`:

- e3610d3 - feat: opt-in code-slop detector and preventive anti-slop prompt -> Added (two entries: Code-slop detector; Preventive anti-slop prompt).
- 98d3875 - feat(review): pin the sidebar controls so Merge is always reachable -> Changed (Pinned review sidebar controls).
- 5d13157 - fix(review): show the worktree badge on fresh spawn, not just after reload -> Fixed (Worktree badge on fresh spawn).
- fd2b53d - fix(review): show the Merge button when the turn ends, not on the next click -> Fixed (Merge button on turn end).
- 767b48c - fix(focus): show the Alt+W placeholder on the resting rail head -> Fixed (Discoverable Alt+W attention-queue placeholder, merged).
- 39d9dab - fix(focus): give the resting Alt+W placeholder the full box, not bare keys -> Fixed (same merged entry).
- 2313cea - fix(focus): make the rail head a complete quiet-vs-earned attention readout -> Fixed (same merged entry).
- 86ccf12 - perf: move worktree git probes + post-turn checks off the event loop -> Performance (Worktree git work off the event loop).
- 3cb0f77 - perf(review): event-driven worktree detection, drop the 10s poll -> Performance (Event-driven worktree detection).
- ea64bcd - chore: update screenshot -> EXCLUDED (asset-only chore, no proposed change).
