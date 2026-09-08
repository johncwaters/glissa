<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-07-31 -->

# docs

## Purpose
Design documents, postmortems, and operator guides. Background reading for why the architecture is the way it is; not loaded by any code.

## Key Files

| File | Description |
|------|-------------|
| `architecture-overview.html` | Architecture map (self-contained HTML page with inline SVG diagrams per subsystem, open in a browser): tiers, session lifecycle and state machine, detection flow, completion gate, worktree auto-rebase and merge, notification flow, PR review, Radar, usage, packs, Visions, remote mode, timing, storage |
| `architecture-review.html` | Best-practice review companion to the overview (HTML, open in a browser): per subsystem, an as-built diagram beside the reference-pattern diagram, findings tagged matches/consider/gap, sources cited (heartbeats, outbox, statecharts, SQLite WAL, merge queues, backoff, Host validation) |
| `postmortem-terminal-detection.md` | Postmortem of the content-scraping detection era; rationale for the structural-signal rewrite and the signal x state matrix |
| `distribution.md` | How Glissa ships: GitHub repo as source of truth, dotfiles-repo provisioning for servers, `npm i -g github:johncwaters/glissa` for a standalone CLI, no registry publishing |
| `testing-cli.md` | Manual CLI test scenarios (`--help`, `--version`, `--port`, `--config`, `doctor`, `npm pack`) to run before a release |
| `plan-ingestion.md` | Plan for the multi-source ingestion lane (terminal, agent logs, git, fs, shell history): M6-M10 shipped, M11 digest quality pass half open (per-source quota tuning outstanding) |
| `plan-agent-adapters.md` | Plan for harness-agnostic Glissa: full CC coupling inventory, live-probed Codex 0.146.0 / Grok 0.2.111 hook and OSC surfaces, AgentAdapter seam design, hook-relay transport, capability gating, milestones M1-M6 |
| `plan-visions-3.md` | Plan for Visions long-term memory: agent-agnostic machine-global store (HMAC-signed append-only canon + distilled markdown projection; contract separated from substrate, which is subordinate to the machine-wide store design pass in `architecture-review.html` section 7), multi-vendor transcript ingestion, memory-distill lane, fenced prompt + pack + direct-read delivery, milestones M12-M17, M12 through M16 shipped (M12b held) |
| `plan-settings-screen.md` | Executed plan (all four phases shipped 2026-08-25) that replaced the 11-tab settings modal with a dedicated Settings view: declarative settings map, sidebar plus anchored sections, four levels (browser, machine, lanes, projects), search with keywords, deep links, per-section save, file-only rows, unattended-actions danger zone; PostHog settings scene as the reference |
| `plan-updates.md` | Executed plan (all three milestones shipped 2026-09-05) for dashboard-driven server updates: target staged in a detached worktree under `.glissa/update/`, handoff at restart by fast-forward plus renames with a recovery shim on the next start, `updateChannel` release or main, server-computed apply refusal, Updates section in Settings |
| `plan-session-trace.md` | Draft plan (2026-09-06) for a per-session trace of prompts, skill expansions, thinking and tool calls with results: transcript tailed by the lane itself on the pure tail core, one `~/.glissa/traces/<id>.jsonl` per session, a Trace tab served to local sockets only |
| `plan-plan-review.md` | Approved design (2026-09-07) for reviewing agent plans from the Focus center and the phone: the `ExitPlanMode` PermissionRequest hook already carries the full plan, so Glissa holds that reply on a second hook URL until a dashboard decision, an "Answer in terminal" action, a session exit, a server shutdown, or the hook timeout, and the operator reads the whole plan on desktop or phone and approves, edits, or sends section-addressed feedback through the hook decision, with the terminal dialog as the fail-open fallback |
| `plan-plan-review-acceptance.md` | Draft plan (2026-09-08) for proving Plan Review against a real Claude Code: a billed hand-run harness in `test/` driving six scenarios (approve, edited approve, revise with draft chip and diff, accept edits, terminal answer, exit during hold) through the control and data sockets, real hook bytes recorded as fixtures for the contract tests, a one-time Firefox and phone walkthrough, and three unit gaps closed |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `archive/` | Superseded design docs and progress logs, kept for historical rationale only. Each file carries a banner pointing back to `AGENTS.md`/`CHANGELOG.md` for current behavior. See `archive/glissa-plan.md` (original pre-0.12 project plan, screen-scraping era), `archive/marketing-team-design.md` (pre-`.glissa/`-pack-convention design doc for the marketing team), `archive/progress.txt` (build log of the first Teams implementation), `archive/product-design-context.md` (older design-context doc; the canonical product definition is the root `PRODUCT.md`), `archive/plan-pr-auto-review.md` (implementation-planning doc predating the shipped GitHub PR Auto-Review feature; see `AGENTS.md`'s "GitHub PR Auto-Review" section), `archive/plan-context-mill.md` (executed plan for the context-pack system; see `AGENTS.md`'s "Context Packs" section), `archive/plan-navigator.md` (executed plan for the pair-navigator lane, M1-M5 all shipped; see the navigator entries in `AGENTS.md`), `archive/plan-navigator-2.md` (executed plan for the remaining navigator tiers, M6-M11 all shipped: tier 1 code actions + autoFix, tier 4 raised hand, model tier 2, blank-line boundary, per-project scoping, durable intent, feature since renamed Visions) |

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
