## Topic

v0.15.0 (ea78189..HEAD)

## Release range

Base ea78189, head HEAD (c1a3b33). Covers commits dated 2026-06-04 (after the previous run) through
2026-06-05.

The latest `v*` tag is `v0.13.0` (09b61da). The previous run (2026-06-04, log.md) shipped `v0.14.0`
covering `v0.13.0..ea78189`, but per the publisher convention a release tag is drafted and never created,
so no `v0.14.0` tag exists in the repo. Advancing strictly from the latest tag would re-emit the
already-shipped `v0.14.0` notes, so this run advances from `v0.14.0`'s shipped head (ea78189) instead.
A new feature is present (a built-in changelog team), so the proposed release is the next minor bump,
`v0.15.0`.

The repository ships directly to `main` with no merged pull requests in this range, so every entry is
sourced by commit sha.

## Changes

### Added

- **Built-in changelog team**: A new on-demand Teams pipeline that keeps a project's CHANGELOG honest
  against its git history. Four stages run in sequence: an analyst reads the existing changelog and the
  commits in the configured range and writes a sourced analysis of what is missing, inaccurate,
  mis-categorized, mis-ordered, or correctly excluded; a curator edits the changelog file in place to add,
  correct, move, merge, and reorder entries so every one traces to a commit; an auditor re-derives the
  commit list from read-only git and gates on accuracy, format, and style with a SHIP/FIX/BLOCK verdict
  and a bounded FIX loop back to the curator; a reporter writes a short summary on a final SHIP. The
  curator's edit only lands on a final SHIP, scoped to changelog-shaped files (CHANGELOG.md, CHANGES,
  HISTORY, NEWS, and nested variants), so a passing run can never pull in source, tests, or config; on
  FIX or BLOCK the edit is discarded and only the run folder and log merge back. Like the existing
  marketing, release-notes, and qa teams, it ships as data plus role markdown plus pack templates with no
  engine changes. (5201dc7)

### Fixed

- **Team run output now lands in your project**: A finished team run was committed on its throwaway
  worktree branch but never merged back, so the whole run could be stranded and its output lost. The
  pre-run setup gate writes a header-only log file into the project tree before the worktree exists, which
  left it untracked, and `git merge --ff-only` refused to overwrite that untracked file, aborting the
  merge-back. The run engine now clears the blocking untracked files before the fast-forward, scoped so a
  project's own pack files and other untracked files are never touched, so a completed run reliably merges
  its results back into the project. (b260ac1)
- **Live Teams run status between stages**: While a team run waited for the next stage's headless session
  to spawn (which can take several seconds), the Teams view header stayed stuck on the finished stage. The
  header now shows the handoff in progress (for example "Writer done, starting Editor"), suppressing the
  next-stage hint after a verdict stage where a FIX may re-run an earlier stage. A reduced-motion-safe
  completion cue now pulses on the run-to-done transition, scoped to the status text rather than the whole
  panel. (b260ac1)

## Sources

- 5201dc7 feat(teams): add a changelog team that reconciles the changelog with git history
- b260ac1 fix(teams): clear untracked collisions so a run's output merges back

Range endpoints: base ea78189 (previous run's shipped head, drafted as v0.14.0), head c1a3b33 (HEAD).
Latest `v*` tag: v0.13.0 (09b61da).

## Excluded

- **c1a3b33 chore: release pipeline team setup** — Adds only this repository's `.glissa/teams/release-notes/pack/*`
  files (README, voice-guide, avoid-list, release-config) that configure the release-notes team for this
  project. Project-local pack scaffolding and a chore by its own prefix, not a change to the Glissa product
  that a user of Glissa would notice. Excluded per the chore and configuration rules.
- **af5ba5a release-notes: 2026-06-04-thursday (SHIP)** — The previous run's own output merge-back commit
  (its `.glissa/` brief, notes, review, and published drafts). Pipeline artifact, not a user-facing product
  change, and its content is already covered by the shipped v0.14.0 notes.
