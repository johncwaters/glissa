# Plan: Visions part 3 (long-term memory)

Status: drafted 2026-08-22; revised the same day after a three-reviewer pass (Codex GPT-5.5
design review, an architecture review verifying every cited seam against the code, and a
security review; all three returned "major revision required" on the first draft). M12 and M13
shipped, M12b held. Predecessors: `docs/archive/plan-navigator.md` (M1 to M5) and
`docs/archive/plan-navigator-2.md` (M6 to M11), both fully shipped. `AGENTS.md` and the code
win over this doc. Milestone numbering continues from M11.

## Goal

Give Visions long-term memory: a durable, machine-global store of what has been learned across
sessions, ingested from local agent transcripts and from Visions' own surfaces, and delivered
back into future work. Four kinds of remembered fact:

1. **Intent evolution.** The history behind the per-project intent statement (one slot per
   project, plus a global slot for a uri no configured project owns): what was being built
   and when it changed. Intent is model-maintained end to end (operator
   decision 2026-08-22: the manual correction and lock surface is REMOVED; a wrong intent is
   a program bug, fixed in the gate, prompt, or cadence, never by hand-editing the
   statement).
2. **Suggestion feedback.** Which advisor output the operator applied vs refused, so the lane
   stops repeating rejected advice.
3. **Codebase knowledge.** Distilled per-project facts observed across sessions: architecture
   decisions, gotchas, conventions.
4. **Operator preferences.** Style and workflow habits, cross-project.

## Hard requirements (operator decisions, 2026-08-22)

- **Agent-agnostic store.** Any model or harness must be able to consume the memory. The STORE
  is vendor-neutral plain text (JSONL canon plus markdown projection); only delivery adapters
  may be vendor-specific. No framework adoption, no vendor retrieval API at the core.
- **Machine-global scope.** One store per machine, entries tagged per project. Machine-global
  STORAGE is not machine-global DELIVERY: what reaches a session is filtered to that session's
  project plus the global layer (review finding; see Delivery).
- **Ingestion covers every local harness**, not only Claude: the Claude, Codex, and Grok
  transcript roots the agent-log ingest source already tails.
- The main consumer is traditional IDE work: the store must be readable directly (markdown on
  disk) by an agent Glissa did not spawn. That requirement is satisfied by the projection file
  itself plus one operator-authored import line; it does not require the pack mill (see
  Delivery).
- **Automatic after one switch** (operator decision 2026-08-22): the system should be
  automatic and almost never thought about. `memory.enabled: true` is the ONLY required
  touch; ingestion, backfill, distillation, projection, pack rebuild and delivery all run
  themselves from there. The remaining operator touches are inherently operator acts
  (`forget`, the rare locked-diff review), not maintenance. Intent has no operator touch at
  all anymore.
- **Memory lives in the database, not files** (operator decision 2026-08-22, superseding the
  earlier wait-for-the-design-pass posture FOR MEMORY): the canon and the lane's operational
  state are tables in the ONE machine-wide `node:sqlite` database beside config.json that
  `docs/architecture-review.html` section 7 constrains (no server process, no migration
  framework, nothing bloated). Memory is that database's first tenant; the design pass for
  the other sidecar files inherits a store that already exists. The PROJECTION stays
  markdown files, since it is the agent-agnostic read surface.
- **Memory is versioned the way the context mill is** (operator decision 2026-08-22): the
  projection publishes as deterministic, hash-versioned builds with current/previous
  rotation and an unchanged-skip, and every delivery names the version it carried. See
  "Projection versioning".

## Research summary (2026-08-22)

Two passes fed this plan: a repo constraints sweep and an external survey of memory systems
(mem0, Letta/MemGPT, Zep/Graphiti, LangMem, Cognee, Memori, MCP memory servers, local vector
options, `node:sqlite`). Conclusions the design rests on:

- **Layered hybrid won**: append-only JSONL canon (audit substrate, crash-safe, matches the
  recorder/warehouse patterns), a distilled markdown projection for delivery (the portable,
  vendor-neutral layer), and an OPTIONAL rebuildable `node:sqlite` FTS5 index as a derived
  cache, deferred past v1. Framework adoption was rejected: every candidate violates the
  no-deps rule, and the useful part is their schema ideas, which are reimplementable.
