<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-19 | Updated: 2026-08-19 -->

# packs

## Purpose
Version-controlled input to the context mill: pack specs and the shared source material they assemble. Built output never lands here; it goes to `~/.glissa/packs/built/<name>/current/` (runtime artifact, writable even when the install dir is not).

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `specs/` | One `<name>.pack.json` per pack. The filename must match the spec's `name` field |
| `sources/` | Shared source material packs assemble from, e.g. `sources/company-context/*.md` |

## Spec format

```json
{
  "name": "company-context",
  "description": "One sentence on what this pack carries",
  "sources": [{ "glob": "sources/company-context/*.md", "exclude": ["**/archive/**"] }],
  "rules": ["hand-written policy lines folded into the index"],
  "skills": [{ "dir": "skills/voice-style" }],
  "distill": [{
    "output": "sources/company-context/derived/brief.md",
    "sources": [{ "glob": "sources/company-context/*.md" }],
    "instructions": "Regenerate a short brief from the source files."
  }],
  "budgetTokens": 8000
}
```

Every key is validated by `validatePackSpec` in `../server/core/pack-core.js`; unknown keys are a build error, not a silent no-op. A source sets exactly one of `path` (a file or a directory taken whole) or `glob` (`**`, `*`, `?`). Relative patterns resolve against this directory, so a spec reads the same from a repo checkout or a global install; absolute patterns are allowed. `optional: true` is allowed only on a source and means a missing match is skipped instead of failing the build, for derived files the distiller has not written yet. `budgetTokens` is a hard gate: over budget means no output at all.

`distill` is optional. Each entry declares one derived output path under `packs/`, the local source files to summarize, and carbon-unit written `instructions`. The distiller writes only the output file, stamps line 1 with the source hashes, and reports `DISTILLED`, `NO_CHANGE`, or `ERROR` through its result file. The scheduled lane is gated by `config.packDistiller`; manual `glissa pack distill [name] [--dry-run]` is always allowed.

## For AI Agents

### Working In This Directory
- Sources are LOCAL FILES ONLY. No remote fetching in a spec: pack bytes land in `--dangerously-skip-permissions` sessions, so the trust boundary is "files the operator already controls".
- `sources/company-context/` is also read live by `tools/company-context/server.js` (the MCP server), so it is one source of truth, not a copy.
- Adding a source that matches no file fails the build on purpose; fix the pattern rather than dropping the source.
- These files ship in the npm tarball (`package.json` `files`), so keep them reference material, not scratch notes.
- A spec whose sources reach OUTSIDE `packs/` (the `glissa` pack reads `../docs/*.md`) is repo-development context and must be excluded from the tarball, or a global install fails its build on every watch fire and every sweep. `scripts/check-package-files.js` enforces that: a shipped spec whose non-optional sources are not in the whitelist fails the release gate.

### Testing Requirements
- `node --test tests/pack-core.test.js tests/pack-builder.test.js` covers the format and the builder; `glissa pack build` is the end-to-end check.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
