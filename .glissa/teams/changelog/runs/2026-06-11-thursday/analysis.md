## Topic

Unreleased reconcile: `## [Unreleased]` is empty, but 12 user-facing commits have landed since the (untagged) 0.15.0 cut. Range `v0.14.0..HEAD`.

## Range

- Base..head: `v0.14.0..HEAD` (head = `acb16e1`).
- Derivation: `git describe --tags --abbrev=0` returns `v0.14.0` (the latest tag). The pack's `changelog-config.md` range rule is `<latest tag>..HEAD`; its parenthetical "(currently `v0.13.0`)" is stale and was overridden by the live `git describe` output.
- Important: there is no `v0.15.0` git tag. The changelog already carved a dated `## [0.15.0] - 2026-06-10` section out of this range (created by `bd0ba25`, "bump version to v0.15.0"), so the reconcile target is the `Unreleased` section, that is, the part of `v0.14.0..HEAD` that is NOT already documented in the released 0.15.0 section. The 0.15.0 section itself is treated as a settled, released record (dated version, not renumbered or restyled).

## Current state

- Format: Keep a Changelog 1.1.0 + SemVer, version headings newest-first, `Unreleased` at the top. Group order and the project's extra Performance/Tests/Docs groups are followed. This is correct.
- Newest section: `## [Unreleased]` (empty), then `## [0.15.0] - 2026-06-10`, then `## [0.14.0] - 2026-06-08`. Ordering and dates are correct.
- Structural problems:
  1. `Unreleased` is empty but 12 user-facing commits have shipped since the 0.15.0 bump (`bd0ba25`), so the changelog understates current work. This is the main gap.
  2. `0.15.0` is a dated (released-shaped) section with NO matching git tag (latest tag is `v0.14.0`), and the bottom reference-link list stops at `[0.14.0]`. Per the file's own format rule ("a link is added only when a release cuts a new dated version"), the dated 0.15.0 should carry a reference link; it does not. Flagged below, but operator-gated because the link target `releases/tag/v0.15.0` will 404 until the tag is actually cut, which is outside this team's scope.
- The 0.15.0 section content was spot-checked against its source commits (proxyBaseUrl `62327f7`, park-to-dormant `47a7c99`, pending-wakeup chip `3299927`, resizable review sidebar `150add9`/`a70cc55`, code-slop/anti-slop `e3610d3`, the review fixes, and the two Performance items `86ccf12`/`3cb0f77`) and is accurate for its scope. No edits proposed to 0.15.0 except the optional reference link.

## Discrepancies

All shas below are in `v0.14.0..HEAD` and absent from both `Unreleased` and the 0.15.0 section.

- MISSING `25b7052` (feat headroom): Headroom-proxy easy-start supervisor (detect CLI, start/stop/restart `headroom proxy` from a header chip, `headroomEasyStart`/`headroomPort` settings, "use for sessions" fills `proxyBaseUrl`). Committed before the 0.15.0 bump but omitted from 0.15.0.
- MISSING `137f5d9` (feat focus): switching sessions via Focus shortcuts / rail-pill click now dismisses a COMPLETE session to IDLE. Committed before the 0.15.0 bump but omitted from 0.15.0.
- MISSING `1ccb076` (feat headroom): Headroom savings analytics pill (tokens removed, savings percent, tooltip breakdown, click-through) on the dashboard chip. Post-bump.
- MISSING `c96487a` (feat focus): resizable session rail with persisted width. Post-bump.
- MISSING `8613ec8` (fix focus): centered terminal bottom row clipped on some displays/scales; padding moved to the element FitAddon measures. Post-bump.
- MISSING `f3072fa` + `1f9c6fa` (style header): navbar status indicators (connection status, Headroom chip, aggregate readout) unified into one chip shell and quieter resting visual language. One visual change across two commits. Post-bump. (Borderline: pure CSS, but the project logs visual-hardening passes, for example 0.13.0 "Sessions view visual hardening" and 0.14.0 "reads as a work surface", so it is in-scope.)
- MISSING `4759ad4` (perf sessions): worktree git ENGINE (provision/rebase/merge-back/discard) converted to async subprocess calls with serialized merges, off the event loop. Post-bump. Note: distinct from 0.15.0's "Worktree git work off the event loop" (`86ccf12`), which moved the git PROBES and post-turn checks; this moves the engine/merge operations. Worth a separate entry, worded to distinguish.
- MISSING `3ec3c42` (perf sessions): Windows `taskkill` on kill/exit paths made async (off the event loop). Post-bump.
- MISSING `cf7b40b` (perf backend): the 10s health snapshot is skipped (not built or broadcast) when no control client is connected. Post-bump.
- MISSING `f89008e` + `a968ba5` (perf frontend/render): dashboard render-path work (hidden-view render gating, pill ref caching, render-scheduler chunk-array reuse + read-index cursor, dead `placePill` removed). Same render subsystem across two commits. Post-bump.
- INACCURATE (structural) bottom reference-link list, traces to `bd0ba25`: the dated `0.15.0` section has no `[0.15.0]` reference link, violating the file's stated link convention. Operator-gated (no `v0.15.0` tag exists yet).

