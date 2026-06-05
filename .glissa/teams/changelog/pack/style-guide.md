# Style guide (changelog)

The Auditor audits every edited changelog against this guide. It governs new and corrected entries.
Already-released entries written in an older, longer style predate this convention and stay as written;
do not rewrite a released entry for style alone (correct it only when it is factually inaccurate).

## Tone and tense

Terse and factual: one entry, one change, stated from the user's point of view. Lead with a short bold
summary phrase (a noun phrase naming the change), then a colon and a single present-tense sentence
describing what the software now does. Prefer one sentence; allow a second short clause only when the
change makes no sense without it. The detailed reasoning lives in the source commit, not the entry.

Use present tense describing the new behavior. No first person, no "we", and no "you".

Example (good, terse):

- **Keyboard navigation for sessions**: Alt+0 opens a new session and Alt+1 through Alt+9 jump to the
  Nth session card.

Example (too long for a new entry): a multi-sentence bullet that walks through the implementation and
rationale. Keep that depth out of new `Unreleased` entries.

## Entry shape

- Bold summary phrase, then a colon, then one concise sentence ending with a period.
- Group the entry under the correct `###` section (Added, Changed, Deprecated, Removed, Fixed, Security,
  or Performance, Tests, Docs for notable internal work).
- One change per entry. If a commit did two user-facing things, write two entries; do not bundle
  unrelated changes behind one bullet.
- Do not reference pull request or issue numbers, and do not credit authors; this project's entries
  carry neither. The commit sha is the team's internal trace, not part of the entry text.

Examples the project likes:

- Added: **Drag-and-drop session reordering**: Session cards can be dragged to reorder, and the order
  persists across reloads.
- Fixed: **Terminals undersized on first load**: The initial fit now waits for layout to settle, so
  terminals no longer lock to 80x24 until a refresh.
- Removed: **No-Flicker Mode setting**: `CLAUDE_CODE_NO_FLICKER` is always on now, and the per-session
  toggle is gone.

## Banned words and phrases

- Em dashes and en dashes. Use a comma, colon, or parentheses instead. This is a hard project-wide rule.
- Emoji of any kind.
- Marketing and urgency wording, for example "blazing fast", "game-changing", "revolutionary",
  "seamless", "effortless", "simply", "just".
- Vague filler that names no actual change, for example "various improvements", "minor fixes",
  "miscellaneous changes", or a bare "bug fixes" entry. Name the specific change instead.