- **`node:sqlite` ships FTS5 compiled in** since Node 22.16.0 (nodejs/node PR 57621), but the
  module is not yet marked stable and Glissa's floor is Node 18, so the index can only ever be
  feature-detected, optional, and rebuildable. Absent, retrieval is deterministic lexical
  filtering over the canon and projection. Deferred to M17.
- **No dependency-light local vector option survives the no-deps rule.** The only clean route
  is an Ollama-if-present probe degrading to `{ available: false }` like the rtk savings lane.
  Deferred to a `rankCandidates` seam; v1 retrieval is lexical.
- **Schema ideas stolen from the frameworks**: bi-temporal validity (`validFrom`/`validTo`),
  supersession chains instead of overwrite, episodic vs semantic layers with background (never
  hot-path) formation, source-kind trust ranking, verifier-gated distillation, operator locks
  (generic machinery in `memory-core`; the intent lock that inspired them was since removed
  with the manual intent surface).
- **Memory poisoning is a real attack class** (OWASP Agentic AI Top 10 ASI06, 2026). Reported
  relapse rate for conversation-only corrections is 100 percent: a correction must be a store
  mutation, never a prompt. Retrieved memory re-entering a prompt is untrusted data and gets
  the full DATA fence treatment.

## Review revisions (2026-08-22)

The first draft failed a three-reviewer pass on five structural points, each folded into the
Architecture and Milestones sections below (which are the authority; this list is only the
map): pack delivery dropped from v1 (instruction-tier, unfenceable), HMAC-signed canon with
server-stamped trust fields, trust-rank rework with a lineage cap and echo suppression,
milestones resized to what the real code paths fire, and durable-store hygiene (segments,
`forget`, ignore lists).

## Architecture

### Store contract vs substrate

What every later milestone builds against is the CONTRACT, which survives either substrate
outcome of the machine-wide store design pass:

- The canon is append-only with monthly-boundary retention, every record carries the signed
  trust fields, verification demotes rather than trusts, `forget` expunges with an audit
  tombstone, and reads are deterministic.
- The PROJECTION is plain markdown on disk, always. It is the agent-agnostic surface (the
  hard requirement above), so it stays a file no matter where the canon lives.
- All memory-core rules (trust ranks, lineage, locks, supersession, echo suppression, secret
  gates, retrieval scoring) are pure and substrate-blind: they take records, not files.

The substrate is the machine-wide `node:sqlite` database (operator decision 2026-08-22).
M12 and M13 shipped on files while M12b is held, so the swap now has the M13 writers above it as
well. What it buys and costs:

- The canon becomes an append-only table (id, ts, kind, layer, project, source fields,
  text, validity, supersedes, lineage, locked, sig), with monthly retention as a keyed
  DELETE instead of segment-file drops. The record HMAC survives unchanged: rows are as
  writable by a local process with file access as JSONL lines were, so the trust claim
  cannot lean on the substrate.
- `tail-state.json`, the delivered-hash (echo suppression) state, and the distill
  bookkeeping become tables in the same database, which is the cross-key recovery point the
  review names as primary: a memory write and its bookkeeping agree after a crash by
  transaction, not by luck.
- The `O_EXCL` canon lockfile and the fs.watch reload machinery M12 built for the
  CLI-vs-server race are DELETED: SQLite's own cross-process locking (WAL, busy_timeout)
  is the arbiter, and `forget` becomes one transaction (redact rows, insert tombstone,
  mark projection stale) that a concurrent server append cannot interleave with.
