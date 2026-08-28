<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-19 | Updated: 2026-08-19 -->

# packs

## Purpose
Version-controlled input to the context mill: pack specs and the shared source material they assemble. Built output never lands here; it goes to `~/.glissa/packs/built/<name>/current/` (runtime artifact, writable even when the install dir is not).

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `specs/` | One `<name>.pack.json` per pack. The filename must match the spec's `name` field |
| `sources/` | Shared source material packs assemble from, e.g. `sources/house-rules/*.md`. Absent until a spec needs it |

## Spec format

```json
{
  "name": "house-rules",
  "description": "One sentence on what this pack carries",
  "sources": [{ "glob": "sources/house-rules/*.md", "exclude": ["**/archive/**"] }],
  "rules": ["hand-written policy lines folded into the index"],
  "skills": [{ "dir": "skills/voice-style" }],
  "distill": [{
    "output": "sources/house-rules/derived/brief.md",
    "sources": [{ "glob": "sources/house-rules/*.md" }],
    "instructions": "Regenerate a short brief from the source files."
  }],
  "budgetTokens": 8000
}
```

Every key is validated by `validatePackSpec` in `../server/core/pack-core.js`; unknown keys are a build error, not a silent no-op. A source sets exactly one of `path` (a file or a directory taken whole) or `glob` (`**`, `*`, `?`). Relative patterns resolve against this directory, so a spec reads the same from a repo checkout or a global install; absolute patterns are allowed. `optional: true` is allowed only on a source and means a missing match is skipped instead of failing the build, for derived files the distiller has not written yet. `budgetTokens` is a hard gate: over budget means no output at all.

### Data sources and `{{glissaHome}}`

A source may set `data: true`. Its files are published under `data/<slug>/` as plain files instead of being folded into `.claude/rules/`, and the index gets only a fixed pointer line naming them as recorded observation, never their content. That is the carrier for long-term memory (`docs/plan-visions-3.md`, M16), and two rules make it structural rather than a convention: a source pattern may name `{{glissaHome}}` (the directory `config.json` lives in, the one runtime path a version-controlled spec may name) only when it anchors the whole pattern, carries no `..` segment, and sets `data: true`; and a build FAILS, publishing nothing, when any line of a data file turns up in `CLAUDE.md` or under `.claude/rules/`.

`specs/memory.pack.json` is the shipped example. It carries the GLOBAL projection file (`memory/dist/current/MEMORY.md`) and nothing under `projects/`: a pack is built once per name and delivered to every project that names it, so a per-project topic file in it would ride into an unrelated repo's session. Per-project memory reaches a session through the Visions dispatch prompt and the operator's own pointer line instead. Like every spec it is consumer-gated, so it costs nothing until a project delivers it.

`distill` is optional. Each entry declares one derived output path under `packs/`, the local source files to summarize, and carbon-unit written `instructions`. The distiller writes only the output file, stamps line 1 with the source hashes, and reports `DISTILLED`, `NO_CHANGE`, or `ERROR` through its result file. The scheduled lane is gated by `config.packDistiller`; manual `glissa pack distill [name] [--dry-run]` is always allowed.

## For AI Agents

### Working In This Directory
- Sources are LOCAL FILES ONLY. No remote fetching in a spec: pack bytes land in `--dangerously-skip-permissions` sessions, so the trust boundary is "files the operator already controls".
- A pack may NOT be built out of a consumer project's own checkout. Delivery refuses it (`self-referential`, `server/core/pack-core.js`) and so does assignment: a session already loads those files, and the pack is a lossy copy that drifts silently. Two packs distilled from this repo were retired for exactly that.
- Adding a source that matches no file fails the build on purpose; fix the pattern rather than dropping the source.
- These files ship in the npm tarball (`package.json` `files`), so keep them reference material, not scratch notes.
- A spec whose sources reach OUTSIDE `packs/` is repo-development context and must be excluded from the tarball, or a global install fails its build on every watch fire and every sweep. `scripts/check-package-files.js` enforces that: a shipped spec whose non-optional sources are not in the whitelist fails the release gate.

### Testing Requirements
- `node --test tests/pack-core.test.js tests/pack-builder.test.js` covers the format and the builder; `glissa pack build` is the end-to-end check.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

## Invariants

Each entry is a rule, its why, and where it is pinned. Mechanism lives in the code.

### Context Packs

- Deterministic by contract, so the version is a hash and a rebuild diffable. It hashes every DELIVERED file, not just sources, or an edited rule rides out under an unchanged version.
- Budgets are hard gates and a failed build writes NOTHING, leaving the last good `current/` untouched. The always-loaded index has a tighter cap: context rot bites the discovery tier first.
- Both rebuild loops are CONSUMER-GATED, a tree worth packing being one whose walk is expensive; `glissa pack build` stays always allowed. A newly assigned pack builds BEFORE the reload that recreates the session, or it lands after the spawn it exists for.
- The staleness notice is Glissa-AUTHORED only, never pack content, or the hook response becomes an injection relay; only an ACCEPTED callback may consume one.
- An unbuilt, unreadable, `self-referential` or `empty` pack is SKIPPED with a decision-trace entry (`decidePackDelivery`): additive context must never block a spawn, and a pack sourced from inside the consumer's own checkout is a drifting copy of what that session already loads.
- A `data: true` source publishes outside the instruction tier, and the build FAILS if a data line appears in the index or under `.claude/rules/`: a build gate beats a convention.
- Per-project variants flatten into independent pack NAMES, so one version per pack still holds. A foreign project's slug in a delivered path fails the build.
- Sources are local files only: pack bytes land in permissionless sessions, so the boundary stays at files the operator already controls.
- Assignment is a DELTA message: the list is re-read inside the config write, so two dashboards cannot clobber each other.
- Delivery is addressed per PROJECT (its resolved path), never per card record: two records may share one checkout, and a per-record control offered the same project twice. One delta fans over every record on that path, refusing whole when any is at the cap, and the Mill's rows count sessions per project (`server/core/pack-core.js` packConsumerGroups, `tests/control-project-packs.test.js`).
- A reload restarts a recreated session only if it was LIVE: starting a dormant card would spawn a session, with that project's permission setting, nobody asked for.
- A codex card gets packs as ONE `-c developer_instructions` token: a constant directive plus index paths, never `--add-dir` (a writable root), pack bytes, or memory bytes (`session/adapters/codex.js.renderPackArgs`, `tests/agent-codex.test.js`).
