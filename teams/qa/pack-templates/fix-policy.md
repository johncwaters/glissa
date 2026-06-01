# Fix Policy

<!-- GLISSA:NEEDS-INPUT: replace everything below with this repo's fix policy, then save. -->

Tell the fixer how to fix and what never to touch. The fixer and auditor both enforce this file. Useful
things to include:

- ROOT-CAUSE-NOT-MASK the fixer must address the defect, never mask it with `@ts-ignore`, `eslint-disable`,
  a skip flag, or a tautological no-op.
- NEVER EDIT A TEST the absolute rule: never edit, skip, weaken, rename, or delete a test, and never add
  `.skip` / `.only` / `xit` / `xdescribe`. The engine reverts any test edit to the base SHA before the audit,
  so a test-edit "fix" can never SHIP; it only wastes a round.
- DO-NOT-TOUCH paths generated code, vendored dependencies, migrations, lockfiles, and anything else a fix
  must not modify in this repo.
- BLOCK classes failure classes the team must NOT auto-fix: security-sensitive code, schema / data
  migrations, generated code, and anything whose fix would require a test change.
- SCOPE DISCIPLINE fix only what a failing test demands; no opportunistic refactors.

Note: if this repo stores NON-test data under a path the default `testGlobs` would match, narrow `testGlobs`
in `team.json` (see how-to-run.md), so a legitimate source fix touching that data is not silently reverted by
the restore-before-audit step.
