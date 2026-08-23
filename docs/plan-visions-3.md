# Plan: Visions part 3 (long-term memory)

Status: drafted 2026-08-22; revised the same day after a three-reviewer pass (Codex GPT-5.5
design review, an architecture review verifying every cited seam against the code, and a
security review; all three returned "major revision required" on the first draft). M12 through M16
shipped; M12b shipped 2026-08-23 with the FTS5 index of M17. Predecessors: `docs/archive/plan-navigator.md` (M1 to M5) and
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

- **Layered hybrid won**: an append-only canon (audit substrate, crash-safe), a distilled
  markdown projection for delivery (the portable, vendor-neutral layer), and a rebuildable
  `node:sqlite` FTS5 index as a derived cache. Framework adoption was rejected: every candidate
  violates the no-deps rule, and the useful part is their schema ideas, which are
  reimplementable. As built (M12b): the canon is a table in the machine-wide database rather
  than JSONL segments, and the FTS5 index landed with it rather than waiting for M17.
- **`node:sqlite` ships FTS5 compiled in** since Node 22.16.0 (nodejs/node PR 57621). Operator
  decision 2026-08-23: that version IS the engine floor (`engines.node` moved from `>=18`), and
  the module is REQUIRED for the memory lane rather than optional. The store still
  feature-detects it at construction and stays off with one warning without it; there is no file
  fallback, because two substrates means two sets of bugs. The index remains derived and
  rebuildable, and an unavailable one costs relevance rather than an answer.
- **No dependency-light local vector option survives the no-deps rule.** The Ollama-if-present
  `rankCandidates` seam was considered and DROPPED (operator decision 2026-08-23); ranking is
  bm25 over the FTS5 index, folded into the pure lexical scoring as a bounded bonus.
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

The substrate is the machine-wide `node:sqlite` database (operator decision 2026-08-22, shipped
in M12b on 2026-08-23). M12 through M16 shipped on files first, so the swap had every writer
above it when it landed. What it bought and cost:

- The canon becomes an append-only table (id, ts, kind, layer, project, source fields,
  text, validity, supersedes, lineage, locked, sig), with monthly retention as a keyed
  DELETE instead of segment-file drops. The record HMAC survives unchanged: rows are as
  writable by a local process with file access as JSONL lines were, so the trust claim
  cannot lean on the substrate.
- `tail-state.json`, the delivered-hash (echo suppression) state, and the append watermark the
  distill quiet window reads became tables in the same database, which is the cross-key recovery
  point the review names as primary: a memory write and its bookkeeping agree after a crash by
  transaction, not by luck.
- The `O_EXCL` canon lockfile and the fs.watch reload machinery M12 built for the
  CLI-vs-server race are DELETED: SQLite's own cross-process locking (WAL, busy_timeout)
  is the arbiter, and `forget` becomes one transaction (redact rows, insert tombstone,
  mark projection stale) that a concurrent server append cannot interleave with.
- `node:sqlite` is REQUIRED for the memory lane: at construction the store feature-detects
  the module and on absence `createMemoryStore` returns null, so the lane stays off with one
  lane-log warning. No file fallback: two substrates means two sets of bugs. `engines.node` is
  `>=22.16.0`, the FTS5 floor.
- No migration framework: the schema is created idempotently at open (`CREATE TABLE IF NOT
  EXISTS`), `PRAGMA user_version` names the shape, and a future shape change is a read-old
  write-new pass in code, not a framework. There is NO migration of the M12 file canon
  (operator decision 2026-08-23): the database starts empty, and existing `canon-*.jsonl`
  segments are ignored and left untouched on disk. The import-through-verify-or-demote clause
  this section used to carry is dead.

### Projection versioning (the mill pattern) [SHIPPED with M15]

The projection publishes exactly the way a pack does, because the reasons are the same
(deterministic diffing, cheap unattended rebuild, visible staleness). Shipped 2026-08-23 on the file
substrate rather than waiting for M12b, since M15 needed a published version to measure a run
against. As built:

- A build renders the projection deterministically, computes `version` as the sha256 of every
  delivered byte (the `glissa-distill` stamp line included, so a moved canon is a new version), and
  SKIPS the publish when the version matches the published one. An unchanged canon costs nothing;
  the skip rewrites only `manifest.json`, so the recorded watermark still advances.
- Output rotates `memory/dist/current/` to `memory/dist/previous/` and renames a tmp dir in, with a
  `manifest.json` carrying `version`, `builtAt`, `source` (`trivial` or `distill`), `verdict`,
  `distilledAt`, `recordCount`, `claimCount`, the file hashes and the canon watermark
  (`{ count, lastId, lastTs, hash }`), so a reader can tell exactly how fresh the build is.
