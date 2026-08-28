# Plan: Visions part 4 (focus)

Status: drafted 2026-08-27 from a code audit of the lane as shipped through M18; M19 to M21 shipped
2026-08-27 (`server/core/visions-touch-core.js`, `filterComments` in `server/core/visions-dispatch-core.js`,
threads in `server/core/visions-intent-core.js`). Predecessors: `docs/archive/plan-navigator.md` (M1 to M5), `docs/archive/plan-navigator-2.md`
(M6 to M11), `docs/plan-visions-3.md` (M12 to M18). `AGENTS.md` and the code win over this doc.
Milestone numbering continues from M18.

## Problem

Visions comments on whatever it finds anywhere in a document, and the operator reads most of it as
noise. The audit found six causes, all structural, none a prompt-wording problem:

1. **The prompt carries the whole buffer and no delta.** `buildVisionsPrompt`
   (`server/core/visions-dispatch-core.js`) fences the entire document. Nothing tells the session
   which lines the operator touched. `applyDidChange` (`server/core/visions-buffer-core.js`) receives
   every LSP range and discards it once the splice lands.
2. **A freshly opened file dispatches with zero edits.** `didOpen` calls `scheduleSweep`, and the
   sweep's `publishDiagnostics` ends with `armDispatch(uri, 'edit')` (`server/visions-wiring.js`), so
   an opened markdown buffer dispatches after the sweep debounce plus `quietMs` with no ingest
   activity involved at all, classified as an `edit`: no hash is recorded for that uri yet, so
   `classifyTrigger` takes its cold-start branch and the `armedBy` tiebreak resolves to `edit` there,
   which is the sweep's own arming reason and not evidence that anyone typed. The ingest poke
   (`noteActivity`) is a second, additional armer over every open markdown buffer. By either route the
   whole untouched document gets a critique.
3. **Intent is one 300-character slot per project plus one global slot**, model-written,
   last-write-wins (`applyModelIntent`, `server/core/visions-intent-core.js`). It cannot hold two
   stories in one repo, and it is not bound to any document. The leak runs the opposite way from the
   obvious one: `applyModelIntent` writes the global slot only when `projectId` is null, so that slot
   holds a statement made under a uri no project owns, and `intentTextFor`
   (`server/core/visions-intent-core.js`) then carries that unowned text INTO any project that has no
   slot of its own.
4. **Relevance is prompt-hope.** The prompt says "report drift from the working intent" but
   `sanitizeComments` enforces only line range and length, and `isLintDomainDiagnostic` filters only
   the lint domain. A comment about untouched text on an unrelated topic passes every gate.
5. **The activity digest is machine-wide.** `readContextDigest` calls `contextDigest({ scopes: null })`,
   so another project's activity is evidence for this project's intent. Scoping it can only fix that
   half: `matchesScopes` passes any event carrying no `scope.root` whatever the filter says, so
   machine-scoped events stay in every project's digest by design. The strongest intent signal,
   the operator's own prompts to agents, never reaches the digest at all: the ring target is built
   with a hardcoded `userPrompts: false` (`server/ingest-agent-logs.js`), so that exclusion is
   structural rather than a setting.
6. **Memory retrieval queries with the whole buffer** (`readMemorySection` passes `query: text`), so
   it retrieves records that look like the document rather than records about the task. `retrieve`
   funnels into `retrieveMemories` (`server/core/memory-core.js`), a lexical scorer with no kind
   filter and no recency mode, so a feedback record surfaces only when the buffer's own words happen
   to hit it. There is also barely a corpus to hit: `dismissFeedbackInput` is the only writer of a
   refusal and no shipped client sends the `visions/dismissFinding` notification that feeds it,
   `servedFeedbackInput` records findings that were SHOWN rather than refused, a feedback record
   carries no verdict, uri or message hash (its disposition is only a text prefix, `dismissed `,
   `served `, `applied `), and nothing writes the word "refused" at all.

The second operator ask, stated 2026-08-27: intent must FLOW. One carbon unit works several
projects, and several stories inside one project, in the same hour. A single slot cannot follow that.

## Operator decisions (2026-08-27)