- `node:sqlite` is REQUIRED for the memory lane: at construction the store feature-detects
  the module (Node 22.16+; Glissa's floor is 18) and on absence the lane stays off with one
  lane-log warning. No file fallback: two substrates means two sets of bugs.
- No migration framework: the schema is created idempotently at open (`CREATE TABLE IF NOT
  EXISTS`), `PRAGMA user_version` names the shape, and a future shape change is a read-old
  write-new pass in code, not a framework. The M12 file canon migrates the same way: on
  first database open, existing `canon-*.jsonl` segments are imported through the normal
  verify-or-demote gate, then renamed `.imported`.

### Projection versioning (the mill pattern)

The projection publishes exactly the way a pack does, because the reasons are the same
(deterministic diffing, cheap unattended rebuild, visible staleness):

- A build renders the projection from the canon deterministically, computes `version` as
  the sha256 of every delivered byte, and SKIPS publishing when the version matches the
  published one. An unchanged canon costs nothing.
- Output rotates `memory/dist/current/` to `memory/dist/previous/` and renames a tmp dir
  in, atomically, with a `manifest.json` carrying version, `builtAt`, record-count, and the
  canon watermark (max canon rowid included), so a reader can tell exactly how fresh the
  build is.
- Every delivery names its version: the fenced prompt section header carries it, the M16
  pack carrier inherits the mill's own versioning on top, and the direct-read pointer
  documentation tells the operator `current/` is the only path to reference.
- Superseded builds are the mill's `previous/` only; record-level history stays in the
  canon (supersession chains), not in kept build generations.

### Store layout (file substrate, as shipped in M12; replaced by M12b)

Everything lives under `configSiblingPath(configPath, 'memory')`, so a temp `GLISSA_CONFIG`
never writes into the real `~/.glissa` (same rule as uploads, recordings, warehouse):

- `memory/canon-<YYYYMM>.jsonl`: the append-only canon, one segment per month. A record is
  never rewritten in place; retention (`memoryRetainDays`, default 365) drops whole expired
  segments on load, which is how append-only and pruning coexist. Appends go through a new
  serialized `appendJsonLine` primitive in `server/json-file.js` (it has only whole-file
  atomic writers today).
- `memory/dist/MEMORY.md` plus `memory/dist/projects/<tag>.md`: the distilled projection,
  written only by the distill lane, project-partitioned. `dist/` is its own directory so any
  future watcher or pack source sees ONLY projection writes, never canon appends, tail-state
  churn, or index WAL traffic.
- `memory/tail-state.json`: the memory consumer's own durable ingestion offsets.
- `memory/hmac-key`: store-minted signing secret, mode 0600, created on first enable.

Housekeeping shipped WITH M12, not after: `memory/` added to
`ingest-fs-core.daemonWriteRules` ignores (or the store's own writes publish fs events and
poke the dispatch movement signal) and to `.gitignore` (in dev the config siblings live in
the repo checkout, and durable memory must never become git-visible).

### Canon record shape

```json
{
  "id": "m-<hash>",
  "ts": 1766400000000,
  "kind": "intent | feedback | knowledge | preference",
  "layer": "episodic | semantic",
  "project": "<folded repo path or null>",
  "source": { "kind": "operator | action | reported | model", "vendor": "claude | codex | grok | glissa", "sessionId": "<id or null>" },
  "text": "<capped, scrubbed>",
  "validFrom": 1766400000000,
  "validTo": null,
  "supersedes": "<id or null>",
  "lineage": "operator | action | reported | model",
  "locked": false,
  "sig": "<hmac>"
}
```

- **Trust ranks, highest first**: `operator` (a `forget`, or any future explicit operator
  surface; intent has none),
  `action` (a fact derived from something the operator DID: applied an edit, answered a
  prompt), `reported` (transcript-derived text: what an agent said or read; contains
  third-party and prior-model content and is ranked accordingly), `model` (a distiller or
  dispatch claim). `reported` and `model` are equal for gating purposes; the split preserves
  provenance.
- **Trust fields are server-stamped per write path, never read from input.** The M13 intent
  writer stamps `operator` or `model` from which side of `commitIntent` fired; the ingestion
  consumer stamps `reported`; the distiller's own canon writes are force-stamped `model`.
  A record arriving by any other route has no valid signature and is demoted (below).
- **`sig` is an HMAC** over `{id, ts, kind, layer, project, source, text, validFrom, validTo,
  supersedes, lineage, locked}` (every field a trust decision reads; leaving `lineage` or the
  supersession fields out would let an unsigned byte edit defeat the promotion cap the
  signature exists to protect, and leaving `project` out would let one retag a signed record
  into another checkout's projection) keyed by `memory/hmac-key`,
  minted only by `server/memory-store.js`. Load-time verification DEMOTES an unsigned or
  mismatched record to `source.kind: model, locked: false` with a lane-log warning (counts
  only), never trusts it silently and never hard-fails the lane. This is what stops a local
  process from appending itself an `operator, locked` fact.
- **`lineage` is the highest rank in a record's ancestry chain and can only fall.** A
  supersession or distillation of a `model`-lineage record can never produce a record whose
  effective rank exceeds `model`, however many times it is quoted back and re-observed. This
  closes the promotion loop.
- **Echo suppression.** At delivery time the store records normalized line hashes of every
  projection line and prompt-section line it handed out; the ingestion consumer drops
  transcript lines whose normalized form matches, so a session quoting its own delivered
  memory back does not re-ingest it at all. Regression-tested beside the ephemeral-lane
  exclusion.
- Contradiction handling is a supersession chain plus `validTo`, never an in-place rewrite;
  decay is a ranking demotion at read time, not a deletion. Dates inside `text` are
  absolutized at write time. A `model` or `reported` record can never supersede a `locked`
  record; only an operator mutation clears a lock. Locks are generic store machinery with no
  current producer (the intent lock was removed with the manual intent surface); they guard
  whatever operator-authored records exist now or later.

### Write gates (every path in)

One pure core, `server/core/memory-core.js`, owns every decision: record validation, caps
(per-record chars, per-kind counts, per-segment and whole-canon size), the trust and lock and
lineage rules, supersession, retention, echo suppression, and lexical retrieval scoring.

Secrets, tightened for DURABILITY (the ingest rings age out in minutes; this store keeps
things for a year):

- The scrub is the EXPORTED ingest-core scrub, reused, not a second pattern list that can
  drift. Scrub before any cut; cuts line-aligned only.
- On top of it, durable records get a high-entropy rejection heuristic: here a false positive
  costs one memory, not one ring entry, so the trade flips toward rejection.
- USER-PROMPT text is excluded from `knowledge` and `preference` records by default (highest
  pasted-secret density); it can inform `intent` records only through the distiller, which
  writes claims, not quotes.
- The residual-leak classes `docs/plan-ingestion.md` documents (PEM bodies, positional
  secrets, escaped inner quotes) are acknowledged as not fully catchable, which is why the
  expunge path below is v1 scope, not a nicety.

**`glissa memory forget <id|pattern>`** (cold path CLI): writes an operator-ranked tombstone
record, then rewrites and re-signs the affected segments with the matched text removed (the
one sanctioned rewrite; the tombstone is the audit trail), and marks the projection stale so
the next distill run rebuilds it without the expunged content.

### Feedback loop exclusion

Ingestion keeps the `isEphemeralLane` exclusion (visions dispatch, pr-review, posthog,
distill): the lane must never remember what the lane itself said. Echo suppression (above)
extends the same idea to interactive sessions. The distiller's own output enters the store
only through the stamped, post-verified distill path, never through transcript ingestion.

## Milestones

### M12: memory core, store, and a day-one projection

`server/core/memory-core.js` (pure) plus `server/memory-store.js` (thin IO shell: sync load
at boot with signature verification and segment prune, serialized appends, `stop()` drains).
The `appendJsonLine` primitive lands in `server/json-file.js`. The `forget` CLI lands here.
The ignore-list and `.gitignore` entries land here. And a TRIVIAL deterministic projection
(dump valid canon records to `dist/` markdown, grouped by kind and project, no model
involved) lands here too, so every later milestone has an observable surface and the IDE
consumer works before M15 exists.

Config: top-level `config.memory`, **file-only, never control-WS settable** (same reasoning
as the ingest lane: an unauthenticated local socket must not widen what is recorded).
**Default off**; this lane durably persists distilled transcript content, so it is opt-in.
Off constructs nothing. Documented limitation: file-only config blocks a local process from
ENABLING memory, but on an enabled store a local process can still steer content by driving
sessions whose transcripts are ingested; that is inherent to the localhost trust boundary,
and it is why nothing ingested can exceed `reported` rank.

### M12b: database substrate and versioned projection (implementation ON HOLD)

Held (operator decision 2026-08-22): implementing the SQLite substrate now would collide
with the machine-wide store work in flight elsewhere. The decision stands (memory IS a DB
tenant, projection IS mill-versioned); only the build waits for that work to land, and M13+
proceed on the shipped file substrate until then.

The swap described in "Store contract vs substrate", plus "Projection versioning", as one
milestone: `memory-store.js` moves onto the machine-wide `node:sqlite` database (canon,
tail-state, echo-hash, and distill-bookkeeping tables; schema idempotent at open; module
feature-detected, lane off with a warning without it), the file-era lockfile and watch
machinery is deleted, the one-time `.jsonl` import runs through verify-or-demote, `forget`
becomes a single transaction, and the projection starts publishing hash-versioned
current/previous builds with the unchanged-skip and manifest. `memory-core` gains only pure
additions (projection build planning with version hash, watermark rules); every trust rule
is untouched. Tests move with it: the cross-process forget race collapses into a
transactional test, the projection determinism test becomes a version-stability test
(same records, byte-identical build, same version), and a new test pins the unchanged-skip
and the rotation. Security review gate applies again before commit (the trust kernel's IO
changes substrate).

### M13: Visions-surface writers (rescoped) [SHIPPED]

Shipped 2026-08-23 on the M12 file substrate (M12b is on hold, so the writers were built against
`memory-store.js` as it stands). The record shaping is pure, in `server/core/visions-memory-core.js`;
`server/visions-wiring.js` takes the store as an injected `getMemoryStore` thunk (`backend.js`
constructs it ABOVE the lane for that), every writer is a no-op without one, all writes ride one
serialized chain, and a refused or throwing store costs a count or a warning, never the relay or the
dispatch path. Intent records are `semantic`, everything else `episodic`.

What actually fires today, wired through the funnels in `server/visions-wiring.js`:

- `commitIntent` writes `intent` records, all stamped `model`: intent is model-maintained
  with no operator surface, so its history is a chain of model proposals. The per-project
  intent slot is the head of that link, so a record's `project` tag names the slot the
  proposal landed in and a global-slot proposal carries none. The intent HISTORY becomes durable;
  `visions-intent.json` stays the live head, unchanged.
- `applyDispatchResult` writes tier 4 hands and dispatch comment facts, stamped `model`.
- `logFix` writes `feedback` records where it fires. Honestly stated: `logFix` is reachable
  only from the `workspace/applyEdit` push path, which runs only under `visions.autoFix`
  (default off) and today covers repeated-word fixes only. On a default config M13 produces
  intent and dispatch records but ZERO feedback records.

Real suggestion-feedback capture (goal 2) is v1 scope (operator decision 2026-08-22: no
deferring; goal 2 ships with the rest), as two halves in this milestone:

- **Served events**: `codeActionsFor` records which findings were offered per uri, stamped
  `action`. Cheap, server-side only, no protocol change.
- **Explicit dismissal**: a custom LSP notification (`visions/dismissFinding`, carrying the
  finding id) the editor relay may send; the wiring records it as an `action`-ranked
  `feedback` record. An editor whose relay never sends it degrades to served-only capture.
  No weak inference from re-serving is attempted (the reviewers agreed it would misclassify
  ignored, unseen, and stale findings as rejections): absent an explicit dismissal, a served
  finding is simply unlabeled.

As shipped, three details the milestone text did not fix: a served finding has no id of its own, so
its identity is the rule code plus its position and the dedupe key is that plus the uri and buffer
version; only an APPLIED tier 1 fix is remembered, because the editor also refuses on a version race
or a timeout and neither is an operator verdict; and the intent chain head per slot is seeded at
first write from the loaded canon, so a restart continues the chain instead of forking a new one.

### M14: transcript ingestion (honest scope)

This is fan-out plumbing plus a scrub decision, not a mapper tweak:

- **Seam**: `ingest-wiring.js` gains a publish fan-out list; the memory consumer taps the
  MAPPED event before `ingest-core`'s 400-char fold-and-slice (episodic material needs more
  than a slice), applying the shared scrub plus the durable-record gates itself.
- **User-prompt mapping is a per-consumer opt-in flag on the source, default off.** The
  agent-log mappers currently map assistant text and tool calls only; user prompts feed ONLY
  the memory consumer. A machine with `config.ingest` on and `config.memory` off must
  produce byte-identical ring and broadcast content to today, pinned by test: without this,
  the mapper change would push operator prompt text onto the unauthenticated control WS.
- **Durable offsets are the memory consumer's own state** (`memory/tail-state.json`, keyed
  `path + size + mtime + offset`; any mismatch means EOF-restart). The shared source keeps
  its by-design EOF-start in-memory tails and eviction; its semantics do not change for the
  existing ring consumer.