Correctly excluded (not proposed): `bd0ba25` (release/version bump), `ea64bcd` (screenshot chore), `2c97f88` (prior `changelog: ... (SHIP)` maintenance commit), `c6e221f` (regenerate AGENTS.md, internal contributor doc), `acb16e1` (add `QA_REPORT.md`, internal verification record, not product docs), `cefc850` (swallow a settled-branch reset rejection: internal robustness, test-only contract, no observable behavior change on the happy path).

## Proposed changes

Add a populated `## [Unreleased]` section (do not touch 0.15.0 or below, except the optional link in the last item). Use the project's group order: Added, Changed, Fixed, Performance.

### Added

- **Manage an installed Headroom proxy from the dashboard**: An opt-in `headroomEasyStart` setting lets Glissa detect the `headroom` CLI and start, stop, or restart a local `headroom proxy` from a header chip, with a shortcut that fills `proxyBaseUrl`; off by default, and the chip shows a dim install hint when Headroom is not installed. (`25b7052`)
- **Headroom proxy savings on the dashboard**: While the proxy runs, a header pill shows tokens removed and savings percent (request count before compression starts), with a tooltip cost breakdown and a click-through to the proxy's own dashboard. (`1ccb076`)
- **Resizable session rail**: A drag handle between the roster rail and the center resizes the rail (clamped 180 to 480px), with the width persisted per browser; arrow keys nudge the handle and a double-click resets it. (`c96487a`)

### Changed

- **Switching sessions clears a completed session's alert**: Switching to a session through the Focus shortcuts or a rail-pill click now returns a COMPLETE session to IDLE, instead of leaving it COMPLETE until its terminal is clicked; a WAITING session is never dismissed on a switch. (`137f5d9`)
- **Unified navbar status indicators**: The connection status, Headroom chip, and aggregate readout now share one chip shell and a quieter resting style, where a healthy state shows only its dot and label color is reserved for states that need attention. (`f3072fa`, `1f9c6fa`)

### Fixed

- **Terminal bottom row clipped on some displays**: The centered terminal sized its fit from the wrong element and overstated the available space, cutting off the bottom TUI row at some font metrics and display scales; the padding now lives on the measured element so the bottom edge stays on screen. (`8613ec8`)

### Performance

- **Worktree git engine runs off the event loop**: Worktree provision, rebase, merge-back, and discard now run as async subprocess calls, with merges into a shared branch serialized, so a session doing git work no longer blocks or stutters the other sessions' terminals. (`4759ad4`)
- **Async session process termination**: The Windows `taskkill` on a session's kill and exit paths now runs asynchronously instead of blocking the shared event loop. (`3ec3c42`)
- **Skip the health snapshot when no dashboard is open**: The 10-second health snapshot is no longer built or broadcast when no dashboard tab is connected. (`cf7b40b`)
- **Lighter dashboard rendering**: The dashboard skips rendering hidden views, caches roster pill references, and the render scheduler reuses its queue array and advances by a read cursor, cutting per-render work. (`f89008e`, `a968ba5`)

### Optional, operator-gated (structural)

- Add the missing 0.15.0 reference link at the bottom: `[0.15.0]: https://github.com/johncwaters/glissa/releases/tag/v0.15.0`, placed above `[0.14.0]`. Apply only if the operator intends 0.15.0 to read as released; the link will not resolve until a `v0.15.0` tag is cut (currently the latest tag is `v0.14.0`). If 0.15.0 is meant to stay provisional, leave the link list as is. (traces to `bd0ba25`)

Notes for the Curator:
- Style guide compliance: each entry is a bold noun phrase, a colon, one present-tense sentence, no first/second person, no dashes, no banned filler.
- The four Performance entries are distinct mechanisms and may be left separate or consolidated into one "off the event loop, faster dashboard render on slow machines" entry if the project prefers; keep every source sha if consolidated.

## Sources

Every proposed change traces to one of these in-range commits:

- `25b7052` feat(headroom): easy-start supervisor for an installed Headroom proxy
- `1ccb076` feat(headroom): surface proxy savings analytics on the dashboard chip
- `c96487a` feat(focus): resizable session rail with persisted width
- `137f5d9` feat(focus): shortcut session switch acknowledges COMPLETE to IDLE
- `f3072fa` style(header): unify navbar status indicators to one quiet language
- `1f9c6fa` style(header): give the connection status the same chip shell as headroom
- `8613ec8` fix(focus): keep the terminal bottom edge on screen
- `4759ad4` perf(sessions): async worktree git engine with serialized merges
- `3ec3c42` perf(sessions): async taskkill on kill and exit paths
- `cf7b40b` perf(backend): skip health snapshot with no control clients
- `f89008e` perf(frontend): hidden-render gating, pill ref caching, render-scheduler chunk array
- `a968ba5` perf(render): read-index cursor for scheduler queue; drop dead placePill
- `bd0ba25` chore(release): bump version to v0.15.0 (source for the optional 0.15.0 reference-link correction only)

No PR numbers are present in the commit subjects, so none are cited (and the style guide bans PR numbers in entry text regardless).