- Focus is enforced by a GATE, not by prompt text. Every rule below that says "a comment must" is
  implemented in a sanitizer with a test, and the prompt merely tells the session the rule exists.
  A rule that lives only in the prompt is the current state, and it is what this plan replaces.
- Intent stays model-maintained (the 2026-08-22 decision holds): no manual intent editing surface
  returns. What changes here is the SHAPE (threads, not a slot). The EVIDENCE half (scoped, richer) is
  deferred: it lives in the follow-ons section, not in M19 to M21.
- Additive context never blocks a dispatch. The rule stands for any prompt section a later milestone
  adds, following the guarded-provider pattern `readContextDigest` set: a throwing provider costs its
  section, never the dispatch, and an absent one leaves the prompt byte-identical. M19 to M21 add no
  such provider: their prompt changes are STATE-driven, so an empty state is what has to cost the
  prompt nothing.
- No new dependencies.

## Architecture fit

The lane keeps its shape: pure rules in `server/core/`, deps injected into the wiring, timers owned by
`server/visions-wiring.js`, spawn owned by `server/visions-dispatch.js`. Each milestone names the seam
it touches. No new control message types: the lane already carries `visions-findings`,
`visions-comments`, `visions-hand`, `visions-fix`, `visions-intent` and `visions-snapshot`, and the
message payload stays an opaque object on the wire contract
(`shared/contracts/control-messages.js`), so the frontend change is a decode and render change, not a
contract change.

| Concern | Today | After this plan | Seam |
|---|---|---|---|
| What was edited | discarded after splice | per-uri touched line ranges since open | `visions-buffer-core.js` (pure), new `visions-touch-core.js` |
| Cold open | dispatches like an edit | orientation dispatch: intent and hand only, zero comments and zero diagnostics | `decideDispatch` gate + prompt variant |
| Intent | one slot per project | threads per project, uri-bound, decaying | `visions-intent-core.js` rewritten in place, plus the browser decoder in `public/visions-view-core.mjs` |
| Relevance | prompt text | `basis` tag per comment, checked against touched ranges and active thread | new `filterComments` in `visions-dispatch-core.js`, applied in `applyDispatchResult` in the wiring |

Every gate decision remains reproducible from `state`, `now`, and the inputs, so the replay and
recording story (`tests/visions-dispatch-core.test.js`, `tests/visions-wiring.test.js`) extends
rather than forks.

## Milestones

### M19: touched ranges and the orientation dispatch

The one slice that removes "random unrelated" outright. Ship first, alone.

- **`visions-touch-core.js` (new, pure).** State: `touchedByUri: Map<uri, Range[]>` where a range is
  1-based inclusive line numbers. `recordChanges(state, uri, pairs, nextText)` takes a whole batch and
  maps each change to the lines it produced, merging overlapping or adjacent ranges. A whole-buffer
  replacement (no `range`) is reduced to its minimal changed span rather than marking every line: this
  reuses `insertionFromWholeTextChange` (`visions-buffer-core.js`), generalized to return a replaced
  span instead of an insertion only, so the lane keeps one prefix and suffix walk rather than growing a
  second differ. `lineStartOffsets` and `offsetOfPosition` are already exported from that module.
  Ranges shift with later inserts and deletes above them: the delta of a change is applied to every
  range below it, which is what keeps a range pointing at the same prose after an edit higher up.
  `didClose` and `didOpen` reset the uri.
- **`applyDidChange` returns the applied changes** as per-change `{ change, textBefore }` pairs, since
  each change in a batch reads the text the previous one left and a single before-text cannot describe
  the second one. The wiring already snapshots `previousDoc.text` for the boundary detector, so this is
  about batch fidelity, not about avoiding a parse. The buffer store itself stays a mirror and learns
  nothing about editing history.
- **`decideDispatch` gains `editedSinceOpen: boolean`.** A dispatch on a uri with no touched range is
  classified `orientation`. The trigger union on the wire stays two-valued: `recordDispatch` already
  coerces anything that is not `activity` to `edit`, and the activity cap tests
  `trigger === 'activity'` literally, so an orientation is recorded in the `activity` bucket with a
  separate `reason: 'orientation'` field on the `dispatchTimes` entry. It therefore spends
  `activityMaxPerHour` (it is the machine, not the carbon unit, that asked) without widening the
  union that `recordDispatch` and `countRecentDispatches` agree on. It fires at most ONCE per uri per
  open (`orientedUris`), so an idle open document never dispatches twice on activity alone.
