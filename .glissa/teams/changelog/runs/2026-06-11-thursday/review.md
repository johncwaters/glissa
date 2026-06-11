## Accuracy

Re-derived the range independently: `git describe --tags --abbrev=0` returns `v0.14.0` (no `v0.15.0` tag exists), and `git log v0.14.0..HEAD --oneline` is the authoritative commit list. The reconcile target is the `Unreleased` section, that is, in-range commits NOT already in the dated `0.15.0` section (cut by `bd0ba25`). The `0.15.0` section and below were not touched by the Curator (confirmed: only the `Unreleased` block changed).

Forward check (every Unreleased entry traces to a real in-range commit):

- Added > Manage an installed Headroom proxy: `25b7052` (confirmed: `headroomEasyStart`/`headroomPort` supervisor, detect/start/stop/restart from a header chip, Use-for-sessions fills `proxyBaseUrl`, off by default, dimmed install hint). Pre-bump, omitted from 0.15.0; correctly surfaced here.
- Added > Headroom proxy savings: `1ccb076`.
- Added > Resizable session rail: `c96487a`.
- Changed > Switching sessions clears a completed session's alert: `137f5d9` (confirmed: shortcut/rail-pill switch dismisses COMPLETE to IDLE, WAITING never dismissed). Pre-bump, omitted from 0.15.0; correctly surfaced.
- Changed > Unified navbar status indicators: `f3072fa` + `1f9c6fa` (one visual change across two commits, one entry per the one-change-one-entry rule).
- Fixed > Terminal bottom row clipped: `8613ec8` (confirmed: FitAddon measured the wrong element, padding moved onto `.xterm`; CSS-only). Not a duplicate of 0.9.1's older bottom-clip fix.
- Performance > Worktree git engine off the event loop: `4759ad4` (confirmed: team-git engine promisified, serialized merges; distinct from 0.15.0's `86ccf12`, which moved the probes/post-turn checks, this moves the engine/merge ops, and the entry wording distinguishes them).
- Performance > Async session process termination: `3ec3c42`.
- Performance > Skip the health snapshot: `cf7b40b`.
- Performance > Lighter dashboard rendering: `f89008e` + `a968ba5`.

Reverse check (every user-facing in-range commit is represented): all 12 (`25b7052`, `1ccb076`, `c96487a`, `137f5d9`, `f3072fa`, `1f9c6fa`, `8613ec8`, `4759ad4`, `3ec3c42`, `cf7b40b`, `f89008e`, `a968ba5`) appear. The pre-bump commits already documented in 0.15.0 (`62327f7`, `951f744`, `cf80050`, `902141e`, `3299927`, `b96f1ac`, `a70cc55`, `150add9`, `10fc508`, `47a7c99`, `7cb3de9`, `98d3875`, `2313cea`, `39d9dab`, `767b48c`, `5d13157`, `e3610d3`, `3cb0f77`, `fd2b53d`, `86ccf12`) are settled-release records and correctly left alone. Exclusions verified: `bd0ba25` (release bump), `ea64bcd` (screenshot chore), `2c97f88` (changelog maintenance), `c6e221f` (AGENTS.md regen, internal doc), `acb16e1` (QA report, internal verification record), `cefc850` (confirmed via `git show`: settled-branch reset rejection swallow, test-only contract, no happy-path behavior change). All correct.

## Format

Matches `changelog-config.md`: `Unreleased` sits at the top above `0.15.0`; group order Added, Changed, Fixed, Performance follows the configured sequence (Deprecated/Removed/Security absent, which is fine). Versions remain newest-first with ISO dates intact. No duplicates, no mis-ordered versions, no orphaned headings. The bottom reference-link list is untouched and correctly carries no `Unreleased` link.

## Style

Every new entry is a bold noun phrase, a colon, then one present-tense sentence. No first or second person. Programmatic scan of the entire `Unreleased` block: zero em dashes, en dashes, or ellipsis characters (hyphens in `click-through`, `rail-pill`, `double-click` are plain ASCII U+002D, allowed); zero emoji (Extended_Pictographic test false). No banned marketing/filler terms, no PR or issue numbers, no author credit.

## Summary

The edited `Unreleased` section reconciles cleanly to `v0.14.0..HEAD`: all 12 user-facing commits are represented and every entry traces to a real commit, both directions verified against git. Format, ordering, and dates match the configured Keep a Changelog convention; style and banned-term checks pass. Scope is clean: only `CHANGELOG.md` changed substantively (the pack `.md` modifications are pure CRLF normalization with no content delta, and predate this run). The Curator's single `Unresolved` item, the optional `0.15.0` reference link, was correctly withheld: the pack rule adds a link "only when a release cuts a new dated version," this team does not cut releases, and no `v0.15.0` tag exists, so adding it would introduce a dead link. Confirmed: leave `0.15.0` provisional with no link (current state). No remaining issues.

VERDICT: SHIP
