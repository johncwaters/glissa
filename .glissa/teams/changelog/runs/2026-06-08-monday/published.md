## Summary

This run reconciled `v0.14.0..HEAD` (10 commits, 2026-06-08). The `Unreleased` section was empty after the v0.14.0 release cut; 8 entries were added across Added, Changed, Fixed, and Performance groups, covering all 9 user-facing commits in range (one commit split into two entries per one-change-per-entry; three successive rail-head polish commits merged into one). The screenshot-only chore commit was correctly excluded. No unresolved items were reported by the Curator or flagged by the Auditor; the run ships clean with no follow-up required.

## Announcement draft

Proposed tag and release title: **v0.15.0**

(The actual version number is the operator's call at release time. The entries below are the Unreleased content the release script will draw from `CHANGELOG.md`. This draft is for review only; no tag has been created or pushed.)

---

### GitHub release body

**v0.15.0**

#### Added

- **Code-slop detector**: An opt-in, report-only post-turn `slop` rule flags AI code-slop patterns (swallowed exceptions, narration-opener comments, placeholder stubs, debug leftovers, type escapes) and surfaces the count on the session card; off by default via `rules.slop`.
- **Preventive anti-slop prompt**: An opt-in `antiSlopPrompt` appends a fixed anti-slop note to a user session's system prompt at spawn (team and pack-setup stages are excluded); off by default.

#### Changed

- **Pinned review sidebar controls**: The review sidebar's Merge, Resolve in session, and Discard controls sit in a pinned region that stays in view as the diff scrolls, and Merge is always shown while a session is selected, disabled with a one-line reason when it cannot run.

#### Fixed

- **Worktree badge on fresh spawn**: A session's worktree badge appears the moment its worktree is provisioned, instead of only after a page reload.
- **Merge button on turn end**: The Merge button appears the instant a session finishes its turn, instead of only after clicking a review file to expand it.
- **Discoverable Alt+W attention-queue placeholder**: The roster rail's attention-queue head shows a persistent resting placeholder (a dim Alt+W hint with an "ALL CLEAR" label in a neutral box) and earns its accent only when sessions need attention, so the shortcut is discoverable and the resting head no longer reads as half-finished.

#### Performance

- **Worktree git work off the event loop**: Worktree git probes and per-turn post-turn checks run as async, non-blocking work instead of synchronous calls on the shared event loop, so a session doing git work no longer freezes or buffers the others on slower machines; a `liveWorktreeReview` kill-switch can drop the backstop entirely.
- **Event-driven worktree detection**: The 10-second cross-session worktree liveness poll is replaced by an integration-branch reflog watcher, removing the recurring git spend and keeping merge gates fresh server-side even with no dashboard open.

---

### X / Twitter post

Glissa v0.15.0: pinned review sidebar controls, two opt-in code-slop tools (detector + anti-slop prompt), several worktree review fixes, and worktree git work moved off the event loop. https://github.com/johncwaters/glissa