- **`orientedUris` lives beside the touch state**, per connection and per open, NOT in the lane-wide
  `dispatchState`: `forgetUri` clears that state only for the last owner (`openOwnersByUri`), so a uri
  open in two windows would keep one window's orientation mark alive for the other.
- **Prompt variant.** An orientation prompt says the document was just opened and nothing in it has
  been edited; the session may return `intent` and `hand`, and both `comments` and `diagnostics` are
  capped at zero. A session that returns either anyway is refused mechanically. Verdict `COMMENTS`
  with an empty array downgrades to `NONE` as today.
- **Edit prompt gains a `Lines edited this session:` line** listing the touched ranges, and the rule
  "comment on those lines, or on how they interact with the rest; the rest of the document is context".
- **New `filterComments` in `visions-dispatch-core.js`.** `sanitizeComments` STAYS a shape validator
  and is given no focus rules: it is also the shape validator behind `sanitizeModelDiagnostics`, so a
  range rule buried in it would silently change the diagnostics channel. It does gain ONE field:
  it validates and RETAINS an optional `basis` (one of `edit`, `intent`, `structure`; any other value
  is stripped to absent), because `readCommentsResult` runs every comment through it and it returns
  only `line` and `message` today, so M21's tag would never reach the wiring at all. Shape, not policy:
  M19 reads the field nowhere. `filterComments` layers above it, takes
  `{ touchedRanges, margin, activeThread, trigger }`, and returns
  `{ comments, hand, dropped: { edit, intent, untagged, outOfRange } }`, following the return shape
  `sanitizeModelDiagnostics` already set. In M19 only `outOfRange` can be non-zero and `activeThread`
  goes unread; M21 fills the rest. A comment outside every touched range plus the margin (3 lines, a
  module constant, not config) is dropped. `hand` is not range-checked: it is the whole-document
  channel by definition. The range test itself is ONE named export,
  `isWithinTouchedRanges(line, ranges, margin)`, imported by `filterComments` and by the diagnostics
  path, so the two channels cannot drift apart and neither rule lives inside the shape validator.
- **The filter runs in the WIRING, on the returned result, inside `applyDispatchResult`.** Sanitizing
  today happens inside the injected `dispatch` (`readCommentsResult`), which
  `tests/visions-wiring.test.js` replaces with a fake, and the wiring re-validates nothing behind it.
  Running the focus gate in the wiring keeps it exercised by the wiring tests and keeps touched ranges
  off the dispatch injection contract entirely. `applyDispatchResult` is the site, not
  `recordComments`: it is the one function that sees comments, diagnostics and hand of a single result,
  and `recordComments` runs BEFORE `recordHand`, so a hand folded out of a comment could never leave
  `recordComments`. `recordComments` stays a recorder.
- **The diagnostics call site is named too.** `recordModelDiagnostics` is called from
  `applyDispatchResult` with `{ text }` alone; it must receive `touchedRanges` as well, and the
  orientation zero-diagnostics rule applies there, or the model-diagnostics channel stays an unfiltered
  way back into the document.
- Wire: `visions-wiring.js` owns the touch state per connection beside the doc store, feeds it from
  `didChange`, and resets it on `didClose`. `runDispatch` reads that connection's touch state and passes
  `{ touchedRanges, trigger }` into the prompt and into `applyDispatchResult`; the touch state itself is
  never hoisted into the lane-wide closure, which is what keeps it per connection.
- Tests: `tests/visions-touch-core.test.js` (range merge, shift on insert and delete above, whole-text
  replacement marks the minimal span, batch of changes, reset on close);
  `tests/visions-dispatch-core.test.js` (orientation trigger, once per open, zero comments and zero
  diagnostics, out-of-range comment dropped, margin, a model diagnostic outside the ranges dropped);
  `tests/visions-wiring.test.js` (didOpen then poke yields an orientation dispatch and no comments;
  didOpen then edit then poke yields an edit dispatch scoped to the edit; an out-of-range comment from
  the fake dispatch never survives `applyDispatchResult`; an out-of-range model diagnostic from the
  same result does not either).