- **`memory.enabled` implies the agent-log SOURCE** (operator decision 2026-08-22): the
  wiring constructs the agent-log tailing when memory is on, even with `config.ingest` off,
  but implies ONLY the source: the ring, the `ingest-activity`/`ingest-snapshot` broadcasts,
  and the dispatch digest stay governed by `config.ingest` exactly as today, so enabling
  memory alone never widens what reaches the control WS or a prompt digest. One switch
  instead of three; the lane-log states which lane the source was constructed for.
- **Event-loop budget**: ingestion writes are batched per tick with an explicit per-tick
  record cap and a yield between segments. The cold-start backfill runs on first enable as
  a background pass under the same byte budget (the usage scanner's budgeted-partial-pass
  pattern), resumable via the durable offsets; `glissa memory backfill` is a manual re-run
  path only.

Raw transcript lines are episodic material, bounded and scrubbed; semantic facts are formed
only by M15, in the background, never on the hot path.

### M15: the memory-distill lane (new lane, shares only distill-core)

The pack-distiller cannot be reused wholesale: its spec validation rejects any output path
outside `packs/`, and its prompt, cwd anchoring, and deny-list are spec-shaped. M15 is a new
headless lane (spawn wrapper through the shared gate, deny-list, scheduler, `glissa memory
distill [--dry-run]`) that shares `server/core/distill-core.js` (stamp line, hash drift,
`DISTILLED | NO_CHANGE | ERROR`, post-verify) and the ephemeral-session registration so its
own transcripts are excluded and its usage is lane-attributed.

