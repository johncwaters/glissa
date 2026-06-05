# Announce config

This file tells the changelog team's Announcer how to frame a release announcement from the curated
changelog for Glissa. The Announcer runs only on a SHIP and writes a copy-paste draft; it never posts or
tags.

## Release title and tag

Glissa tags releases as `vMAJOR.MINOR.PATCH` (for example `v0.13.0`). Use that tag name as both the tag
and the release title. State the tag in the draft, but do not create or push it. Note that the actual
GitHub release body is cut from `CHANGELOG.md` by `scripts/release.js` at release time, so the draft here
is a preview the operator can sanity-check, not the published source.

## Channels

- GitHub release body: the curated `Unreleased` entries reframed under the release title, ready to paste
  into the "Draft a new release" form. This mirrors what the release script will produce from the changelog.
- X / Twitter: a short post (well under 280 characters) highlighting the one or two most notable changes,
  with the repository link. No hashtag spam.

## Announcement voice

Audience: developers who run Claude Code on Windows, typically power users managing several agent sessions
at once. They are comfortable with terminals, npm, and CLI tools, so the announcement can be technically
precise. Keep it plain and concrete, with a one-line benefit framing, matching the level of detail in the
changelog. Lead with what changed in the dashboard, session lifecycle, status detection, notifications, or
stability.

## Avoid

- No emoji.
- No em dashes or en dashes.
- No urgency phrasing ("don't miss out", "act now", "hurry", "limited time").
- No hashtag spam in the social post.
