# Plan: Navigator part 2 (the remaining tiers)

> Archived 2026-08-22: all milestones (M6 to M11) shipped the same day. Current behavior is
> documented in the root `AGENTS.md` (navigator entries under Key Files and File Structure); this
> doc is kept for design rationale only.

Status: drafted 2026-08-22; M6 to M11 shipped. Predecessor: `docs/archive/plan-navigator.md`
(M1 to M5, shipped). `AGENTS.md` and the code win over this doc.

## What is left

The lane ships tier 2 (rule-based squiggles) and tier 3 (pause-gated comment cards). Unbuilt, in
the order this plan ships them:

| Milestone | Item | Origin in the v1 plan |
|-----------|------|-----------------------|
| M6 | Tier 1: silent fixes via LSP code actions and `workspace/applyEdit` | Tier table, never scheduled |
| M7 | Tier 4: raised hand | Tier table, never scheduled |
| M8 | Model-generated tier 2 diagnostics | "a later question, not a v1 commitment" |
| M9 | Blank-line pause boundary | Boundary list named it; only quiet + save + activity shipped |
| M10 | Per-project scoping | "Per-project scoping comes later" |
| M11 | Durable intent | "Durable intent is a later question" |

Still non-goals, unchanged from v1: no remote-listener `/navigator`, no own editor or browser
extension, no autocomplete, no PTY or screen scraping, no test-run boundary until a real signal
for it exists (see M9).

## M6 tier 1: silent fixes (code actions + workspace edits)

The largest piece, because the transport has no request path in either direction today: the relay
answers `initialize` itself and forwards only notifications (`{ type: 'lsp', method, params }`),
and the daemon sends back only `{ type: 'publishDiagnostics' }` frames which the relay hard-filters
on. Requests with ids exist nowhere past the relay. M6 builds that path once, then puts rule-based
fixes on it.

Two halves, second one gated:

- **Pull half (always on with the lane): `textDocument/codeAction`.** The relay advertises
  `codeActionProvider: true` in its `initialize` result and forwards a codeAction REQUEST to the
  daemon as a new frame shape `{ type: 'lsp-request', id, method, params }`; the daemon answers
  `{ type: 'lsp-response', id, result }` and the relay writes the LSP response to the editor,
  echoing the editor's own id (the relay already synthesizes responses; this reuses that seam, it
  does not add relay-side ids). A daemon that never answers must not hang the editor: the relay
  keeps a pending map with a short timeout (2s) and answers `null` (no actions) on expiry,
  disconnect, or an unknown id. `null` is also the answer while the daemon socket is down. The
  daemon side resolves actions purely: fixes are computed by rules-core at sweep time and STORED
  beside the findings, so the codeAction handler only filters stored fixes by the requested range,
  never re-sweeps.
- **Push half (opt-in, `navigator.autoFix`, default false): server-initiated `workspace/applyEdit`.**
  When a sweep produces a fix whose detector is marked auto-safe, the daemon sends
  `{ type: 'lsp-request', id, method: 'workspace/applyEdit', params }` DOWN to the relay, which
  allocates an editor-facing request id, forwards it, and routes the editor's response back up as
  `{ type: 'lsp-response', id, applied }`. The edit always uses `documentChanges` with a VERSIONED
  text document identifier taken from the mirrored buffer, so an edit racing a keystroke is refused
  by the editor rather than landing on moved text; a refusal is dropped silently (the fix remains
  available via the pull half). Every applied edit is undoable by construction (it is an ordinary
  editor edit) and is logged to the tab changelog below.

Fixes are rule-based only, matching the v1 tier 1/2 posture. Detector fixes in M6:

- `repeated-word`: delete the second word (auto-safe).
- `unclosed-fence`: append a closing fence at end of document (pull-only, never auto-applied: the
  intended fence position is a guess).

Design decisions:

- **`server/core/navigator-fix-core.js` is pure and holds every decision**: fix construction per
  detector (range + newText), the auto-safe classification, range-overlap filtering for codeAction
  requests, the versioned `workspace/applyEdit` payload builder, and the staleness rule (a stored
  fix is valid only for the text hash it was computed against; a didChange invalidates the stored
  fix set with the findings sweep that follows).
- **Rules-core grows a second export** `sweepMarkdownWithFixes(text)` returning
  `{ diagnostics, fixes }`; `sweepMarkdown` stays as-is so every existing caller and test is
  untouched.
- **Relay stays transport.** The pending maps (one per direction) and the timeout are mechanical
  routing, the same class of state as the didOpen replay mirror. No fix logic in the relay.