It reads the canon and rewrites `memory/dist/`: merge overlaps, mark contradictions as
supersessions, absolutize dates, drop expired validity, respect locks (a locked fact is
copied verbatim, never rephrased). The canon is fenced as DATA with a `contentMarker` hash
fence. Verifier-gating goes past hash-checking, because a hash proves which inputs were read,
not that the claims are faithful:

- **Every projection line carries its source record ids** (`[m-...]`). Post-verify REJECTS
  the write when any id is unresolvable or when a line's implied rank exceeds its sources'
  lineage. Hallucinated claims become mechanically detectable, and provenance survives into
  the projection any harness reads.
- **Net-new claims per run are capped**; over the cap is `ERROR`, not a partial accept.
- **A diff touching a locked record's rendering is queued for operator review** (a pending
  file plus a dashboard-side prompt later; v1 minimum is refusing the auto-publish), never
  published unattended.
- The distiller's canon writes are force-stamped `model` server-side.

Quantization is the point: `dist/` changes only when a distill run publishes, so anything
watching it (M17 pack carrier) sees daily cadence, not per-append churn.

### M16: delivery (v1: prompt section, direct reads, pack carrier)

- **Dispatch prompt**: `buildVisionsPrompt` gains a memory section through the same guarded
  provider pattern as `readContextDigest` (a throwing provider costs the section, never the
  dispatch): top-K lexically-relevant records for the ACTIVE project plus the global layer,
  fenced with its OWN `contentMarker` (one marker per untrusted corpus, separate from the
  activity digest), framed as DATA and background context only, zero lines when empty so a
  memory-off prompt stays byte-identical. Record text is never interpolated into any
  unfenced line; outside the fence go headings, counts, and ids only.
