## Topic

v0.14.0 (v0.13.0..HEAD)

## Release range

v0.13.0 (09b61da) .. HEAD (ea78189). Covers commits dated 2026-06-01 through 2026-06-04. The repository
ships directly to `main` with no merged pull requests in this range, so every entry is sourced by commit
sha. Latest `v*` tag at time of writing is `v0.13.0`; a new feature is present, so the proposed release is
the minor bump `v0.14.0`.

## Changes

### Added

- **Operator conversation for manual Teams runs**: A manual Teams run can now hold a back-and-forth with
  the operator. A stage that hits an ambiguity it cannot resolve from its pack and inputs writes a
  `QUESTION: ...` sentinel as its entire output; the run pauses, surfaces the question in a dashboard chat
  pane, and re-runs the stage once your answer lands. The pause is bounded by a per-run question budget
  (default 3), an answer timeout (default 600s), and a no-progress guard that bails if an answered stage
  re-asks the same question. Cancelling while awaiting an answer settles the run immediately. Interactive
  questions are limited to manual runs with `chat.allowQuestions` on; scheduled or unattended runs never
  block (a stray question halts the run as needs-operator instead). (ea78189)

### Fixed

- **Recover dropped terminal replay history after backpressure**: When a reconnect replay frame carrying
  historical bytes was dropped under WebSocket backpressure, the history was stranded until Claude's next
  full repaint. The sender now rewinds its sent offset to the replay base on a dropped replay, so the next
  backfill re-pulls the missing history (plus any live bytes) in place. (332eb4a)
- **Clear WebGL ghost glyphs on expand and maximize**: Expanding or maximizing a session card could leave
  stale glyphs ("ghosts") behind, because a fresh or reloaded WebGL context starts on a blank canvas and
  xterm only repaints rows it marks dirty. Expand and maximize now force a full-viewport terminal repaint
  (a deferred clear plus refresh once the card is on-screen), clearing the ghosts. (6bf95e7)

## Sources

- ea78189 feat(teams): add an operator conversation with an agent-question pause/resume loop
- 332eb4a fix(ws-sender): recover dropped replay history by rewinding sentOffset on backpressure drop
- 6bf95e7 fix(session-card): force terminal repaint on expand/maximize to clear WebGL ghosts

Range endpoints: base v0.13.0 (09b61da), head ea78189.

## Excluded

- **ebc5445 refactor: remove dead scraping-era config keys** — Internal cleanup. Removes config keys
  (`autoRecoverSeconds`, `inputGraceSeconds`, `promptDetectionMs`, `feedDebounceMs`) and an orphaned
  "Feed Debounce" settings input left over from the deleted screen-scraping detection machinery. The
  commit states behavior is unchanged and the removed settings control was non-functional, so this is a
  no-behavior-change refactor per the include/exclude rules, not a user-facing Removed entry.
- **660f59c chore: update screenshot** — Asset/documentation update, not a user-facing change.
- **1de8877 Merge branch 'main'** — Branch-sync merge commit with no unique user-facing content.
