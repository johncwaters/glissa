# Plan: Visions part 3 (long-term memory)

Status: drafted 2026-08-22; nothing shipped. Predecessors: `docs/archive/plan-navigator.md`
(M1 to M5) and `docs/archive/plan-navigator-2.md` (M6 to M11), both fully shipped. `AGENTS.md`
and the code win over this doc. Milestone numbering continues from M11.

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
- **Machine-global scope.** One store per machine, entries tagged per project. Follows the
  existing machine-wide intent model.
- **Ingestion covers every local harness**, not only Claude: the Claude, Codex, and Grok
  transcript roots the ingest lane already tails.
- **Primary delivery is a context pack** through the existing mill, plus a fenced prompt
  section for the Visions dispatch.
- The main consumer is traditional IDE work: the store must be readable directly (markdown on
  disk) by an agent Glissa did not spawn.

## Research summary (2026-08-22)

Two passes fed this plan: a repo constraints sweep and an external survey of memory systems
(mem0, Letta/MemGPT, Zep/Graphiti, LangMem, Cognee, Memori, MCP memory servers, local vector
options, `node:sqlite`). Conclusions the design rests on:

- **Layered hybrid won**: append-only JSONL canon (audit substrate, crash-safe, matches the
  recorder/warehouse patterns), a distilled markdown projection for delivery (the portable,
  vendor-neutral layer; AGENTS.md-style conventions are the de facto interchange format), and
  an OPTIONAL rebuildable `node:sqlite` FTS5 index as a derived cache. Framework adoption was
  rejected: every candidate violates the no-deps rule, and the useful part is their schema
  ideas, which are reimplementable.
- **`node:sqlite` ships FTS5 compiled in** since Node 22.16.0 (nodejs/node PR 57621); the
  module is unflagged but not yet marked stable, and a WAL corruption bug (fixed in SQLite
  3.51.3) bites only with multiple concurrent writers. So: feature-detect, single writer,
  treat the index as disposable and rebuildable from the canon. Absent, retrieval degrades to
  deterministic filtering over the canon plus the distilled markdown.
- **No dependency-light local vector option survives the no-deps rule.** sqlite-vec is a
  per-platform native extension; transformers.js drags onnxruntime. The only clean route is an
  Ollama-if-present probe (`127.0.0.1:11434/api/embed`) degrading to `{ available: false }`
  like the rtk savings lane. Deferred to a `rankCandidates` seam; v1 retrieval is lexical.
- **Schema ideas stolen from the frameworks**: bi-temporal validity (`validFrom`/`validTo`,
  Zep), supersession chains instead of overwrite (Memori), episodic vs semantic vs procedural
  layers with background (never hot-path) formation (LangMem), source-kind trust ranking and
  verifier-gated ingestion (Cloudflare), operator locks (already in `visions-intent-core.js`).
- **Memory poisoning is a real attack class** (OWASP Agentic AI Top 10 ASI06, 2026). Reported
  relapse rate for conversation-only corrections is 100 percent: a correction must be a store
  mutation, never a prompt. Retrieved memory re-entering a prompt is model-generated data and
  gets the full DATA fence treatment.

## Architecture

### Store layout

Everything lives under `configSiblingPath(configPath, 'memory')`, so a temp `GLISSA_CONFIG`
never writes into the real `~/.glissa` (same rule as uploads, recordings, warehouse):

- `memory/canon.jsonl`: append-only event canon. Every remembered fact, one JSON line, never
  rewritten. Retention prune-on-load like the lane ledger (`memoryRetainDays`, default 365).
- `memory/MEMORY.md` plus `memory/topics/*.md`: the distilled projection, written only by the
  distill lane. This is the agent-agnostic surface: plain markdown any harness can read, and
  the only content the pack delivers.
- `memory/tail-state.json`: durable per-file ingestion offsets (signature-gated state writer).
- `memory/index.sqlite`: OPTIONAL derived FTS5 cache (M17). Deletable at any time; rebuilt
  from the canon.