### M20: intent threads

- **Shape.** `visions-intent.json` becomes `{ byProject: { [projectId]: Thread[] }, unowned: Thread[] }`
  where a thread is `{ id, text, uris: string[], ts, hits }`. `reviveIntentState` accepts the M5 slot
  shape and the current per-project `{ global, byProject }` shape and lifts each existing slot into one
  thread, so an upgrade keeps the standing statement. The global slot becomes `unowned`, delivered ONLY
  to a uri no project owns; it never falls back into a project's prompt. `intentTextFor` is replaced by
  `activeThreadFor(state, projectId, uri)`.
- **Selection.** The active thread for a dispatch is the thread whose `uris` contains this uri. With no
  such thread, it is the most recent thread in the project by `ts`, ties breaking toward the higher
  `hits`. A project with no thread delivers no intent line at all. That is a deliberate CHANGE, not
  parity: today an empty project slot delivers the global text via `intentTextFor`, which is exactly
  the leak in Problem item 3.
- **Result contract.** `intent` is either a string or an object. A string advances the active
  thread, or opens one when the project has none. The object form is `{ thread: "<existing id>" |
  "new", text }`. Thread ids are SERVER-MINTED and have ONE accepted shape, `t-` plus 8 lowercase
  hex digits (`t-716d49b4`), pinned by `THREAD_ID_RE`. That regex gets ONE definition, in
  `server/core/visions-intent-core.js`, imported by the result validator `readCommentsResult` in
  `server/visions-dispatch.js` and by the prefix parse in `visions-memory-core.js`, following the
  `RESUME_ID_RE` one-definition rule: a second copy is how the two ends of an id check drift apart.
  That shape is forced by the canon, not by taste: the id rides the intent record's text, so it
  passes `screenMemoryText`, and `findHighEntropyToken` reads any 24-character-or-longer run of
  `[A-Za-z0-9_+=/-]` as one token. A `crypto.randomUUID()` id is exactly such a run and a base64url
  id can be, so the record would be refused as `high-entropy`, `store.append` would return nothing,
  `rememberIntent` would delete the chain head, and that thread's intent would never enter the canon
  at all. Eight hex digits after a `t-` cannot reach the run length. A session may name an id that
  already exists in the project or the literal `new`, and no other value is accepted. An unknown id
  is refused and logged as a count only, never with the text. Advancing a thread updates `text` and
  `ts`, appends the uri, and bumps `hits`. The cap is five live threads per project, and the oldest
  by `ts` is retired when a sixth opens.
  `readCommentsResult` (`server/visions-dispatch.js`) is the seam and it must change: today
  `sanitizeIntentText(parsed.intent)` returns `''` for anything that is not a string, so the object
  form would be dropped silently rather than refused.