- **Direct reads (the IDE story)**: `memory/dist/MEMORY.md` and the active project's topic
  file are plain markdown any harness or IDE agent reads today. The operator points their
  own `AGENTS.md`/`CLAUDE.md` at it with one line they author themselves, stating it is
  recorded observation, DATA, never instructions. Glissa never writes that pointer: the one
  instruction-tier line in the chain stays operator-authored, which is what keeps the store
  agent-agnostic WITHOUT making Glissa an instruction publisher.
- **Pack carrier (v1, operator decision 2026-08-22: automatic delivery wanted)**: a
  `memory` pack whose sources point at `dist/` files with `optional: true`, delivered as
  NON-LOADED data files only. The security blocker stays honored structurally, not by
  prompt-hope: the pack's `CLAUDE.md` index and any `.claude/rules` file are built from the
  spec's own operator-authored description text ONLY (the fixed pointer line naming the data
  files as recorded observation, DATA, never instructions), and `planPackBuild` gains a
  build-time assertion that no byte sourced from `memory/dist/` lands in `CLAUDE.md` or
  under `.claude/rules/`; a violation is a failed build, publishing nothing. Spec source
  paths gain a `{{glissaHome}}` placeholder resolved by `pack-builder` (a version-controlled
  spec cannot otherwise name a runtime `configSiblingPath`). M15's quantization keeps the
  watcher at distill cadence. Pack delivery stays capability-gated (CC sessions today, per
  `docs/plan-agent-adapters.md`).