- **The tab changelog is the tier 1 log surface.** New broadcast
  `{ type: 'navigator-fix', uri, fix: { code, line, message, applied }, ts }`, a capped per-lane
  ring (last 20), carried on `navigator-snapshot` as an additive `fixes` field, rendered as a third
  top-level panel block following the `.navigator-activity` precedent. Applied and refused both
  log; the tab is how the carbon unit audits what the lane touched.
- **Config**: `navigator.autoFix` joins the settable navigator schema in `control-handlers.js`
  (boolean), restart-required like every other navigator key. This milestone also introduces
  `resolveNavigatorConfig` in `server/core/navigator-dispatch-core.js`'s sibling style (a real
  normalizer following `resolveUsageConfig`), because `config.navigator` is currently read as a
  bare truth test with no defaulting seam to hang `autoFix` on.

Tests: `tests/navigator-fix-core.test.js` (fix construction per detector, auto-safe set,
range filtering, versioned payload, hash staleness), `tests/navigator-relay.test.js` additions
(codeAction round trip, pending timeout answers null, daemon-down answers null, applyEdit forward
and response routing, id echo), `tests/navigator-wiring.test.js` additions (stored fixes replaced
per sweep, codeAction filter, autoFix off sends nothing, autoFix on sends versioned edit, refusal
logged not retried, changelog ring cap, snapshot carries fixes), `tests/frontend-navigator-view.test.js`
(changelog block wording). No test spawns an editor; the relay tests drive stdio frames directly,
as they do today.

## M7 tier 4: raised hand

Smallest milestone: the dispatch contract and surfaces already carry everything shaped like this.

- **Contract**: the result file gains an OPTIONAL `hand` string (trimmed, capped 300 chars, invalid
  ignored), validated in `readCommentsResult` exactly like `intent`. The prompt's hard rules gain
  the tier 4 definition: raise the hand only for a structural concern about the document as a
  whole, one sentence, rare.
- **State**: per uri, stored beside comments, replaced wholesale by each dispatch (a dispatch with
  no `hand` clears it), cleared on `didClose`. Broadcast
  `{ type: 'navigator-hand', uri, hand, ts }` (null hand clears), additive `hand` field on the
  snapshot's per-document entries. Not replay-retained, same reasoning as findings: current state,
  repaired by snapshot.
- **Surface**: a visually distinct banner at the top of the uri's section in the tab, plus the
  existing activity-dot path so a hidden tab shows the dot. The carbon unit pulls when ready;
  nothing interrupts the editor, per the tier table.

Tests: `tests/navigator-dispatch.test.js` (optional field validation, absent clears),
`tests/navigator-wiring.test.js` (broadcast, clear on close and on handless dispatch, snapshot),
`tests/frontend-navigator-view.test.js` (banner wording, dot).

## M8 model-generated tier 2

The dispatch result gains an OPTIONAL `diagnostics` array: `[{ line, message }]`, at most 5,
message capped 300, validated with the same line-in-buffer rule as comments. They publish to the
editor as real LSP diagnostics with `code: 'model'` and the existing source, merged as a union
with the rule-based sweep at publish time.

- **Staleness is the design decision, and it is strict**: a model diagnostic anchors to a line in
  a buffer the model saw. Any didChange to that uri drops the stored model diagnostics before the
  next sweep publishes (rule findings re-derive; model findings cannot). "Stale annotations are
  dropped, not accumulated" is the v1 rule and this is its application. A model diagnostic
  therefore lives from its dispatch until the next keystroke in that document, which is exactly
  the reading window between pause and resume. They are also replaced wholesale by the next
  dispatch and cleared on `didClose`.
- **Storage**: a second per-uri map beside `findingsByUri` in the wiring; the tab receives them
  through the existing `navigator-findings` broadcast (they are findings, distinguished by code),
  so the panel needs only wording for the `model` chip.
- **The union is pure**: merge and staleness live in `server/core/navigator-dispatch-core.js`
  beside `sanitizeComments`, as `sanitizeModelDiagnostics` and `mergeDiagnostics`.

Tests: `tests/navigator-dispatch-core.test.js` (validation, caps, merge, drop-on-edit rule),
`tests/navigator-wiring.test.js` (publish union, drop on didChange, replace per dispatch, clear on
close), `tests/frontend-navigator-view.test.js` (model chip).

## M9 blank-line boundary

A blank line typed at the end of a thought is the natural boundary the quiet window approximates
with a 30s wait. Detection is pure: `didChange` content changes are inspected for an inserted
newline that leaves the cursor line empty (`detectBlankLineBoundary(contentChanges, doc)` in
`server/core/navigator-buffer-core.js`, which is the module that already understands both sync
kinds). On detection the wiring evaluates the dispatch gate immediately with `armedBy: 'edit'`,
exactly like the didSave handler, rather than arming a timer. Every other gate still applies, so
this changes WHEN the gate is asked, never what it answers; cooldown and the hour cap keep a
blank-line-heavy typist from spending anything extra.

