<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# teamlib

## Purpose
Server runtime for the Teams feature: loads team definitions from `teams/`, runs stage pipelines as headless `claude -p` sessions inside throwaway git worktrees, manages the project pack (scaffold, guided setup, shared pack resolution), and enforces deny-lists.

## Key Files

| File | Description |
|------|-------------|
| `team-registry.js` | Load/validate `team.json` (stages, schedule, permissions.deny, pack.required, pack.shared, pack-templates) |
| `team-orchestrator.js` | Run engine: pack scaffold + halt gate, worktree-isolated stage pipeline, verdict gating (SHIP/FIX/BLOCK), bounded FIX revision loop (`revise`/`reviseReads`, maxRounds) |
| `team-output.js` | `.glissa/teams/<id>/` paths, pack scaffold/status, `resolvePackLayout` (THE single resolver mapping required files to shared `.glissa/pack/` vs team-local pack), run log, round archiving |
| `team-git.js` | Per-run git worktree isolation, pack copy-in, commit + rebase-then-fast-forward merge back; park reasons on conflict |
| `team-prompt.js` | Stage prompt builder, embeds pack and run paths |
| `team-setup.js` | Guided pack setup: interview prompt + interactive setup-session helpers (one ephemeral PTY card, not a headless stage) |
| `team-settings.js` | Per-stage spawn options and permission config |
| `team-blacklist.js` | Glob deny-list enforcement (test-only, not published) |
| `project-context.js` | fs-only shell reading an exact top-level allowlist of non-secret files for first-run setup context; never throws, no recursive walk |
| `project-context-core.js` | Pure parser/renderer of that context: string in, deterministic ASCII-clean summary out |

## For AI Agents

### Working In This Directory
- Everything Glissa writes into a target repo lives under `.glissa/` (the team's `outputPath`). Never write elsewhere in a target project.
- Pack ownership split: Glissa owns agents/templates (`teams/`), the project owns the pack. Shared pack files resolve through `resolvePackLayout`, the one resolver every consumer must use.
- Permissions: only `permission.mode: "yolo"` skips prompts; `scoped`/`interactive` hang a headless stage on its first tool call. The deny-list is the real guardrail.
- Merge-back is rebase-then-FF and stages only `outputPath` by default; `writeScope` is the SHIP-gated allowlist for tracked paths, and a team has exactly ONE verdict stage owning it.
- Pack migration is non-destructive: filled team-local copies promote to `.glissa/pack/`; byte-different duplicates are reported `divergent`, never auto-merged or deleted.
- No sync git on recurring paths; the orchestrator runs on the shared event loop.

### Testing Requirements
- `tests/team-*.test.js` and `tests/project-context*.test.js` cover this directory; run `npm test`.
- Orchestrator changes should also keep `tests/team-changelog.test.js` (end-to-end-ish pipeline test) green.

### Common Patterns
- io-shell + pure-core pairs (`project-context.js` / `project-context-core.js`) mirroring `session-core/`.
- Events broadcast over the control WS (`team-run-needs-setup`, `team-pack-updated`, `team-revise-round`, `team-run-complete`).

## Dependencies

### Internal
- `../teams/` - definitions consumed by the registry
- `../sessions.js` / `../backend.js` - stage session spawning and event broadcast
- `../scheduler.js` - scheduled runs

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
