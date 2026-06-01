# How To Run

<!-- GLISSA:NEEDS-INPUT: replace everything below with how THIS repo installs and tests, then save. -->

Tell the team exactly how to install and run this project's suite in a cold checkout. The runner-triager,
the fixer, and the auditor all run the gate from this file, so be precise. Useful things to include:

- The INSTALL command for a fresh worktree (for example the fastest correct install your project supports).
- The FULL-suite test command (this is the green bar, the oracle the team fixes source to satisfy).
- The optional gate extras (build / typecheck / lint commands), and for EACH whether it is part of the green
  bar or advisory only. By default only the test suite is the hard bar; opt others in here if you want them
  to block a SHIP.
- The SINGLE-test command, so the fixer can iterate on one failure fast.
- The test framework and assertion style.
- The SOURCE layout, so the team's writeScope (`src/**` / `lib/**` by default) and the triager's scope line
  up. If your source lives elsewhere, say so and set `writeScope` in `team.json` to match.

Note on the oracle restore: before each audit the engine restores everything matching `testGlobs` (default
`**/*.test.*`, `**/*.spec.*`, `**/test/**`, `**/tests/**`, `**/__tests__/**`) to the run's base SHA. If this
repo keeps NON-test data or fixtures under a path those globs would match (for example data files under
`tests/`), set a narrower `testGlobs` in `team.json` so the restore does not revert that data.
