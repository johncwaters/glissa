# Announce config

GLISSA:NEEDS-INPUT: confirm or adjust each section below for this project, then remove this marker line.
The defaults already give a working "GitHub release body only" announcement, so a minimal fill is quick.

This file tells the changelog team's Announcer how to frame a release announcement from the curated
changelog. The Announcer runs only on a SHIP and writes a copy-paste draft; it never posts or tags.

## Release title and tag

The release-title and tag convention. Default: use the tag name `vMAJOR.MINOR.PATCH` (for example
`v1.4.0`) as both the tag and the title. State the tag in the draft, but do not create or push it.

## Channels

Where the announcement goes. Default: the GitHub release body only (the curated `Unreleased` entries,
reframed under the release title), with no social post. To add a channel, name it here (for example a
blog note, a chat post, or a short social blurb) and describe the length and format it expects.

## Announcement voice

How the announcement should read. Default: plain, concrete, and factual, with a one-line benefit framing,
matching the level of detail in the changelog. State the audience (for example end users, operators, API
consumers) and any house phrasing the announcement should keep.

## Avoid

Words or phrases the announcement must never use, one per line. Marketing hype and urgency phrasing
("don't miss out", "act now", "limited time") are always out of place and do not need to be listed.

- (replace with a banned word or phrase, or leave as is)