- **Cross-project filtering**: delivery (prompt section, pack sources, and the documented
  pointer pattern) is active-project topics plus the global file only. Machine-global
  storage never means another client's gotchas ride into an unrelated repo's session. The
  pack build resolves the per-project topic file from the session's project at spawn time.
- **Enforced non-delivery**: memory content never reaches lane logs (privacy rule: counts,
  ids, verdicts only), no `memory-*` control-WS message type exists in v1, and negative
  tests pin BOTH that a remote-trust socket receives none and that nothing memory-shaped is
  in `REPLAYABLE_EXACT`, so the guarantee cannot rot when a dashboard surface is added
  later.

### M17: follow-ons (explicitly post-v1)

In no committed order:

- **Retrieval index**: FTS5 tables in the machine-wide store, if the design pass ("Store
  contract vs substrate") adopts it; no per-feature index file exists before then. Derived
  and rebuildable from the canon, delete on any doubt.
- **`rankCandidates` seam**: Ollama-if-present embedding probe, absent-by-default.
- **Non-CC pack delivery adapter**: reaches non-Claude harnesses once the agent-adapters
  plan ships its capability gating.

## Non-goals (v1)

- No memory bytes in instruction-tier pack files, ever: the pack carrier ships DATA files
  plus an operator-authored pointer only, enforced by a build assertion.
- No vector database, no embedding dependency, no framework adoption.
- No per-project store partitions: one machine-global canon, project TAGS; partitioning
  exists only in the projection and at delivery.
- No remote exposure of memory content (refused on remote-trust, like the visions WS).
- No inferred rejections (reviewed and cut): feedback is served events plus explicit
  dismissals only.
- No MCP memory facade (possible later access layer; the store does not depend on it).
- No unbudgeted work on the shared event loop: backfill and ingestion are automatic but
  always byte-budgeted, batched, and yielding.

## Testing

Every pure core gets `node --test` coverage: record gates (trust ranks, server-stamping,
lock rules, lineage caps, supersession, retention-by-segment, scrub-before-cut with the leak
fixtures from `plan-ingestion.md`, high-entropy rejection), HMAC sign/verify/demote, echo
suppression, `forget` tombstone-and-reseal, mapper additions per vendor against captured
transcript lines, the byte-identical pin for ring and broadcast content with memory off,
distill post-verify (unresolvable id rejection, rank escalation rejection, new-claim cap,
locked-diff refusal), prompt-section fencing (separate marker, byte-identical when empty),
served-event and `visions/dismissFinding` recording, the pack-carrier build assertion (a
memory byte in `CLAUDE.md` or `.claude/rules/` fails the build) and `{{glissaHome}}`
resolution, and the two delivery negative tests (no memory on remote-trust, none in
`REPLAYABLE_EXACT`).
The feedback-loop pair (ephemeral-lane exclusion plus echo suppression) gets a regression
test naming the loop it prevents.
