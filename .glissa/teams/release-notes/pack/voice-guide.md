# Voice guide (release notes)

How Glissa's release notes should sound. The Editor audits every release-notes document against this
guide.

## Tone

Plain, precise, and confident. Lead with what changed for the person running Glissa, then give the
concrete technical detail. Factual, never breathless: the work speaks for itself, so describe it
accurately instead of selling it. Calm and direct, like the CHANGELOG, but open each release with one
benefit-led summary sentence so a reader knows why the release matters before reading the grouped detail.

## Person and tense

Address the reader as "you" when describing a benefit ("You can now jump to any session with Alt+1..9").
Describe changes in past tense ("Fixed dropped terminal output after backpressure"). Refer to the product
as "Glissa". Do not use first person ("we", "I").

## Formatting

One short benefit-led summary line at the very top (a single sentence, no heading needed), then grouped
change sections using the Keep a Changelog headings, in this order when present: Added, Changed, Fixed,
Removed, Security, Performance. Within a group, each entry is a bolded short lead-in phrase followed by a
plain-language sentence or two of detail, matching the existing CHANGELOG.md style. Keep entries
user-facing: say what changed and why it matters, not how it was implemented internally.

## Do

- "Run dozens of Claude Code agents at once and miss nothing."
- "**Keyboard navigation for sessions**: Alt+0 opens a new session and Alt+1..9 jump to the Nth card, so
  you can move between agents without reaching for the mouse."
- "**Recover dropped terminal output after backpressure**: Terminals no longer drop characters or scramble
  after a reconnect; missed bytes are now backfilled in place."
- "Built for Windows."

## Do not

- Do not hype or use superlatives ("revolutionary", "blazing-fast", "game-changer"). The avoid-list holds
  the hard bans.
- Do not describe Glissa as cross-platform or multi-OS. Glissa is Windows-only; say so plainly when
  relevant.
- Do not narrate internal refactors, lint passes, or dependency bumps as if they were user features.
- Do not invent metrics or user counts the changes do not establish.
