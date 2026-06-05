# Changelog config

This file tells the changelog team where Glissa's changelog lives, how it is shaped, and what belongs
in it. The Analyst reads the file location, the range, and the include rules; the Curator and Auditor
read the format and conventions.

## Changelog file

`CHANGELOG.md` at the repository root. It is the only changelog this project keeps and the one this
team maintains.

## Format and sections

Keep a Changelog 1.1.0 with Semantic Versioning 2.0.0 (both are linked in the file's header lines).

- Version headings are `## [x.y.z] - YYYY-MM-DD` (ISO date), listed newest first.
- An `## [Unreleased]` section sits at the very top, above the newest released version, and collects
  changes that have not yet shipped in a tagged release. This is where this team does almost all of
  its work.
- Change groups are `###` headings under each version, in this order when present: Added, Changed,
  Deprecated, Removed, Fixed, Security. This project also uses Performance, Tests, and Docs groups for
  notable non-user-facing work; place those after the standard groups.
- The file keeps reference links at the bottom, one per released version:
  `[x.y.z]: https://github.com/johncwaters/glissa/releases/tag/vx.y.z`. The `Unreleased` section does
  not get a reference link; a link is added only when a release cuts a new dated version.

## Versioning and ordering

- Semantic Versioning. Release tags are `vX.Y.Z`.
- Versions read newest first; the groups within a version follow the order listed above.
- Confine edits to the `Unreleased` section. Touch an already-released, dated version only to correct
  a genuine inaccuracy that traces to a commit, never to restyle or pad it, and never renumber or
  re-date a released version.

## Range to reconcile

- Reconcile everything since the latest release tag. The latest tag comes from
  `git describe --tags --abbrev=0` (currently `v0.13.0`), and the range is `<latest tag>..HEAD`.
- Those commits belong in the `Unreleased` section. If `Unreleased` is missing, create it at the top,
  directly above the newest released version.
- The release process later renames `Unreleased` to a dated version and adds its reference link. This
  team does not cut releases; it only keeps `Unreleased` honest between them.

## Include and exclude

User-facing changes are the default. Include:

- New features and dashboard or CLI capabilities, changes to existing behavior, bug fixes a user could
  notice, removed or deprecated features, and security fixes.
- Notable internal work this project deliberately logs: significant internal restructures (under
  Changed, noting "no behavior change"), measurable performance work (Performance), and substantial
  test or documentation additions (Tests, Docs).

Exclude (do not log) unless the commit carries user-visible impact:

- Routine chores and release-bump commits, formatting or lint-only passes, dependency bumps with no
  behavior or security change, and trivial refactors. A dependency bump that patches a security
  advisory is the exception and belongs under Security.
- Commits that only touch generated team run output (for example anything under `.glissa/`), and merge
  commits.

Commit-mapping aid: commits follow Conventional Commits (`feat`, `fix`, `refactor`, `perf`, `chore`,
`docs`, `test`, with scopes such as `teams`, `session-card`, `sessions`). Treat the type as a hint, not
a rule: a `feat` or `fix` is usually user-facing and a `chore` usually is not, but read the diff before
deciding.
