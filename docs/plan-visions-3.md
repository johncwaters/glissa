# Plan: Visions part 3 (long-term memory)

Status: drafted 2026-08-22; revised the same day after a three-reviewer pass (Codex GPT-5.5
design review, an architecture review verifying every cited seam against the code, and a
security review; all three returned "major revision required" on the first draft). Nothing
shipped. Predecessors: `docs/archive/plan-navigator.md` (M1 to M5) and
`docs/archive/plan-navigator-2.md` (M6 to M11), both fully shipped. `AGENTS.md` and the code
win over this doc. Milestone numbering continues from M11.

## Goal

Give Visions long-term memory: a durable, machine-global store of what has been learned across
sessions, ingested from local agent transcripts and from Visions' own surfaces, and delivered
back into future work. Four kinds of remembered fact:

1. **Intent evolution.** The history behind the single machine-wide intent statement: what was
   being built, when it changed, which corrections the operator made.
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
  (already in `visions-intent-core.js`).
- **Memory poisoning is a real attack class** (OWASP Agentic AI Top 10 ASI06, 2026). Reported
  relapse rate for conversation-only corrections is 100 percent: a correction must be a store
  mutation, never a prompt. Retrieved memory re-entering a prompt is untrusted data and gets
  the full DATA fence treatment.

## Review revisions (2026-08-22)

The first draft failed review on five structural points, all folded in below:

1. **Pack delivery dropped from v1.** The mill emits `CLAUDE.md` and `.claude/rules/*.md`,
   which load as INSTRUCTIONS in `--dangerously-skip-permissions` sessions and cannot be
   fenced; distilled transcript content in a rules file completes a laundering chain from any
   web page an agent once read to standing instructions in every future session. It also
   breaks the pack subsystem's stated invariant ("files the operator already controls").
   Delivery is now the fenced dispatch-prompt section plus direct file reads (see M16); a
   pack CARRIER for the projection, as a non-loaded data file with a build-time assertion
   that no memory-sourced byte lands in `CLAUDE.md` or `.claude/rules/`, is an M17 follow-on.
2. **The canon is a local attack surface, not just a file.** Any local process can append a
   line claiming `source.kind: operator, locked: true` (same threat model the unauthenticated
   control WS already concedes). Records are therefore HMAC-signed by the store, and trust
   fields are server-stamped per write path, never read from input.
3. **Trust laundering closed.** Transcript text is not `observed` (it contains third-party
   and prior-model text), and a delivered memory quoted back by an interactive agent must not
   re-enter at higher rank. Rank vocabulary reworked; lineage cap and echo suppression added.
4. **Milestones resized to the real code.** `logFix` fires only on the `autoFix` push path
   (default off, repeated-word only), so v1 feedback capture is rescoped; the agent-log
   ingest source has EOF-start, in-memory tails and single-consumer publish by design, so
   M14 names the real fan-out and offset work; the pack-distiller cannot write outside
   `packs/` by validation, so M15 is a NEW lane sharing only `distill-core`.
5. **Durable-store hygiene.** Append-only is reconciled with retention via monthly segments;
   an expunge command exists (`glissa memory forget`); `memory/` joins `daemonWriteRules`
   ignores AND `.gitignore` (dev-mode config siblings live in the repo checkout); the
   projection lives in its own subdirectory so no watcher ever fires on canon appends.

## Architecture

### Store layout

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
- `memory/index.sqlite`: OPTIONAL derived FTS5 cache (M17). Deletable at any time.

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

- **Trust ranks, highest first**: `operator` (an explicit correction, a lock, a `forget`),
  `action` (a fact derived from something the operator DID: applied an edit, answered a
  prompt), `reported` (transcript-derived text: what an agent said or read; contains
  third-party and prior-model content and is ranked accordingly), `model` (a distiller or
  dispatch claim). `reported` and `model` are equal for gating purposes; the split preserves
  provenance.
- **Trust fields are server-stamped per write path, never read from input.** The M13 intent
  writer stamps `operator` or `model` from which side of `commitIntent` fired; the ingestion
  consumer stamps `reported`; the distiller's own canon writes are force-stamped `model`.
  A record arriving by any other route has no valid signature and is demoted (below).
- **`sig` is an HMAC** over `{id, ts, kind, source, text, locked}` keyed by `memory/hmac-key`,
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
  record; only an operator mutation clears a lock (`applyModelIntent` generalized).

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

### M13: Visions-surface writers (rescoped)