All of these must be added to `ingest-fs-core.daemonWriteRules` ignores, or the store's own
writes publish fs events and poke the dispatch movement signal (documented feedback loop).

### Canon record shape

```json
{
  "id": "m-<hash>",
  "ts": 1766400000000,
  "kind": "intent | feedback | knowledge | preference",
  "layer": "episodic | semantic",
  "project": "<folded repo path or null>",
  "source": { "kind": "operator | observed | model", "vendor": "claude | codex | grok | glissa", "sessionId": "<id or null>" },
  "text": "<capped, scrubbed>",
  "validFrom": 1766400000000,
  "validTo": null,
  "supersedes": "<id or null>",
  "locked": false
}
```

- `{ vendor, sessionId }` provenance from day one, per `docs/plan-agent-adapters.md` M5's
  vendor-namespaced identity direction. Never a bare Claude id.
- `source.kind` is the trust rank: `operator` (a correction, a lock) outranks `observed`
  (a fact derived from an applied edit or a transcript) outranks `model` (a distiller or
  dispatch claim). A `model` record can never supersede a `locked` record; only an operator
  mutation can clear a lock. This is `applyModelIntent` generalized.
- Contradiction handling is a supersession chain plus `validTo`, never an in-place rewrite:
  the canon stays append-only and auditable, and decay is a ranking demotion at read time,
  not a deletion.
- Dates inside `text` are absolutized at write time.

### Write gates (every path in)

One pure core, `server/core/memory-core.js`, owns every decision: record validation, caps
(per-record chars, per-kind counts, whole-canon size), the trust and lock rules, supersession,
retention, and the secret scrub. The scrub runs BEFORE any cut and cuts are line-aligned
(`docs/plan-ingestion.md` scrub-before-cut rule); unlike the bounded ingest rings, this store
is durable, so the residual-leak list there applies with more force. Anything that looks like
a credential is rejected at the gate, not stored and filtered later.

### Feedback loop exclusion

Ingestion keeps `isEphemeralLane` exclusion (visions dispatch, pr-review, posthog, distill):
the lane must never remember what the lane itself said. The distiller's own output enters the
store only through the stamped, post-verified distill path, never through transcript ingestion.

## Milestones

### M12: memory core and store

`server/core/memory-core.js` (pure: record shape, gates, supersession, retention, lock rules,
lexical retrieval scoring) plus `server/memory-store.js` (thin IO shell: sync load at boot,
async append via the atomic writers, prune-on-load, `stop()` drains). Config: top-level
`config.memory`, **file-only, never control-WS settable** (same reasoning as the ingest lane:
an unauthenticated local socket must not be able to widen what is recorded). **Default off**:
this lane durably persists distilled transcript content, so it is opt-in. Off constructs
nothing.

### M13: Visions-surface writers

Wire the funnels that already exist in `server/visions-wiring.js`:

- `logFix` (the single applied/refused funnel for tier 1 edits) writes `feedback` records.
- `commitIntent` writes `intent` records: model proposals as `source.kind: model`, operator
  corrections as `operator` with `locked` mirrored from the intent state. The intent HISTORY
  becomes queryable; `visions-intent.json` stays the live head, unchanged.
- `applyDispatchResult` writes tier 4 hands and accepted-comment facts as `observed`.

Known gap, deliberately deferred: the codeAction PULL path is fire-and-forget, so an explicit
"dismissed" signal does not exist. v1 infers weak negative feedback when the same finding is
served repeatedly without an apply; a real dismissal channel needs a new LSP response path and
is out of scope here.

### M14: transcript ingestion