The test-run boundary stays out: the lane sees editor buffers, and no signal for "a test run
finished" reaches Glissa today. If the ingest lane ever carries one, it arrives through the
existing `noteActivity` seam and gets its own plan line then. Named here so the omission is a
decision, not a miss.

Tests: `tests/navigator-buffer-core.test.js` (detection for both sync kinds, no false positive on
mid-line edits or pasted blocks), `tests/navigator-wiring.test.js` (immediate gate evaluation,
gates still hold).

## M10 per-project scoping

`config.navigator.projects`, an optional array of project ids following the `prReview.projects`
precedent (verbatim-sanitized id list in `control-handlers.js`). Absent means every buffer, which
is current behavior and stays the default.

- **The mapping is the work**: buffers arrive as uris, projects are configured as paths. A new pure
  `server/core/navigator-scope-core.js` owns `pathOfFileUri(uri)` (file scheme only, percent
  decoding, Windows drive-letter form, both slash kinds folded, following the shape-based
  normalization) and
  `isUriInProjects(uri, projectPaths)` (prefix match on normalized paths). A non-file uri
  (untitled buffers) matches nothing when a scope list is set.
- **Enforcement sits at the two entry points**: the sweep path (out-of-scope docs get no sweep, no
  findings, no fixes) and the dispatch gate (a new `out-of-scope` refusal in `decideDispatch`,
  logged like every other gate). The buffer store still mirrors out-of-scope docs, because the
  relay replays them and refusing the mirror would desync reconnect.
- Project paths resolve at construction from `config.projects` via the id list; an id matching no
  project is dropped with a warning, costing the bad entry and nothing else (the pack-list rule).

Tests: `tests/navigator-scope-core.test.js` (uri parsing shapes, prefix rules, non-file uris,
case and slash folding), `tests/navigator-wiring.test.js` (out-of-scope doc swept nothing,
dispatch gate refusal, absent list unchanged), `tests/control-handlers` coverage for the
sanitized key.

## M11 durable intent

An operator-locked intent statement surviving a restart is the whole value; a model statement
regenerates on the next dispatch anyway, but persisting the full state is simpler and costs
nothing, so the whole `{ text, source, locked, ts }` persists.

- **Write path**: `createJsonStateWriter` (`server/json-file.js`, signature-gated, chain-serialized)
  writing `navigator-intent.json` at `configSiblingPath`, the same home as `usage-lanes.json` and
  the other lane state files (the ingest fs source already ignores config siblings). Written from
  `commitIntent`, the one mutation seam, only when the merge reported a change.
- **Read path**: loaded once at wiring construction via a new `intentStatePath` option; a missing,
  corrupt, or invalid file starts empty with a warning, exactly the budget-state failure posture
  (it can only lose a statement, never invent one). Sanitized through the same
  `sanitizeIntentText` on load, source and locked coerced to their domains, anything off-domain
  starts empty.
- No new config key: persistence is not worth a switch. `navigator.enabled: false` still
  constructs nothing and therefore writes nothing.

Tests: `tests/navigator-intent-core.test.js` (load-time coercion rules as a pure
`reviveIntentState`), `tests/navigator-wiring.test.js` (persist on change only, load at
construction, corrupt file starts empty and warns, operator lock survives a reconstruct).

## Order and independence

M6 is the only large milestone and shares no seam with the others; M7 and M8 both extend the
result-file contract and should land in that order so the validation seam is touched once with
the pattern fresh; M9 to M11 are independent single-seam slices. Any order works after M6 to M8;
the table order is the recommendation.

## Risks

- **applyEdit racing a keystroke.** Versioned document identifiers make the editor the arbiter:
  a stale edit is refused, never misapplied. The refusal path is tested, not assumed.
- **Editor support skew for codeAction.** Every target editor (VS Code, Neovim, Helix) supports
  codeAction pull; `workspace/applyEdit` client support is universal in those three. The relay
  answering null on timeout means a client that never answers costs nothing.
- **Model diagnostics as noise.** The strict drop-on-edit rule bounds their lifetime, the cap
  bounds their count, and they ride the existing dispatch gates, so the noise ceiling is the
  tier 3 ceiling.
- **Scope-list misconfiguration.** Absent list = everything, bad id = warned and dropped, so the
  failure mode is the lane doing more than intended, never silently nothing.

Doc gate: the checkable claims in this plan are the milestone tests named above. As milestones
land, their sections graduate into `AGENTS.md` and this doc heads to `docs/archive/`.
