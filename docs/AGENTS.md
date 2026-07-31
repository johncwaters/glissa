<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-07-31 -->

# docs

## Purpose
Design documents, postmortems, and operator guides. Background reading for why the architecture is the way it is; not loaded by any code.

## Key Files

| File | Description |
|------|-------------|
| `postmortem-terminal-detection.md` | Postmortem of the content-scraping detection era; rationale for the structural-signal rewrite and the signal x state matrix |
| `PRODUCT.md` | Older design-context doc; the canonical product definition is the root `PRODUCT.md` |
| `publishing.md` | npm release process: `npm run release` (`scripts/release.js`) as the primary path, with a manual walkthrough appendix as fallback |
| `testing-cli.md` | Manual CLI test scenarios (`--help`, `--version`, `--port`, `--config`, `doctor`, `npm pack`) to run before a release |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `archive/` | Superseded design docs and progress logs, kept for historical rationale only. Each file carries a banner pointing back to `AGENTS.md`/`CHANGELOG.md` for current behavior. See `archive/glissa-plan.md` (original pre-0.12 project plan, screen-scraping era), `archive/marketing-team-design.md` (pre-`.glissa/`-pack-convention design doc for the marketing team), `archive/progress.txt` (build log of the first Teams implementation) |

## For AI Agents

### Working In This Directory
- Docs are historical context: when a doc conflicts with `AGENTS.md` or the code, the code and `AGENTS.md` win.
- Keep the no-dash/no-emoji house style in any new doc.
- Detection work should cite `postmortem-terminal-detection.md` rather than restating it.
- A doc that becomes fully superseded moves to `archive/` via `git mv` (never deleted outright) with a short banner paragraph at the top naming what replaced it.

### Testing Requirements
- None; prose only.

## Dependencies

### Internal
- Referenced by `AGENTS.md` and code comments (notably detection and spawn-gate modules).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
