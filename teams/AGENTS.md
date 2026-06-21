<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# teams

## Purpose
Glissa-owned team definitions: reusable brand-neutral role prompts, pack-template scaffolds, and per-team rosters (`team.json`). Glissa owns the agents as reusable blocks; the target project owns the pack (its specifics live in `<project>/.glissa/`). See `README.md` here for the operator-facing overview.

## Key Files

| File | Description |
|------|-------------|
| `README.md` | Operator docs: the agents-vs-pack ownership split and team layout |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `_shared/agents/` | Reusable role prompts (researcher, strategist, writer, editor, publisher), referenced by any team |
| `_shared/pack-templates/` | Reusable pack scaffolds (voice-guide, avoid-list, brand, channels, content-calendar), fallback for any team |
| `marketing/` | Marketing pipeline roster (`team.json` only; composes entirely from `_shared`) |
| `changelog/` | Changelog pipeline: `team.json` + its own `agents/` (analyst, curator, announcer, auditor) and `pack-templates/` |
| `qa/` | QA green-the-suite pipeline: `team.json` + its own `agents/` (runner-triager, fixer, auditor, reporter) and `pack-templates/` |
| `qa-walk/` | QA persona-walk (exploratory friction): `team.json` + its own `agents/` (walk) and `pack-templates/`; opts into app runtime (`runtime`) to boot the target app and drive Playwright MCP |

## For AI Agents

### Working In This Directory
- Compose, do not copy: a stage resolves its prompt by explicit `stage.agent` (shared role by name, path traversal rejected) > team-local `agents/<id>.md` > `_shared/agents/<id>.md`. A new team should reuse shared blocks wherever possible.
- Shared role prompts must stay brand-neutral: never embed a specific project's brand, voice, or URLs (those belong in the project pack).
- A shared pack file (`pack.shared` in `team.json`) templates ONLY from `_shared/pack-templates/`; per-team templates are for team-local pack files.
- `team.json` shape is validated by `teamlib/team-registry.js`; check it before inventing new fields.
- Verdict gating: the editor/auditor stage emits SHIP / FIX / BLOCK; `runIfVerdict` stages run only on SHIP; `revise` declares the bounded FIX loop.
- App-runtime teams (a stage that must boot the target app or drive a browser) set `runtime` in `team.json`: `shareLocalContext` brings the project's gitignored context (node_modules, .env*, .claude, .omc) into the run worktree, `enableProjectMcp` pre-trusts the project's `.mcp.json` servers in the headless `-p` stage, and `baseBranch` pins the run's fork point (a missing branch BLOCKS the run). All default OFF, so file-in/file-out teams are unchanged; see `qa-walk`.

### Testing Requirements
- `tests/team-registry.test.js` validates definitions; `tests/team-changelog.test.js` exercises a full pipeline. Run `npm test` after editing any `team.json`.

## Dependencies

### Internal
- Consumed by `../teamlib/` (registry, orchestrator, prompt builder, setup).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
