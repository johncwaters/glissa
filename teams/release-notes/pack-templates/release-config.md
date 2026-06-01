# Release config

GLISSA:NEEDS-INPUT: fill in each section below for this project, then remove this marker line.

This file tells the release-notes team how to find a release and what belongs in the notes. The Researcher
reads the range and selection rules; the Publisher reads the release-title convention and announcement
channel.

## Release range

How to find the last release and the range a run should cover. Pick one and describe it:

- A tag pattern (for example: the latest tag matching `v*`), covering `<last tag>..HEAD`, or
- "Since the last tag", or
- An explicit base ref.

## Include and exclude

- What counts as user-facing (labels, paths, or commit-subject conventions to include).
- What to exclude (chores, internal refactors, dependency bumps, test-only changes).

## Audience

Who the notes are for (end users, operators, API consumers) and the level of detail they expect.

## Pull request enrichment (optional)

Whether to use a read-only `gh` query to enrich entries with merged pull request titles and numbers. Set
this off if `gh` is not available; the team then falls back to commit subjects.

## Publisher

- The GitHub repository the release belongs to.
- The release-title convention (for example: the tag name, or "Project X <version>").
- The announcement channel and any per-channel notes (kept here as text; the Publisher only drafts a
  copy-paste payload, it never posts).
