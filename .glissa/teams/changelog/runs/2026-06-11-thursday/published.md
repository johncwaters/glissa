## Summary

This run reconciled the range `v0.14.0..HEAD` (12 user-facing commits) against the `Unreleased` section
of `CHANGELOG.md`, which was empty at the start. Ten entries were added: three new features, two behavior
changes, one bug fix, and four performance improvements. The released `0.15.0` section and all older
sections were not touched.

One follow-up for the operator: the dated `0.15.0` section in the changelog has no matching `[0.15.0]`
reference link at the bottom. The Curator withheld the link because no `v0.15.0` git tag exists yet
(latest tag is `v0.14.0`), and the Auditor confirmed this was correct. Once the operator cuts the
`v0.15.0` tag, the reference link `[0.15.0]: https://github.com/johncwaters/glissa/releases/tag/v0.15.0`
can be added above `[0.14.0]` in a follow-up changelog commit.

## Announcement draft

Proposed release: **v0.16.0** / tag `v0.16.0`

Confirm the version before tagging. The Unreleased section adds new features on top of 0.15.0, making this
a minor increment under SemVer. The actual release body will be cut from `CHANGELOG.md` by
`scripts/release.js`; this draft is a preview for the operator to sanity-check.

---

### GitHub release body

**v0.16.0**

This release adds Headroom proxy management and savings reporting to the dashboard, a resizable session
rail, and a set of event-loop improvements that reduce stutter and background overhead when running
multiple sessions at once.

#### Added

- **Manage an installed Headroom proxy from the dashboard**: An opt-in `headroomEasyStart` setting lets
  Glissa detect the `headroom` CLI and start, stop, or restart a local `headroom proxy` from a header
  chip, with a shortcut that fills `proxyBaseUrl`; off by default, and the chip shows a dim install hint
  when Headroom is not installed.
- **Headroom proxy savings on the dashboard**: While the proxy runs, a header pill shows tokens removed
  and savings percent (request count before compression starts), with a tooltip cost breakdown and a
  click-through to the proxy's own dashboard.
- **Resizable session rail**: A drag handle between the roster rail and the center resizes the rail
  (clamped 180 to 480px), with the width persisted per browser; arrow keys nudge the handle and a
  double-click resets it.

#### Changed

- **Switching sessions clears a completed session's alert**: Switching to a session through the Focus
  shortcuts or a rail-pill click now returns a COMPLETE session to IDLE, instead of leaving it COMPLETE
  until its terminal is clicked; a WAITING session is never dismissed on a switch.
- **Unified navbar status indicators**: The connection status, Headroom chip, and aggregate readout now
  share one chip shell and a quieter resting style, where a healthy state shows only its dot and label
  color is reserved for states that need attention.

#### Fixed

- **Terminal bottom row clipped on some displays**: The centered terminal sized its fit from the wrong
  element and overstated the available space, cutting off the bottom TUI row at some font metrics and
  display scales; the padding now lives on the measured element so the bottom edge stays on screen.

#### Performance

- **Worktree git engine runs off the event loop**: Worktree provision, rebase, merge-back, and discard
  now run as async subprocess calls, with merges into a shared branch serialized, so a session doing git
  work no longer blocks or stutters the other sessions' terminals.
- **Async session process termination**: The Windows `taskkill` on a session's kill and exit paths now
  runs asynchronously instead of blocking the shared event loop.
- **Skip the health snapshot when no dashboard is open**: The 10-second health snapshot is no longer
  built or broadcast when no dashboard tab is connected.
- **Lighter dashboard rendering**: The dashboard skips rendering hidden views, caches roster pill
  references, and the render scheduler reuses its queue array and advances by a read cursor, cutting
  per-render work.

---

### X / Twitter post

v0.16.0: manage a local Headroom proxy from the dashboard and see live token savings, resize the session
rail, and four event-loop fixes so sessions stop stuttering each other.
https://github.com/johncwaters/glissa
