# Plan: Glissa Context Mill (automated context packs)

Status: EXECUTED, 2026-08-19. Research inputs: live-verified Claude Code 2.1.235 injection probes, the public PostHog/context-mill repo, prior-art survey (Repomix, Context7, Mintlify, GitMCP, DeepWiki, llms.txt), and a full inventory of Glissa's current spawn injections.

## Goal

A pack system that gathers context (project docs, house rules, curated prompts), assembles it into versioned, token-budgeted pack directories, and delivers it into every Glissa-spawned Claude Code session with zero target-repo modification. Deliberately MORE automatic than PostHog's mill: their genuine gap is that no upstream change ever triggers a rebuild (no schedule, no content hashing, hand-enumerated URL lists). Ours rebuilds on source change and reaches live sessions without a respawn.

This is the successor direction to the removed Teams product: a stateless versioned artifact plus thin delivery seams, instead of an orchestration runtime.

## What Glissa already injects (inventory, 2026-08-19)

Every spawn:
- Per-session `--settings` file (`detection/settings-injector.js`): 11 HTTP hooks plus conditional PostToolUse, per-session bearer token, 5s timeouts. Hook responses are currently fire-and-forget: `backend.js` replies `{ ok, reason }`, nothing feeds back into the session.
- Env scrub plus `CLAUDE_CODE_NO_FLICKER=1` (`session/core/spawn-env.js`); lane `extraEnv` merges before the scrub.
- `--dangerously-skip-permissions` ON BY DEFAULT for user sessions (absence of `dangerouslySkipPermissions: false` on the project record means skip), and always for both headless lanes. Every pack byte lands in a permissionless session; treat pack content as executable-adjacent.
- Worktree provisioning (`server/git-workspace.js populateWorktree`) junctions the gitignored share list into isolated sessions, including `.claude`, so operator project config already travels into worktrees. This is an accidental proto-pack channel; the mill formalizes it for non-repo content.

Opt-in or lane-specific:
- `--append-system-prompt` anti-slop note (static string, `session/core/anti-slop-prompt.js`).
- `--resume <id>` (captured from hook payloads).
- Headless seed prompts as the argv positional: PR review (`server/pr-review-wiring.js:46-73`) and PostHog investigation (`server/posthog-wiring.js:70-123`), each with a static permissions deny-list in the settings file.
- PTY pastes through `Session.pasteText` (bracketed, never a CR): merge handoff, PostHog issue handoff (scrubbed and fenced), uploaded image path.
- Post-turn hygiene rewrites of the agent's changed files (`server/post-turn-checker.js`), the one path where Glissa mutates agent output.
- Dormant: `enableAllProjectMcpServers` is plumbed end to end but no lane sets it.

Only the anti-slop note and the two deny-lists are fully static; every prompt body is built per session. Nothing today flows Glissa to session mid-turn.

## Verified delivery levers (Claude Code 2.1.235, live-probed)

1. `--add-dir <packdir>` loads `.claude/skills/` and `.claude/commands/` from the added dir; with env `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` it also loads the pack's `CLAUDE.md`, `.claude/rules/*.md` (including `paths:` frontmatter for glob-scoped lazy rules), and `CLAUDE.local.md`. Skills under an added dir HOT-RELOAD mid-session on file change. Richest single lever; works interactive and `-p`.
2. `UserPromptSubmit` HTTP hook returning `{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "..."}}`: verified live per-turn injection through the exact HTTP hook ingress Glissa already runs. Cap ~10,000 chars, must answer within 30s. Nesting and event name must match exactly; a top-level `additionalContext` is silently dropped.
3. `--append-system-prompt-file` (real despite missing from `--help`): file form dodges the cmd.exe shim re-parse and the ~32k command-line limit that forced the anti-slop note quote-free.
4. `--mcp-config` server whose `initialize` `instructions` auto-inject (2KB cap); resources are pull-only via `@` mentions. `mcpServers` inside `--settings` is IGNORED.
5. `--settings autoMemoryDirectory` auto-loads an external `MEMORY.md` (200 lines / 25KB) but Claude WRITES there during the session, so it is not a read-only channel.