- **Decay.** A thread untouched for `visions.intent.threadTtlMs` (default 72 hours) is retired on the
  next read, not by a timer, so the lane keeps zero new timers. `resolveVisionsConfig`
  (`visions-dispatch-core.js`) is an ALLOW-LIST and is the ONLY place an unnamed key vanishes, since
  `normalizeConfigFile` does not strip unknown keys; the key is also declared in
  `shared/contracts/config.js` (validation and the settings surface) and gets a numeric range in
  `shared/settings-ranges.js`, which holds ranges only. Retired threads are not deleted from the memory
  canon: M13's `intentMemoryInput.supersedes` chain records every advance. That chain is keyed by
  project PLUS thread id: `latestIntentHeads` and the wiring's `intentHeadByProject` both key on the
  pair, reading the id back out of the record text's `thread <id>: ` prefix. That parse is ANCHORED to
  the id shape, `^thread (t-[0-9a-f]{8}): `, and a text that does not match is treated as unthreaded,
  or a record beginning "thread pool sizing: " would mint itself a lineage. One chain per project
  would not read as one timeline naming five threads, it would leave ONE surviving record per project:
  `applySupersessions` derives a `validTo` onto the record each advance supersedes, and
  `selectValidRecords` then drops it from retrieval and from the projection alike, so four threads out
  of five would disappear from memory rather than sit beside the fifth. Both head maps are in-memory
  state, so keying them by the pair costs no column, no migration and no signature change, and the
  memory record shape, the `memory_records` columns and the HMAC payload (`canonicalSignaturePayload`)
  stay untouched.
  The upgrade needs one more rule for the same reason. Intent records written before the prefix
  existed parse to no thread id, so under pair keying nothing would ever supersede them and they
  would stay valid forever beside the live threads. The rule costs no extra state and is scoped per
  HEAD KEY, not per project: an UNTHREADED head is superseded by the next advance under the SAME key
  whatever thread that advance belongs to, and from then on that key's chains are per thread. The
  key matters for the unowned lineage, whose records carry `project: null` and therefore pass every
  project's retrieval filter (`retrieveMemories` excludes only a record whose project is set and
  differs), so it has to be closed by its own next advance rather than by some project's. Joining
  the legacy record to the thread `reviveIntentState` lifted its slot into would be the tidier story
  and is not available: `visions-intent.json` and the canon have different lifetimes, since a
  missing file, a slot `reviveIntentSlot` refuses, or a project id `pruneIntentProjects` drops all
  leave zero lifted threads while the canon records, keyed by path, survive.
  The prefix carries NO square brackets: `sanitizeProjectionText` rewrites `[` and `]` to parentheses
  on every line `projectionBulletFrom` renders, which is the delivered bullet as much as the projected
  one, and brackets there are reserved for the Glissa-authored id and rank. A
  schema-level thread field was specified and withdrawn (review, 2026-08-27): appending to the
  positional signature payload forces a re-signing migration of every row on disk, and that cost
  belongs to a milestone that needs it, which none of M19 to M21 does.
- **Prompt.** `Current working intent (thread <id>): <text>` for the active thread, then up to two
  other live threads under `Also in flight in this project, not this document:`. The session is told
  it may advance the active thread, open a new one, or leave both alone.
- **Wire.** `visions-intent` keeps its message type; the payload's `intent` object carries
  `{ active: Thread | null, threads: Thread[] }` per project. The browser decoder is a second seam and
  must change with it: `public/visions-view-core.mjs` (`intentStateOfMessage`, `normalizeIntentSlot`,
  `applyIntentMessage`, `intentRows`, `intentSignature`) decodes the payload as a slot and would drop
  the thread shape silently. The dashboard's Visions tab (`public/visions-panel.js`) renders the list
  with the active one first.
- Tests: `tests/visions-intent-core.test.js` (revive both legacy shapes, select by uri then recency,
  refuse unknown thread id, cap and retire, ttl retire on read, unowned never reaches an owned uri);
  `tests/visions-dispatch.test.js` (the object result form survives `readCommentsResult`, a non-string
  non-object intent is dropped, an unknown id is refused); `tests/frontend-visions-view.test.js` (the
  decoder reads threads and the signature changes when the active thread does);
  `tests/visions-dispatch-core.test.js` (`visions.intent.threadTtlMs` survives `resolveVisionsConfig`);
  `tests/control-visions-intent.test.js` extends to the new payload;
  `tests/visions-memory-writers.test.js` (the DELIVERED bullet, rendered through `memoryDeliveryLines`,
  carries the `thread <id>: ` prefix intact rather than only the stored record text; an intent record
  carrying the prefix is NOT refused by the entropy screen; two threads in one project advance along
  two independent head chains; and an unthreaded legacy record is superseded by the next advance under
  its own head key whatever thread it belongs to, a null-project record included, rather than staying
  valid beside the live threads).

### M21: relevance basis, enforced

- Each comment carries `basis: "edit" | "intent" | "structure"`. This per-basis table REPLACES M19's
  blanket range drop inside `filterComments`: `edit` must overlap a touched range plus the margin;
  `intent` may land anywhere in the document but requires an active thread and is dropped when there
  is none; `structure` is folded into `hand` (one sentence, at most one) and never lands as a line
  comment, and it folds in only when the result supplied no `hand` of its own, since the result's own
  hand wins. A comment with no `basis` is dropped. Until this milestone ships, M19's blanket rule
  applies to every comment. The prompt states the three bases and that an untagged comment is
  discarded.