- **`memory/dist/current/MEMORY.md` is the canonical direct-read path** (plus
  `dist/current/projects/<slug>.md`); `previous/` is a crash and rollback slot nothing delivers from,
  and `dist-pending/` is the locked-diff holding pen. The M16 pointer documentation names `current/`.
- There is ONE writer, in `memory-store.js`. The M12 trivial renderer became the FALLBACK through it:
  it publishes until a distilled build lands, then stops, and a `forget` forces it back through so
  expunged text cannot wait for tomorrow's run.
- Superseded builds are the mill's `previous/` only; record-level history stays in the canon
  (supersession chains), not in kept build generations.
- Deliberately deferred to M16: every delivery naming its version in the fenced prompt header.

### Store layout (as built after M12b)

The DURABLE state is rows in `glissa.db` beside the resolved config file; only the projection and
the signing key are files, under `configSiblingPath(configPath, 'memory')`, so a temp
`GLISSA_CONFIG` never writes into the real `~/.glissa` (same rule as uploads, recordings,
warehouse):

- `glissa.db`, `memory_records`: the append-only canon, one row per record, carrying its
  `segment_key` so retention (`memoryRetainDays`, default 365) stays the same monthly rule as a
  keyed DELETE rather than a segment-file drop. A row is never rewritten in place except by
  `forget`, and `validTo` is DERIVED from the supersession chain at read time, never stored back.
- `memory_tail_state`, `memory_delivered_hashes`, `memory_meta`: the ingest offsets, the echo
  suppression set, and the append watermark the distill quiet window reads. One row per
  transcript rather than one whole-file write, which is what retired the tail-state race.
- `memory_records_fts`: the derived FTS5 index. Rebuildable from `memory_records` at any time, and
  a count that disagrees with the canon is answered by a rebuild at open rather than a repair.
- `memory/dist/current/MEMORY.md` plus `memory/dist/current/projects/<tag>.md`: the distilled
  projection, published by the versioned writer (M15), project-partitioned. `dist/` is its own directory so any
  future watcher or pack source sees ONLY projection writes, never canon appends, tail-state
  churn, or index WAL traffic.
- `memory/hmac-key`: store-minted signing secret, mode 0600, created on first enable.

The file-era layout M12 shipped (`memory/canon-<YYYYMM>.jsonl` segments, `memory/canon.lock`,
`memory/tail-state.json`) is gone, and an install carrying those files boots empty and leaves them
where they are.

Housekeeping shipped WITH M12, not after: `memory/` added to
`ingest-fs-core.daemonWriteRules` ignores (or the store's own writes publish fs events and
poke the dispatch movement signal) and to `.gitignore` (in dev the config siblings live in
the repo checkout, and durable memory must never become git-visible). M12b added `/glissa.db`
and its WAL siblings to `.gitignore` for the same reason.

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
The `appendJsonLine` primitive lands in `server/json-file.js` (M12b moved the canon off it; it is
still the shared JSONL append primitive). The `forget` CLI lands here.
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

### M12b: database substrate and the FTS5 retrieval index [SHIPPED]

Shipped 2026-08-23. The versioned projection half of this milestone had already landed with M15
(see "Projection versioning"), so what shipped here is the substrate swap plus the M17 index. As
built:

- **`server/glissa-db.js`** is the machine-wide opener: feature detect, `journal_mode=WAL`,
  `busy_timeout`, `PRAGMA user_version = 1`, a 0600 mode on the file, and `defaultDbPath()`
  beside the resolved config file. Memory is its first tenant, so every table it owns is
  prefixed `memory_`; **`server/memory-db.js`** holds that tenant's DDL, prepared statements and
  row mapping, and nothing else. Every decision stayed in `server/core/memory-core.js`.
- **Fresh start, no migration** (operator decision): the database opens empty and existing
  `canon-*.jsonl` segments are ignored and left untouched, pinned by a test.
- **`engines.node` is `>=22.16.0`**, the FTS5 floor. `node:sqlite` is required for the lane and
  `createMemoryStore` returns null without it, one warning, no file fallback.
- **The lockfile and the watch are deleted.** `canon.lock` (pid:nonce, stale re-read, the
  reentrant `withCanonLock`), the `fs.watch` reload, and `tail-state.json` are all gone.
  `forget` is ONE transaction (redact, remove, tombstone) that rolls back whole, and a live
  store notices another process's commit through `PRAGMA data_version` on its next read rather
  than by watching a directory. A `glissa memory backfill` beside a running server no longer
  refuses; a database busy for the whole timeout is still reported to the operator as a refusal
  rather than as a clean pass.