Do not build on: `SessionStart` (never fires, three probes, matches the AGENTS.md 2.1.220 note), `claudeMd` settings key (managed policy only), `permissions.additionalDirectories` (file access only, no discovery). Gotcha: an interactive spawn in an untrusted cwd blocks on the workspace-trust dialog before any hook or pack loads.

## Design

House pattern throughout: pure core, thin IO shell, EventEmitter between modules, CommonJS, no new dependencies (YAML is out; specs are JSON).

### Stage 1: Sourcing

A pack spec is a JSON file, `packs/specs/<name>.pack.json` inside the Glissa install (see Decisions). Built output goes to `~/.glissa/packs/built/`. Spec shape:

```json
{
  "name": "company-context",
  "description": "Shared org context for every repo",
  "sources": [
    { "glob": "C:/Users/johnw/context/company/**/*.md" },
    { "glob": "<repo>/docs/*.md", "exclude": ["**/archive/**"] }
  ],
  "rules": ["never use em dashes", "refer to humans as carbon units"],
  "skills": [{ "dir": "C:/Users/johnw/context/skills/voice-style" }],
  "budgetTokens": 8000
}
```

Key departures from PostHog: sources are GLOBS over local files, not hand-enumerated URLs (auto-discovery is the anti-hand-crank move; Context7's `folders`/`excludeFolders` shape), and `rules` is the `commandments.yaml` idea, hand-written policy folded into every build. v1 sources are LOCAL FILES ONLY: no remote fetching, which sidesteps the documented docs-as-supply-chain injection vector entirely. Remote sources are a later phase behind a scan gate.

### Stage 2: Assembly (pure core plus thin builder)

`server/core/pack-core.js` (pure, unit-tested): `(spec, files: [{path, content}]) -> plan` where plan is the output file map plus `manifest.json`: per-source content hashes, a whole-pack version (hash of hashes), built-at stamp, token estimate, and budget verdict. Deterministic: same spec plus same sources yields byte-identical output. No LLM in the content path (the one strong consensus of the prior art: reviewability comes from template expansion plus diffs, not prompting).

`server/pack-builder.js` (IO shell): reads sources async, applies the plan, writes `<packsRoot>/built/<name>/current/` atomically (tmp dir plus rename), keeps the previous build as `previous/` for diffing. Output layout targets lever 1 directly:

```
built/<name>/current/
  CLAUDE.md            (thin index: description, rules, pointers; small on purpose)
  .claude/rules/*.md   (per-source-group rules, paths: frontmatter for lazy load)
  .claude/skills/**    (copied skill dirs)
  manifest.json        (hashes, sources, version, builtAt, tokenEstimate)
```

Hard gates, build fails loudly: `budgetTokens` per pack (Repomix `--token-budget` instinct), a cap on total pack count per session, and a cap on `CLAUDE.md` index size. The Chroma context-rot data and PostHog's own "effectiveness declined as skill descriptions filled the context window" experience make the discovery tier the thing to budget hardest. Progressive disclosure by construction: tiny index, lazy rules, skills that load on activation.

### Stage 3: Delivery

Spawn-time (primary): project config gains `packs: ["company-context", ...]`. `sessions.js` spawn assembly appends one `--add-dir <built dir>` per pack and `spawn-env.js` adds `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`. Zero repo modification, works for worktree sessions and both headless lanes. The session records the delivered pack versions in its snapshot (debug overlay chip, same pattern as `activeAgents`).

Live (the automation crown jewel, two channels that need no respawn):
- Skills hot-reload: a rebuild rewrites files under the added dir; live sessions pick up skill changes mid-session for free (verified CC behavior).
- `UserPromptSubmit` hook response: extend `detection/hook-source.js` and the `backend.js` hook route so the response MAY carry `hookSpecificOutput.additionalContext`. Used sparingly and only for deltas: "pack <name> updated to <version> since this session started; re-read <file> if relevant", staleness notices, never bulk content. Strict budget (default well under the 10k cap), always within the existing 5s hook timeout, and OFF by default per session until a pack update actually lands mid-session.

### The automation loops (the "more automatic" delta)

1. Watch loop: debounced `fs.watch` on each spec's source roots (reuse `detection/watch-debounce.js`), then an async content-hash diff against the manifest; only a real hash change rebuilds. Fallback interval sweep (pr-poller pattern, default 15m, `.unref()`) covers watcher-less edge cases, same belt-and-suspenders as the pairings store. All async, no sync fs on recurring paths.
2. Delivery loop: rebuild emits `pack-updated` (EventEmitter); sessions holding that pack get the next-turn hook notice; the dashboard gets a control broadcast (pack chip flips from stale to current). New spawns always get `current/`.
3. Distiller loop (optional, later, off by default): a scheduled ephemeral `claude -p` session (reuses `server/ephemeral-session.js`, the spawn gate, a deny-list, and the result-file verdict contract from the PR lane) that regenerates DERIVED summaries (for example a distilled architecture brief from a large docs tree) when source drift passes a threshold. Its output is written only into the pack source area as reviewable files stamped with the source hashes they distilled, regenerate-from-base rather than patch, never into any repo. The LLM stays out of the deterministic content path; this lane produces sources, the mill still assembles deterministically.

### Staleness, honestly stamped

`manifest.json` carries `builtAt` plus per-source hashes; the session snapshot carries the delivered version. The dashboard can therefore always answer "how old is the context this session is running on", the Context7 lesson: publish the staleness bound instead of pretending there is none.

## Security

- Packs feed `--dangerously-skip-permissions` sessions. v1 local-only sources keep the trust boundary at "files the operator already controls".
- When remote sources arrive (phase 2+), every built pack gets a pre-release scan gate (PostHog scans BUILT bundles, not sources; documented MCP docs-poisoning incidents make this non-optional) and remote text gets the same fence-as-data treatment the PostHog lane prompt already uses.
- The hook-response channel only ever carries Glissa-authored notices, never source content verbatim, so the live channel cannot become an injection relay.
- Localhost trust boundary unchanged; pack dirs live under `~/.glissa`, mode as for config.

## Milestones

- M1 Assembly: LANDED in 82fc76b and fad74fb, spec format, pure planner, builder, budget gates, and manual build/list CLI.
- M2 Spawn delivery: LANDED in b84d044 and 5ff952f, config `packs`, `--add-dir`, env wiring, and snapshot version stamps.
- M3 Auto-rebuild: LANDED in ff99e6d, watcher plus interval sweep, `pack-updated`, and dashboard staleness chip.
- M4 Live channel: LANDED in 78dbc0b, `UserPromptSubmit` additional context notices with byte-identical ordinary hook replies.
- M5 Consumers and distiller: LANDED in this change, PR-review and PostHog lane pack consumers plus the opt-in distiller lane.

Each milestone lands independently; M1+M2 alone already beat the status quo (versioned, budgeted, portable context with no repo edits).

## Risks

- Pack bloat is the failure mode with receipts (PostHog's own report). Mitigation is structural: hard budgets, pack-count cap, thin-index-plus-lazy-rules layout.
- CC behavior drift: SessionStart deadness, the add-dir env var, hook-response parsing, and hot-reload are all verified on 2.1.235 and could change. Pin what is pinnable in tests; keep the levers few.
- `autoMemoryDirectory` rejected as primary channel because Claude writes into it mid-session.
- Trust dialog can block interactive spawns in untrusted cwds before any pack loads; surface it, do not fight it.

## Decisions (operator, 2026-08-19)

1. Shared pack sources and specs live in a dedicated `packs/` directory inside the Glissa install (this repo), version-controlled with Glissa itself. Built output stays under `~/.glissa/packs/built/` (runtime artifact, writable even when the install dir is not).
2. Distiller lane: yes, and its first target is the glissa pack (distilling this repo's own docs).
3. No auto-derived default pack; every pack is explicit opt-in per project.
