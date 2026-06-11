## Edited

`CHANGELOG.md` at the repository root. Keep a Changelog 1.1.0 + SemVer, version headings newest-first, `Unreleased` at the top. Group order Added, Changed, Fixed, Performance.

## Changes applied

Populated the empty `## [Unreleased]` section with 10 entries. The released `0.15.0`, `0.14.0`, and all older sections were not touched. The bottom reference-link list was not touched. Every entry is a bold noun phrase, a colon, one present-tense sentence, no first/second person, no dashes.

### Added (3 new entries)

- **Manage an installed Headroom proxy from the dashboard** (`25b7052`): headroomEasyStart supervisor, detect/start/stop/restart from header chip, fills `proxyBaseUrl`, off by default, dim install hint.
- **Headroom proxy savings on the dashboard** (`1ccb076`): header pill with tokens removed and savings percent, tooltip breakdown, click-through.
- **Resizable session rail** (`c96487a`): drag handle clamped 180 to 480px, width persisted per browser, arrow-key nudge, double-click reset.

### Changed (2 new entries)

- **Switching sessions clears a completed session's alert** (`137f5d9`): a Focus shortcut / rail-pill switch returns a COMPLETE session to IDLE; WAITING never dismissed on switch.
- **Unified navbar status indicators** (`f3072fa`, `1f9c6fa`): connection status, Headroom chip, and aggregate readout share one chip shell and a quieter resting style. One visual change traced across the two commits, written as a single entry per the one-change-one-entry rule.

### Fixed (1 new entry)

- **Terminal bottom row clipped on some displays** (`8613ec8`): fit measured the wrong element, clipping the bottom TUI row; padding moved to the measured element.

### Performance (4 new entries)

- **Worktree git engine runs off the event loop** (`4759ad4`): provision/rebase/merge-back/discard now async subprocess calls, merges serialized. Worded to distinguish from 0.15.0's existing "Worktree git work off the event loop" (`86ccf12`), which moved the git probes and post-turn checks; this moves the engine/merge operations.
- **Async session process termination** (`3ec3c42`): Windows `taskkill` on kill/exit paths made async.
- **Skip the health snapshot when no dashboard is open** (`cf7b40b`): 10s snapshot not built or broadcast with no control client connected.
- **Lighter dashboard rendering** (`f89008e`, `a968ba5`): hidden-view render gating, pill ref caching, render-scheduler queue-array reuse + read cursor. Same render subsystem across two commits, kept both shas in one entry.

I kept the four Performance entries separate (the analysis allowed optional consolidation); they are distinct mechanisms and separate entries read more honestly than a single bundled bullet.

## Unresolved

- **Optional 0.15.0 reference link (traces to `bd0ba25`)**: NOT applied. The analysis flagged it as operator-gated: adding `[0.15.0]: https://github.com/johncwaters/glissa/releases/tag/v0.15.0` is only correct if the operator intends 0.15.0 to read as released, and the link will 404 until a `v0.15.0` git tag is cut (latest tag is `v0.14.0`, no `v0.15.0` exists). The pack's range/versioning rules say this team does not cut releases and a reference link is added "only when a release cuts a new dated version." No operator decision to treat 0.15.0 as released is present in the run context, so applying the link would risk introducing a dead link and pre-empting the release process. Left out per the hard rule against guessing operator-gated structural changes. Auditor: confirm whether to apply, or leave 0.15.0 provisional with no link (current state).

All other proposed changes were applied.