- The drop reason is counted per basis and logged as counts only (`refused: edit=2 intent=1
  untagged=3`), never with the comment text, matching the memory lane's privacy rule.
- A present `basis` becomes required for publish here: M19 retains the field in `sanitizeComments` and
  reads it nowhere, and this milestone is where an absent one starts costing the comment.
- Tests: `tests/visions-dispatch-core.test.js` table over every basis and touch-state combination, and
  M19's wiring assertion that an out-of-range comment never survives `applyDispatchResult` is retagged
  to basis `edit`, so the test moves with the rule rather than passing for the old reason.

## Follow-ons (not planned, recorded so the review is not redone)

Two further milestones were drafted and cut on 2026-08-27 after three review rounds kept finding one
more layer of store plumbing under each. Both are worth doing after M21 ships and the noise drop is
measured; neither is specified here beyond its goal and the blockers the review established, so the
next plan starts from those rather than rediscovering them.

- **Refused advice in the prompt.** Goal: dismissed comments are delivered as an explicit fenced
  "previously refused, do not repeat" section, and a comment matching one is dropped before publish.
  Established blockers: no shipped client sends `visions/dismissFinding` (the VS Code extension has no
  dismiss command, and `toDiagnostic` in `tools/vscode-visions/lsp-convert.js` drops any LSP `data`);
  tier-3 comments have no id and no served registry (`commentsByUri` is transient current state,
  `rememberServedFindings` covers fixes only); feedback records carry only a text-prefix disposition
  and no uri or message hash, and adding fields means new `memory_records` columns, both row mappers,
  both whitelists, and the positional `canonicalSignaturePayload`, which in turn needs a versioned,
  store-driven re-signing migration (`migrateProjectTags` shape) or every row on disk demotes to
  `model` rank on the next load; a dismissal record is `action`-ranked, so it may carry a hash but
  never the model-authored comment text; the hash join needs its own store query; and the whole
  section must register with `noteDelivered` under its own `contentMarker` like the memory section.
- **Project-scoped digest and task-shaped retrieval.** Goal: `readContextDigest` scoped to the owning
  project (its raw root path plus its live worktree roots, via an injected `sessionRoots(projectPath)`
  thunk read per dispatch) and `readMemorySection` querying with the active thread text plus the
  touched-region text instead of the whole buffer. Established facts: `projectForUri` returns an id
  and `matchesScopes` compares raw root strings by equality, so the path must come from
  `projectTagForUri`; unrooted machine-scoped events pass every scope filter by design, so scoping
  excludes other projects' rooted activity and nothing more; the branch name and commit subject are
  already in the digest (`ingest-git-core`). Operator prompts as intent evidence were considered and
  REJECTED: a dispatch prompt goes to the model vendor, and the AGENTS.md invariant that memory never
  widens what leaves the machine is not worth an exception for it.

## Non-goals

- A manual intent editor, lock, or correction surface (removed 2026-08-22; a wrong thread is fixed in
  the gate or the evidence).
- Semantic or embedding retrieval (dropped 2026-08-23 with the `rankCandidates` seam).
- Comments on non-markdown buffers; `isMarkdownDoc` keeps gating dispatch.
- Any new timer in the lane; decay and retirement happen on read.

## Testing

`npm test` throughout. Each milestone above names the test file that pins its rule, and a rule with no
named test is not shipped. The wiring tests keep the existing fake-clock and fake-dispatch harness so
every gate decision is replayable from `state`, `now` and the inputs. The prompt claim these
milestones actually make is narrower than blanket byte-identity: an EDIT dispatch in a project with NO
stored intent at all renders its intent lines exactly as today, both rendering nothing, and the
orientation prompt is the only new prompt shape the lane grows. Both are asserted in
`tests/visions-dispatch-core.test.js`. Two neighbouring states are deliberately NOT byte-identical and
are pinned as CHANGES instead. A project holding no thread of its own but a legacy global statement
renders that global text today through `intentTextFor` and renders nothing after M20, which is Problem
item 3's leak closing, pinned by the M20 selection test. And an edit prompt with no touched ranges is
not a state to assert about at all: M19 classifies a dispatch on a uri with no touched range as an
orientation, so it never reaches the edit prompt.
