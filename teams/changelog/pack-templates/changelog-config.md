# Changelog config

GLISSA:NEEDS-INPUT: fill in each section below for this project, then remove this marker line.

This file tells the changelog team where this project's changelog lives, how it is shaped, and what belongs
in it. The Analyst reads the file location, the range, and the include rules; the Curator and Auditor read
the format and conventions.

## Changelog file

The path to the changelog, relative to the repository root (for example `CHANGELOG.md`). If the project
keeps more than one, name the one this team maintains.

## Format and sections

The convention the changelog follows. For example: Keep a Changelog, with `Added`, `Changed`, `Deprecated`,
`Removed`, `Fixed`, `Security` groups under each version. State the heading depth, whether there is an
`Unreleased` section at the top, the date format for releases, and whether the file keeps comparison or
reference links at the bottom.

## Versioning and ordering

The versioning scheme (for example semantic versioning) and the order versions appear in (newest first is
typical). Say whether the team may touch already-released sections (usually only to correct an inaccuracy) or
should confine its edits to `Unreleased`.

## Range to reconcile

How to determine the commits a run should cover. Pick one and describe it: since the last documented version
header in the changelog, since the latest tag, or an explicit base ref.

## Include and exclude

- What counts as user-facing (the changes that belong in the changelog).
- What to exclude (internal refactors, chores, dependency bumps, test-only changes, formatting), unless your
  project deliberately logs some of these.