- **Writes are batched.** The M14 consumer hands a whole tick's records to `appendMany`, which is
  one transaction and one prepared INSERT per record, because the commit runs on the event loop
  every session shares.
- **The FTS5 index is derived and rebuildable.** `memory_records_fts` is refilled from the canon
  by `rebuildSearchIndex()`, and a row count that disagrees with the canon triggers exactly that
  at open. `retrieve()` asks it for bm25-ranked CANDIDATES and the pure rules still gate and rank
  them: `retrieveMemories` gained an optional `matchedIds`, folded in as a bounded bonus, so with
  no index the scoring is byte-identical to the lexical path. Query text is tokenized by the
  existing pure tokenizer (`[a-z0-9]+` terms only) and each term is quoted, so remembered or
  operator text can never carry an FTS5 operator. An unavailable index costs relevance, never an
  answer: it falls back silently with one debug note.
- **The Ollama `rankCandidates` seam was dropped** (operator decision), so M17 keeps only the
  non-Claude pack delivery adapter.
- **Security review, 2026-08-23, five findings closed before commit.** HIGH: a `forget` left the expunged
  plaintext greppable in the database file, a regression against the file era's tmp+rename segment
  rewrite. It takes three writes to undo, all verified necessary together: `PRAGMA secure_delete = ON`
  zeroes the freed row, FTS5's own `'rebuild'` command frees the term data a DELETE only tombstones, and
  `PRAGMA wal_checkpoint(TRUNCATE)` reclaims the frames the commit left. MEDIUM: `data_version` was
  sampled AFTER the read and after the commit, so a commit landing in that window was stamped as
  already-loaded and swallowed forever; it is now sampled before the read and inside the write
  transaction. MEDIUM: a `SQLITE_BUSY` returned all-nulls, indistinguishable from the write gates
  refusing every record, so the ingest advanced its offsets past a range nothing remembered; `appendMany`
  now reports `refused` and that transcript's offsets freeze for the process. LOW: `forget` now drops
  `dist/previous/` and `dist-pending/`, which held the pre-forget text. LOW: the database file is
  pre-created 0600 rather than chmod'd after sqlite creates it 0666-and-umask (the WAL and SHM inherit
  that mode).
- Tests: `tests/memory-db.test.js` is new (schema idempotence, keyed month DELETE, index rebuild,
  bounded tail and delivered-hash tables, rollback, `data_version`); `tests/memory-store.test.js`
  moved to the substrate and gained the fresh-start pin, the transactional-forget pin, the
  unchanged-skip and rotation pin, the version-stability pin, the no-sqlite pin and the FTS5
  ranking and fallback pins, plus the security review's canary (a forgotten secret survives nowhere under
  the store, database and WAL included) and its frozen-offset pin. The cross-process forget race test
  collapsed into a `data_version` reload test.

### M13: Visions-surface writers (rescoped) [SHIPPED]

Shipped 2026-08-23 on the M12 file substrate, which M12b moved under them the same day without
touching a writer. The record shaping is pure, in `server/core/visions-memory-core.js`;
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

### M14: transcript ingestion (honest scope) [SHIPPED]

Shipped 2026-08-23 on the M12 file substrate. The pure decisions are in
`server/core/memory-ingest-core.js`; `server/memory-ingest-wiring.js` is the IO shell that owns the
consumer, its tail-state file, the batching and the backfill, and `server/ingest-wiring.js` gained only
one forwarded `agentLogConsumers` option, so it stayed thin. Three details the milestone text below did
not settle, decided in the build:

- A user prompt is a `prompt` record, a KIND added to `memory-core` and deliberately left out of
  `PROJECTED_KINDS`, plus a `fromUserPrompt` flag `buildMemoryRecord` refuses as `knowledge` or
  `preference`. Writing prompts as `intent` records instead would have put raw operator quotes into the
  projection, which is exactly what "the distiller writes claims, not quotes" rules out.
- The mapped `agent-prompt` event kind is absent from `ingest-core.KINDS_BY_SOURCE`, so `publishEvent`
  rejects it outright: the per-consumer routing is the rule, and that absence is the second layer under it.
- Idempotency is a record property rather than a bookkeeping one: an observed record's ts is the moment it
  describes, so its derived id is stable and the store refuses an id it already holds. A backfill cut short
  by its byte budget is therefore safe to re-run, which is what "resumable" needed to mean.