A second consumer on the agent-log ingest source (`server/ingest-agent-logs.js` and
`server/core/ingest-agent-core.js`), which already tails all three vendor roots, extracts
message content, and excludes ephemeral lanes. Additions: map USER-PROMPT text per vendor
(today only assistant text and tool calls are mapped; this is a mapper change, not new
plumbing), durable offsets in `tail-state.json` so a restart does not re-ingest, EOF-start on
first enable with a bounded, explicitly-invoked backfill (`glissa memory backfill`, cold path,
may be slow) rather than an automatic historical sweep. Raw transcript lines are episodic
material for the distiller, not memories themselves: ingestion writes compact episodic records
(bounded, scrubbed), and semantic facts are formed only by M15, in the background, never on
the hot path.

### M15: distill lane (the projection)

Reuses the pack-distiller pattern wholesale (`server/core/distill-core.js`: stamp line, hash
drift detection, `DISTILLED | NO_CHANGE | ERROR` verdicts, post-verify of the written file).
A scheduled headless lane (24h default, manual `glissa memory distill`, `--dry-run` supported)
reads the canon and rewrites `memory/MEMORY.md` plus `memory/topics/*.md`: merge overlaps,
mark contradictions as supersessions, absolutize dates, drop expired validity, respect locks
(a locked fact is copied verbatim, never rephrased). The distiller prompt fences the canon as
DATA with the `contentMarker` hash fence. Its verdict is believed only after re-hash, and its
proposed store mutations pass the same M12 gates as everything else (verifier-gated
formation). Quantization is the point: the markdown changes only when the distiller runs.

### M16: delivery

- **Pack**: a `memory.pack.json` spec whose sources point at the distilled markdown with
  `optional: true` (the file does not exist until the first distill). Because M15 quantizes
  the content, the mill's deterministic version skip works as designed: no per-turn republish
  churn, no notice storms. The existing watcher sees the distill write and rebuilds; delivery
  to Glissa-spawned sessions is the shipped `--add-dir` path. Per `plan-agent-adapters.md`,
  pack delivery is capability-gated and currently CC-only; a non-CC session gets a
  decision-trace entry and no delivery. The agent-agnostic guarantee lives in the STORE
  (markdown on disk any harness or IDE agent can read or point an AGENTS.md import at), not
  in this delivery channel.
- **Dispatch prompt**: `buildVisionsPrompt` gains a memory section through the same guarded
  provider pattern as `readContextDigest` (a throwing provider costs the section, never the
  dispatch): top-K relevant records for the active project, hash-fenced, framed as DATA and
  background context only, zero lines when empty so a memory-off prompt stays byte-identical.
- Memory content never reaches lane logs (lane-log privacy rule: counts, ids, verdicts only)
  and is never broadcast to remote-trust sockets.

### M17: retrieval index (optional, last)

`node:sqlite` FTS5 as a rebuildable derived cache: feature-detect at construction (Node
22.16+ and successful module load; absent means lexical scoring from M12 continues to serve),
single writer, delete-and-rebuild from the canon on any schema or corruption doubt. BM25 plus
`kind`/`project`/validity predicates. No npm dependency. A `rankCandidates` seam is left where
an Ollama-if-present embedding probe could slot in later; vectors themselves are a non-goal.

## Non-goals (v1)

- No vector database, no embedding dependency, no framework adoption.
- No per-project store partitions: one machine-global canon, project TAGS only.
- No remote exposure of memory content (refused on remote-trust, like the visions WS).
- No explicit dismissal telemetry from the editor (deferred; inference only).
- No MCP memory facade (possible later access layer; the store does not depend on it).
- No automatic historical backfill at enable time; backfill is a manual cold-path command.

## Testing

Every pure core gets `node --test` coverage: record gates (trust ranks, locks, supersession,
retention, scrub-before-cut with the leak fixtures from `plan-ingestion.md`), mapper additions
per vendor against captured transcript lines, distill drift and post-verify, prompt-section
fencing (byte-identical when empty), pack spec build with the optional source absent, FTS5
feature-detect fallback. The ingest-consumer exclusion (never remember the lane's own output)
gets a regression test naming the feedback loop.