What actually fires today, wired through the funnels in `server/visions-wiring.js`:

- `commitIntent` writes `intent` records: model proposals stamped `model`, operator
  corrections stamped `operator` with `locked` mirrored. The intent HISTORY becomes durable;
  `visions-intent.json` stays the live head, unchanged.
- `applyDispatchResult` writes tier 4 hands and dispatch comment facts, stamped `model`.
- `logFix` writes `feedback` records where it fires. Honestly stated: `logFix` is reachable
  only from the `workspace/applyEdit` push path, which runs only under `visions.autoFix`
  (default off) and today covers repeated-word fixes only. On a default config M13 produces
  intent and dispatch records but ZERO feedback records.

Real suggestion-feedback capture (goal 2) therefore needs the codeAction pull path to record
a "served" event and an editor-side dismissal signal, which is a new LSP response path. That
is M17 follow-on work; no weak inference from re-serving is attempted in v1 (the reviewers
agreed it would misclassify ignored, unseen, and stale findings as rejections).

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
- **Dependency stated, not hidden**: the agent-log source runs only when `config.ingest`
  and its `agentLogs` source are enabled, both default off. The memory lane warns (lane-log,
  counts only) when enabled with no agent-log source, so `memory.enabled: true` alone cannot
  silently produce an empty store forever.
- **Event-loop budget**: ingestion writes are batched per tick with an explicit per-tick
  record cap and a yield between segments; the cold-start backfill stays a manual
  `glissa memory backfill` command, never automatic.

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

### M16: delivery (v1: prompt section plus direct reads)

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
- **Cross-project filtering**: delivery (prompt section and the documented pointer pattern)
  is active-project topics plus the global file only. Machine-global storage never means
  another client's gotchas ride into an unrelated repo's session.
- **Enforced non-delivery**: memory content never reaches lane logs (privacy rule: counts,
  ids, verdicts only), no `memory-*` control-WS message type exists in v1, and negative
  tests pin BOTH that a remote-trust socket receives none and that nothing memory-shaped is
  in `REPLAYABLE_EXACT`, so the guarantee cannot rot when a dashboard surface is added
  later.

### M17: follow-ons (explicitly post-v1)

In no committed order:

- **Pack carrier**: deliver `dist/` through the mill as a NON-LOADED data file, with a
  build-time assertion that no memory-sourced byte lands in `CLAUDE.md` or `.claude/rules/`,
  and a `{{glissaHome}}` placeholder in spec source paths (a version-controlled spec cannot
  otherwise name a runtime `configSiblingPath`). Requires the M15 quantization already in
  place.
- **Suggestion-feedback telemetry**: a served-event record on the codeAction pull path and
  an editor dismissal signal (new LSP response path), unlocking real `feedback` capture.
- **Retrieval index**: `node:sqlite` FTS5 as a rebuildable derived cache; feature-detect at
  construction (Node 22.16+ AND successful module load; Glissa's floor is Node 18, so
  absence is normal, not degraded), single writer, delete-and-rebuild on any doubt.
- **`rankCandidates` seam**: Ollama-if-present embedding probe, absent-by-default.

## Non-goals (v1)

- No pack delivery of memory (M17 carrier at the earliest, data-file-only with assertions).
- No vector database, no embedding dependency, no framework adoption.
- No per-project store partitions: one machine-global canon, project TAGS; partitioning
  exists only in the projection and at delivery.
- No remote exposure of memory content (refused on remote-trust, like the visions WS).
- No dismissal telemetry and no inferred rejections (M17; inference was reviewed and cut).
- No MCP memory facade (possible later access layer; the store does not depend on it).
- No automatic historical backfill at enable time; backfill is a manual cold-path command.

## Testing

Every pure core gets `node --test` coverage: record gates (trust ranks, server-stamping,
lock rules, lineage caps, supersession, retention-by-segment, scrub-before-cut with the leak
fixtures from `plan-ingestion.md`, high-entropy rejection), HMAC sign/verify/demote, echo
suppression, `forget` tombstone-and-reseal, mapper additions per vendor against captured
transcript lines, the byte-identical pin for ring and broadcast content with memory off,
distill post-verify (unresolvable id rejection, rank escalation rejection, new-claim cap,
locked-diff refusal), prompt-section fencing (separate marker, byte-identical when empty),
and the two delivery negative tests (no memory on remote-trust, none in `REPLAYABLE_EXACT`).
The feedback-loop pair (ephemeral-lane exclusion plus echo suppression) gets a regression
test naming the loop it prevents.
