# Release config

How the release-notes team finds a release for Glissa and what belongs in the notes. The Researcher reads
the range and selection rules; the Publisher reads the release-title convention and announcement channels.

## Release range

Find the last release from the latest git tag matching `v*` (Glissa tags releases as `vMAJOR.MINOR.PATCH`,
for example `v0.13.0`). A run covers `<latest v* tag>..HEAD`. If HEAD has no new user-facing commits
beyond the latest tag, halt with `INSUFFICIENT_CHANGES` rather than padding the notes.

## Include and exclude

Include (user-facing): new features and dashboard capabilities, behavior changes a user would notice, bug
fixes that affect sessions/terminals/notifications, security fixes, and meaningful performance
improvements. Map these to Keep a Changelog groups (Added, Changed, Fixed, Removed, Security,
Performance).

Exclude (not user-facing): internal refactors and module restructuring with no behavior change, code-style
or Biome/lint passes, test-only changes, dependency bumps that are not security fixes, CI and build
tooling, and documentation-only edits. List excluded items in the brief's `## Excluded` section so the
selection stays auditable.

## Audience

Developers who run Claude Code on Windows, typically power users managing several agent sessions at once.
They are comfortable with terminals, npm, and CLI tools, so the notes can be technically precise. They
care most about what changed in the dashboard, session lifecycle, status detection, notifications, and
stability. Keep the level of detail close to the existing CHANGELOG: concrete and specific, with a
one-line benefit framing per release.

## Pull request enrichment (optional)

Use a read-only `gh` query to enrich entries with merged pull request titles and numbers when `gh` is
available (for example `gh pr list --state merged`). If `gh` is not installed or not authenticated, fall
back to merge-commit and commit subjects. Never require `gh`, and never run a `gh` command that writes.

## Publisher

- Repository: `johncwaters/glissa` (https://github.com/johncwaters/glissa).
- Release-title convention: use the tag name `vMAJOR.MINOR.PATCH` (for example `v0.13.0`) as both the tag
  and the GitHub release title. State the tag in the draft, but do not create or push it.
- Announcement channels (drafts only, never posted):
  - GitHub release body: the primary announcement. Use the approved notes as the release body, formatted
    for the GitHub "Draft a new release" form.
  - X / Twitter: a short post in Glissa's voice (well under 280 characters) highlighting the one or two
    most notable changes, with the repo link. No emoji, no hashtag spam, no urgency phrasing.