This is fan-out plumbing plus a scrub decision, not a mapper tweak:

- **Seam**: `ingest-wiring.js` gains a publish fan-out list; the memory consumer taps the
  MAPPED event before `ingest-core`'s 400-char fold-and-slice (episodic material needs more
  than a slice), applying the shared scrub plus the durable-record gates itself.
- **User-prompt mapping is a per-consumer opt-in flag on the source, default off.** The
  agent-log mappers currently map assistant text and tool calls only; user prompts feed ONLY
  the memory consumer. A machine with `config.ingest` on and `config.memory` off must
  produce byte-identical ring and broadcast content to today, pinned by test: without this,
  the mapper change would push operator prompt text onto the unauthenticated control WS.
- **Durable offsets are the memory consumer's own state** (`memory_tail_state` since M12b, keyed
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

### M15: the memory-distill lane (new lane, shares only distill-core) [SHIPPED]

Shipped 2026-08-23 on the M12 file substrate. `server/core/memory-distill-core.js` holds every decision;
`server/memory-distill.js` is the IO shell (spawn through the shared gate, hard timeout, result file,
`registerEphemeralSession` under the lane name `memory-distill`). It shares `distill-core` for the stamp
line and the drift check, and `memory-core` gained the watermark and `planProjectionBuild` as the plan
said it would. The pack distiller was NOT reused: its spec validation rejects any output path outside
`packs/`, and its prompt, cwd anchoring and deny-list are spec-shaped.

Six decisions the milestone text did not settle, made in the build:

- **The result contract is structured CLAIMS, not markdown.** The session answers
  `{ verdict, summary, claims: [{ kind, project, rank, ids, text }] }` and Glissa renders the published
  bytes itself. Verifying markdown the model wrote would have meant parsing its formatting as well as its
  provenance; rendering from validated fields makes "no remembered byte reaches a file except through the
  renderer" structural, and it is also what keeps a build byte-deterministic for the version hash.
- **The implied-rank rule.** Each bullet's rank label is its implied rank; it may not exceed the highest
  effective rank among the records it cites, and anything above `model` must cite exactly one record and
  copy its text verbatim (a distillation is itself a model claim, so a derived line can never outrank
  one). That one rule also makes "a locked fact is copied verbatim" mechanical.
- **A locked diff keeps the proposal.** A rephrased, merged or dropped locked record sends the WHOLE
  proposed build to `memory/dist-pending/`, claims included, so an operator can see what was wanted;
  `current/` is left byte-identical and the lane log carries counts only.
- **The whole result is refused as one.** An unresolvable id, a claim mixing projects or record kinds, a
  high-entropy token or a borrowed rank fails the run rather than dropping the claim, matching the
  new-claim cap's own all-or-nothing rule.
- **A canon past the prompt budget is refused, not sliced** (400 projectable records, 200000 rendered
  chars). A slice would silently drop every unshown record from the published projection. In that state
  the fallback renderer is still publishing, so `dist/` stays usable and the failure is visible.
- **The gate is measured against the last DISTILLED build**, not the last published one: a fallback
  publish carries no `distilledAt`, so a fresh enable or a `forget` leaves a run due. The loop ticks every
  15 minutes and runs on `intervalMinutes` (default 1440), so a tick skipped for a busy canon (`quietMs`)
  retries in minutes rather than a day later.

It reads the canon and rewrites `memory/dist/`: merge overlaps, mark contradictions as supersessions,
absolutize dates, drop expired validity, respect locks. The canon is fenced as DATA with its own
`contentMarker` hash fence. Verifier-gating goes past hash-checking, because a hash proves which inputs
were read, not that the claims are faithful:

- **Every projection line carries its source record ids** (`[m-...]`). Post-verify REJECTS
  the write when any id is unresolvable or when a line's implied rank exceeds its sources' lineage.
- **Net-new claims per run are capped** (`memory.distill.maxNewClaims`, default 20); over the cap is
  `ERROR`, not a partial accept.
- **A diff touching a locked record's rendering is queued for operator review** (`dist-pending/` plus a
  lane-log warning; the dashboard-side prompt stays later), never published unattended.
- The distiller's canon writes are force-stamped `model` server-side. It writes none today: it publishes
  the projection, and any supersession it later proposes rides `memoryStore.append`, which stamps.

Config: `config.memory.distill`, file-only like the rest of `config.memory`. Automatic when memory is on
per the operator's "never thought about" rule, with `enabled: false` as the kill switch. CLI:
`glissa memory distill [--dry-run]`; a dry run reads and hashes only and spawns nothing, and a real run is
refused only when the database is busy for its whole timeout, exactly like `memory backfill`.

