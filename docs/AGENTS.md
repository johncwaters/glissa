<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-07-31 -->

# docs

## Purpose
Design documents, postmortems, and operator guides. Background reading for why the architecture is the way it is; not loaded by any code.

## Key Files

| File | Description |
|------|-------------|
| `postmortem-terminal-detection.md` | Postmortem of the content-scraping detection era; rationale for the structural-signal rewrite and the signal x state matrix |
| `distribution.md` | How Glissa ships: GitHub repo as source of truth, `claude-setup` provisioning for servers, `npm i -g github:johncwaters/glissa` for a standalone CLI, no registry publishing |
| `testing-cli.md` | Manual CLI test scenarios (`--help`, `--version`, `--port`, `--config`, `doctor`, `npm pack`) to run before a release |
| `plan-navigator.md` | Plan for the real-time AI pair-navigator lane: LSP transport-only shim decision (shim vs native vs rewrite), tiered feedback ladder, intent model, module seams, milestones M1-M5 |
| `plan-agent-adapters.md` | Plan for harness-agnostic Glissa: full CC coupling inventory, live-probed Codex 0.146.0 / Grok 0.2.111 hook and OSC surfaces, AgentAdapter seam design, hook-relay transport, capability gating, milestones M1-M6 |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `archive/` | Superseded design docs and progress logs, kept for historical rationale only. Each file carries a banner pointing back to `AGENTS.md`/`CHANGELOG.md` for current behavior. See `archive/glissa-plan.md` (original pre-0.12 project plan, screen-scraping era), `archive/marketing-team-design.md` (pre-`.glissa/`-pack-convention design doc for the marketing team), `archive/progress.txt` (build log of the first Teams implementation), `archive/product-design-context.md` (older design-context doc; the canonical product definition is the root `PRODUCT.md`), `archive/plan-pr-auto-review.md` (implementation-planning doc predating the shipped GitHub PR Auto-Review feature; see `AGENTS.md`'s "GitHub PR Auto-Review" section), `archive/publishing-npm.md` (npm-registry publish runbook from before the package went private; see `distribution.md`), `archive/plan-context-mill.md` (executed plan for the context-pack system; its notice-channel, read-telemetry and distiller milestones were later deleted, so `AGENTS.md`'s "Context Packs" section is the only current description) |

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
