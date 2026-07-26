<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# docs

## Purpose
Design documents, postmortems, and operator guides. Background reading for why the architecture is the way it is; not loaded by any code.

## Key Files

| File | Description |
|------|-------------|
| `postmortem-terminal-detection.md` | Postmortem of the content-scraping detection era; rationale for the structural-signal rewrite and the signal x state matrix |
| `glissa-plan.md` | Original project plan |
| `marketing-team-design.md` | Design doc for the Teams marketing pipeline |
| `PRODUCT.md` | Older design-context doc; the canonical product definition is the root `PRODUCT.md` |
| `publishing.md` | npm publishing notes |
| `testing-cli.md` | How to test the CLI |
| `progress.txt` | Running progress notes |

## For AI Agents

### Working In This Directory
- Docs are historical context: when a doc conflicts with `AGENTS.md` or the code, the code and `AGENTS.md` win.
- Keep the no-dash/no-emoji house style in any new doc.
- Detection work should cite `postmortem-terminal-detection.md` rather than restating it.

### Testing Requirements
- None; prose only.

## Dependencies

### Internal
- Referenced by `AGENTS.md` and code comments (notably detection and spawn-gate modules).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
