## Summary

All three entries trace to sourced commits, voice and avoid-list pass, no emojis or dashes, and every entry is user-facing. Ships.

## Summary line (top of notes)

Benefit-led, single sentence, no heading: passes the voice-guide opener rule. It names the two user-visible effects (operator questions in manual runs; two terminal rendering fixes). Traceable: the question-pause behavior maps to ea78189, the two fixes to 332eb4a and 6bf95e7. No banned terms, no urgency, no dashes, no emoji.

## Added — "Operator questions in manual team runs"

1. Traceability: every claim sources to ea78189 in `brief.md`'s `## Sources`. Spot checks against the brief: question budget default 3, answer timeout default 600 seconds, no-progress guard that halts on a repeated question, cancel-while-pending settles immediately, gated by `chat.allowQuestions`, scheduled/unattended runs never block. All present and accurate to the brief. Pass.
2. Voice: bolded lead-in plus plain detail, addresses the reader as "you", past/present framing consistent with the CHANGELOG style. Pass.
3. Avoid-list: no banned word or phrase. Pass.
4. Emojis: none. Pass.
5. Em/en dashes: none (hyphens only, e.g. "no-progress"). Pass.
6. Urgency tropes: none. Pass.
7. User-facing framing: describes what a run operator sees and controls, not internal wiring. Pass.

## Fixed — "Recover dropped terminal history after backpressure"

1. Traceability: sources to 332eb4a. The rewind-to-replay-base behavior and the backfill re-pull match the brief. "Rewinds its position to the replay base" is a fair plain-language rendering of the brief's "rewinds its sent offset to the replay base". Pass.
2. Voice: lead-in style matches the voice-guide's own example for this exact change. Pass.
3-6. No avoid-list terms, no emoji, no dashes, no urgency. Pass.
7. User-facing: frames the symptom (stranded history after a reconnect) and the resolution. Pass.

## Fixed — "Clear WebGL ghost glyphs on expand and maximize"

1. Traceability: sources to 6bf95e7. The blank-canvas-plus-dirty-row explanation and the forced full repaint match the brief. Pass.
2. Voice: consistent lead-in and plain detail. Pass.
3-6. No avoid-list terms, no emoji, no dashes, no urgency. Pass.
7. User-facing: describes the visible stale glyphs and the fix. Pass.

## Exclusions

The excluded items in the brief (ebc5445 refactor, 660f59c chore screenshot, 1de8877 merge) correctly do not appear in the notes. Pass.

VERDICT: SHIP