Security, revised 2026-08-23 after a security review returned BLOCK on the unscoped `--allowedTools=Write`
and after live-probing the real CLI (2.1.241; every clause and its counter-example is in
`server/core/lane-permissions-core.js` and the AGENTS.md section "Ephemeral Lane Write Boundaries"): no
`--dangerously-skip-permissions` and NO allow list, since a bare `Write` allow is what unbounds the
writes and nothing narrower grants the tool (both `Write(<dir>/**)` and `Edit(<dir>/**)` were probed and
neither authorizes a Write); writes confined instead by `defaultMode: acceptEdits` in the managed
settings file over a throwaway cwd, which auto-accepts edits there and refuses them anywhere else, and
which overrides an operator's own `auto` mode so a rule decides rather than an LLM classifier; a
deny-list of Bash, Edit, NotebookEdit, WebFetch, WebSearch, Task plus `git push` and `gh`, and
deliberately NO path denies, which were probed and do not refuse a Write tool call at all; a cwd whose
prefix (`glissa-memory-distill-`) is what `ingest-agent-core` recognizes, so a dropped session id cannot
let the lane re-ingest its own canon-bearing transcript; and the ephemeral-lane registration that
excludes its transcript and attributes its usage. Read, Glob and Grep are deliberately NOT denied: a bare
`Read` deny refuses the Write tool as well (live-probed), so it and the result-file contract cannot both
exist, and the first shipped version of this lane denied them and would have failed every real run.
Claude Code separately refuses edits under its own home as "a sensitive file", which is what covers the
settings.json hook-registration path.

Quantization is the point: `dist/` changes only when a distill run publishes, so anything watching it
(M17 pack carrier) sees daily cadence, not per-append churn.

### M16: delivery (v1: prompt section, direct reads, pack carrier) [SHIPPED]

Shipped 2026-08-23 on the M12 file substrate. Four decisions the milestone text below did not settle,
made in the build:

- **The pack carrier ships the GLOBAL layer only, and `{{projectSlug}}` was not built.** A pack is built
  ONCE per name and delivered to every project that names it, so a per-project topic file inside it either
  rides into an unrelated repo's session or forces per-project build variants. Variants would break the
  single `packVersions[name]` the staleness chip, the Mill tab and `pack-updated` all rest on, for a layer
  the other two channels already deliver project-scoped (retrieval by active project, and an
  operator-authored pointer written in the repo it belongs to). `packs/specs/memory.pack.json` therefore
  names `dist/current/MEMORY.md` and nothing under `projects/`, which honors the cross-project rule at its
  strongest: nothing project-tagged is in the pack at all. Per-project pack delivery is a follow-on, and
  needs the variant-versioning question answered first.
- **`data: true` is a source-level flag, not a memory special case.** It publishes a source's files under
  `data/<slug>/` and keeps them out of `.claude/rules/`; `{{glissaHome}}` (the config dir) may be named
  only by such a source, only anchoring the whole pattern, and only without a `..` segment. The build
  assertion is the second layer under that first one, and it is line-based: a data file's line of 12
  characters or more appearing in `CLAUDE.md` or under `.claude/rules/` fails the build outright.
- **The prompt section costs nothing when memory is off, including a microtask.** A lane with no store
  awaits nothing on the dispatch path, so the pre-M16 timing is preserved as well as the pre-M16 bytes.
- **Delivered lines are rendered in the projection's own bullet shape**, so a line delivered from the
  canon and the same line read out of `dist/` normalize to one echo hash and one registry covers both.

- **Dispatch prompt**: `buildVisionsPrompt` gains a memory section through the same guarded
  provider pattern as `readContextDigest` (a throwing provider costs the section, never the
  dispatch): top-K lexically-relevant records for the ACTIVE project plus the global layer,
  fenced with its OWN `contentMarker` (one marker per untrusted corpus, separate from the
  activity digest), framed as DATA and background context only, zero lines when empty so a
  memory-off prompt stays byte-identical. Record text is never interpolated into any
  unfenced line; outside the fence go headings, counts, and ids only.
- **Direct reads (the IDE story)**: `memory/dist/current/MEMORY.md` and the active project's topic
  file under `dist/current/projects/` are plain markdown any harness or IDE agent reads today. The operator points their
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

The retrieval index shipped early, with M12b. The `rankCandidates` seam (an Ollama-if-present
embedding probe) was DROPPED, operator decision 2026-08-23. What is left:

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
