# Plan: Agent adapters (harness-agnostic Glissa)

Status: drafted 2026-08-21 from a full coupling sweep plus live probes of Codex CLI 0.146.0 and Grok CLI 0.2.111 on this machine. Nothing here is shipped. `AGENTS.md` and the code win over this doc, and superseded sections move to `docs/archive/` per convention.

## What this is

Glissa today supervises exactly one agent CLI: Claude Code. The state machine, PTY plumbing, WebSockets, notifications, recorder, and most of the usage lane are already agent-neutral; the coupling is concentrated in four seams (spawn, hook detection, OSC title glyphs, session identity/resume) plus a handful of CC-only features (packs delivery, statusLine plan limits, the background-agent completion gate, rtk injection). This plan introduces an AgentAdapter seam so a project record can say `agent: "codex"` or `agent: "grok"` and get a supervised card with honest, labelled detection quality, while `agent: "claude-code"` (the default, and the only value in v1) stays byte-identical to today.

The usage lane is the in-repo precedent: `usage-scan-core` / `usage-codex-core` / `usage-grok-core` already run three vendors through one pipeline with pure per-vendor cores, vendor-namespaced identity, and additive wire fields. The adapter seam applies the same shape to spawning and detection.

## Ground truth from the live probes

Both probes ran against the real installed CLIs under node-pty, capturing hook payloads, OSC bytes, and session files. Evidence artifacts are in the probe scratchpad (referenced at the end); the durable findings:

| Surface | Claude Code (today) | Codex CLI 0.146.0 | Grok CLI 0.2.111 |
|---|---|---|---|
| Hook system | HTTP hooks via per-session `--settings` file | Full CC-shaped hooks, stable, on by default: PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, SessionStart, SessionEnd, UserPromptSubmit, SubagentStart, SubagentStop, Stop. Command/prompt/agent handler types, NO http type. Payload on stdin, snake_case, CC field vocabulary, CC response contract | Full CC-shaped hooks: the CC event set plus PostToolUseFailure, StopFailure, PermissionDenied, Notification. `type: "http"` exists but is SSRF-blocked (https-only AND private-IP deny, hard-coded), so loopback HTTP is unreachable; command hooks work, payloads camelCase on stdin |
| Hook injection | `--settings <file>` per session | `-c 'hooks.<Event>=[{hooks=[{type="command",command="..."}]}]'` on argv (verified; the only form `exec resume` accepts). Needs trust: `--dangerously-bypass-hook-trust` (visible warning item) or a seeded `trusted_hash` | `$GROK_HOME/hooks/*.json` is ALWAYS trusted, no folder-trust prompt; `${VAR}` expansion in command strings. No `-c`-style argv override found |
| Awaiting-input signal | `Notification(awaiting-input)` hook; `idle_prompt` demoted to low confidence | BETTER than CC for approvals: `PermissionRequest` hook plus an `Action Required` OSC title state (`[ ! ] Action Required \| <cwd>` blinking at 1 Hz, persists until answered). No signal for prose questions (no Notification event at all) | `Notification(approval_required)` hook, plus `events.jsonl` `phase_changed: permission_prompt` / `permission_requested` / `permission_resolved`, plus a configurable `action-required` title item (U+26A0 marker) |
| OSC-0 titles | Braille or circle-halves spinner = working, U+2733 = idle | Braille spinner (SAME frame set) + cwd basename = working; bare basename = idle; Action Required state; empty title on exit. ConPTY writes a fake first title (`...codex.exe`) that must be ignored; title-silent until first interaction | Braille spinner (same family), " - "-joined `title.items` grammar, activity words from a closed set, idle = generated session name, configurable via `[ui.notifications]` so the adapter can pin a deterministic format. Also OSC 9;4 progress states |
| Session identity | New id minted per resume; captured from whichever hook arrives | UUID, STABLE across resume; on every hook payload (`session_id`), notify payload (`thread-id`), and `exec --json` (`thread_id`). Files: `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl` | UUIDv7, on every hook payload (`sessionId`). Files: `$GROK_HOME/sessions/<percent-encoded-cwd>/<uuid>/` with `summary.json`, `updates.jsonl`, `events.jsonl` |
| Resume | `--resume <id>` | `codex resume [ID] [PROMPT] [--last]`, `codex exec resume [ID]` (verified end to end). `exec resume` rejects `-C` and `-p` flags; resumed `transcript_path` gains a `\\?\` long-path prefix | `-r [ID]`, `-c`, `-s <uuid>` (new with chosen id), `--fork-session`; `grok sessions list/search/delete` |
| Headless | `claude -p` + result files | `codex exec` with `--json` JSONL event stream (thread/turn/item events, per-turn `usage` block), `-o/--output-last-message <file>`, `--ephemeral`, exit 0/1. All hooks fire | `-p` / `--prompt-file`, `--output-format json` to stdout only (carries `sessionId`, `usage`, `total_cost_usd`), exit 0/1/2. Command hooks fire. A plain `-p` run may persist NO session dir (use `-s` when a transcript is needed) |
| Background work / gate inputs | `background_tasks`, SubagentStart/Stop, teammate events | SubagentStart/SubagentStop in the event table, firing UNVERIFIED (no multi-agent turn probed) | `backgroundTasks` field on payloads, types `shell\|monitor\|subagent`; `Stop` fires an observe-only extra at session end, gate on `reason == "end_turn"` |
| Env / nesting hazards | Scrub CLAUDECODE etc | No CLAUDECODE analog; passes no CODEX_* to children. REAL hazard: a blocking in-app update prompt when upstream has a newer version ("Update now" pre-selected, `--disable in_app_updates` did NOT suppress it), plus directory-trust persistence into the active config | Spawn `~/.grok/bin/grok.exe` DIRECTLY (the `.cmd` shim writes `title %COMSPEC%`, corrupting title detection; the ps1 trampoline adds a layer). `GROK_HOME` relocates auth too (bare relocated home is signed out). By default grok EXECUTES hooks found in `~/.claude/settings.json` (`[compat.claude] hooks = false` is the kill switch). Argv word-splitting under Windows shells (known; direct exe spawn with an args array fixes it) |

Bottom line: both CLIs reach the full hook-equivalent detection tier. This is a stronger position than the pre-probe assumption (title-tier at best). The convergence is not luck; both vendors cloned Claude Code's hook shape, which means Glissa's one-function-wide detection seam (`mapHookToSignal`) ports as a per-agent table, not a redesign.

## Where the coupling lives (sweep summary)

The full file:line inventory is large; this is the condensed map that drives the milestones. Portability tags: EASY (mechanical adapter mapping), MEDIUM (needs a per-agent equivalent), HARD (needs new machinery), CC-ONLY (capability-gated off for other agents).

- **Spawn seam, scattered (MEDIUM overall).** `session/core/spawn-command.js` (whole module, incl. the module-load `CLAUDE_CMD` global at line 84 that every Session shares), `session/core/spawn-env.js` (scrub list 58-63 EASY; `CLAUDE_CODE_NO_FLICKER` 66 and the pack env var 67 CC-ONLY), `session/sessions.js start()` at 1931-2078 (`--settings` 2009, skip-permissions 2014, `--resume` 2021, `extraClaudeArgs` 2027, anti-slop 2032, prompt-positional 2036), the ~15 CC-shaped Session constructor options (148-210), and `backend.js makeSession` 338-376 as the single construction site. The option bag IS the de-facto adapter surface today.
- **Hook detection, one function wide (the good news).** `detection/hook-source.js mapHookToSignal` 45-112 is the ONLY CC-vocabulary translation; HookRouter (114-158) and the `POST /hook/:glissaId/:event` route (`backend.js` 400-455) are neutral transport. `detection/settings-injector.js` is wholly CC (the settings JSON schema, statusLine chain, rtk entry). `sessions.js ingestHookSignal` 451-523 branches on normalized signals plus CC payload fields (`session_id`, `background_tasks`, `agent_id`, teammate fields, `source: clear|compact`).
- **Title source.** `detection/osc-title-source.js`: glyph tables 27-34 CC-ONLY, framing/mechanism neutral, plus the "leading ASCII = not a Claude title" drop rule 131-133 keyed on the `cmd.exe /c claude` spawn form.
- **Identity/resume.** `RESUME_ID_RE` duplicated in `session/core/auto-resume.js:10` and `server/control-handlers.js:16`; `_captureClaudeSessionId` + the `claude-session-id` event (`sessions.js` 543-549) which is also the usage-ledger join key; `session/core/conversation-history.js` is CC-ONLY end to end (reproduces CC's cwd encoding and transcript schema).
- **Completion gate.** `agent-tracker.js` / `gate-release.js` logic is portable, its INPUT vocabulary (dream/shell/monitor/teammate, `background_tasks` shape) is CC's. Gate off per capability until a vendor's background signals are verified live.
- **Headless lanes.** pr-review, posthog, pack-distiller, navigator-dispatch all hardcode `-p` plus CC permission-rule deny lists (`Bash(gh pr merge:*)` syntax, `--allowedTools=`). `server/ephemeral-session.js` is the single lane seam (and listens on `claude-session-id`).
- **CC-ONLY features, to be capability-gated.** Packs delivery (`--add-dir` + env var + the `.claude/rules` output layout), the pack notice channel (UserPromptSubmit response `additionalContext`), pack read telemetry (the `Read` matcher), statusLine relay / plan limits (no other CLI publishes account rate limits), rtk injection in its current `hook claude` + git-bash form (rtk itself ships per-agent init for codex/gemini/cursor and more, so this is MEDIUM long-term: the codex path would ride the same `-c hooks.PreToolUse` injection), `conversation-history.js`, and `/clear`-`/compact` quiet handling in its current form (both other CLIs have PreCompact/PostCompact, so compact-quieting ports later).
- **Usage lane.** Already multi-vendor for SCANNING. Still Claude-assumed: per-card attribution keyed on `resumeSessionId` as a Claude id (`usage-wiring.js` 330-352), lane ledger keyed `claudeSessionId` (`usage-lane-core.js`, `usage-lane-ledger.js`), blocks/burn/plan-limits deliberately Claude-only (correct; they are subscription concepts).
- **Already neutral, no change:** state machine + transition tables, exit-transition, status-source merge, notify-gate, gate-release math, output ring, decision log, recorder (writes payloads verbatim), all of notifications/, ws-sender, control replay, spawn gate, git-workspace, remote auth stack, the whole frontend layout/terminal/phone stack minus copy strings.
- **Tests pinning CC sequences** (must keep passing against the CC adapter unchanged): spawn-command, spawn-env, session-spawn-args, sessions-detection, sessions-resume, claude-session-capture, hook-source, backend-hook-route, agent-tracker, gate-release, notify-gate, osc-title-source, status-source, replay-harness + v2 fixtures, settings-injector-statusline, backend-pack-notice-hook, session-packs, rtk-command, and the usage suites.

## Decision: adapter shape

Considered:

1. **Config-only flags on the existing Session** (a `spawnStyle` string plus per-feature booleans). Rejected: the CC assumptions are not flags, they are vocabularies (event names, payload fields, glyph tables, id formats). Flag soup would smear the seam across every consumer.
2. **One abstract AgentSession subclass per vendor.** Rejected: the repo convention is explicitly "no classes unless the pattern genuinely requires instance state", and the Session class already carries the right state; what varies is pure data and pure functions.
3. **Adapter as data + pure functions, selected at `makeSession`.** Chosen. An adapter is a plain object of tables and pure functions, consumed by the existing Session and the existing detection sources. This matches the seam pattern (pure cores, thin IO shells) and the usage lane's per-vendor-core precedent exactly.

An adapter (`session/adapters/<id>.js`) provides:

| Field | Meaning |
|---|---|
| `id`, `label` | `claude-code` / `codex` / `grok`; display name for cards and copy |
| `resolveCommand()` | Per-agent binary resolution (replaces the module-load `CLAUDE_CMD` global with a lazy per-agent registry; Grok resolves to the real `grok.exe`, never the shims) |
| `buildArgs(opts)` | Pure argv assembly from capability-aware options: hook injection, resume, skip-permissions flag, packs, extra args, prompt placement (argv-positional for CC/Grok, stdin for `codex exec`) |
| `buildEnv(base, opts)` | Per-agent scrub list + sets (CC: the 4-var scrub + NO_FLICKER; Codex: nothing; Grok: `GROK_HOME` when managed) |
| `hookInjection` | How callbacks are wired: `{ kind: 'settings-file' }` (CC), `{ kind: 'argv-config' }` (Codex `-c`), `{ kind: 'home-hooks-file' }` (Grok) |
| `mapHookToSignal(event, payload)` | The per-agent vocabulary table, same output signals as today; includes payload field aliasing (snake_case vs camelCase vs hyphenated) |
| `sessionIdOf(payload)` | Identity capture (`session_id` / `sessionId`), id regex, and a `stableAcrossResume` flag (false for CC, true for Codex and Grok, which retires the re-capture churn there) |
| `resumeArgs(id)` | `--resume` / `exec resume` / `-r` |
| `titleProfile` | Working codepoint sets, idle predicate (glyph for CC, bare-prefix for Codex, session-name for Grok), awaiting-input marker (Codex `Action Required`, Grok U+26A0 item), drop rules (ConPTY first-title artifact, `cmd.exe` leading-ASCII rule) |
| `capabilities` | The gate: `{ hooks, awaitingInput, backgroundAgents, resume, packs, statusLine, rtk, antiSlop, compactQuiet, skipPermissionsFlag, headless }` |

Everything downstream keys behavior on `capabilities`, never on `adapter.id`. A capability an adapter lacks means the feature is inert for that session and the card says so; nothing is faked.

## Hook transport: one ingress, two relays

Glissa's ingress stays exactly `POST /hook/:glissaId/:event` with the per-session bearer token. What changes is how a vendor's hook reaches it:

- **Claude Code:** HTTP hooks direct, unchanged.
- **Codex and Grok:** a new standalone `session/hook-relay.js` (the `statusline-relay.js` mold: never required by the server), registered as a `type: "command"` hook. It reads the JSON envelope from stdin, POSTs it to the loopback ingress, and exits 0 always (a hook must never block the agent). Loopback-target-only, short timeout, fire-and-forget, same rules as the statusline relay.
- **Token and URL ride the SPAWN ENV, never argv.** Glissa sets `GLISSA_HOOK_URL` (token embedded, like the CC hook URLs) in the child env at spawn; hook children inherit the agent process's env, so the relay reads it from `process.env`. This closes the probe-flagged exposure of a token on the Codex `-c` command line (visible to any local process listing), and it makes the Grok hooks file STATIC and inert: a `hooks/glissa.json` whose command is just `node <relay> <event>` does nothing when the env var is absent, so an operator's own terminal `grok` runs are untouched even if the file is present.
- **Event name travels as a relay argv token** (`node <relay> Stop`), not parsed out of the payload, so the ingress route shape (`/:event`) is preserved and a malformed payload still lands on the right handler.
- The ingress accepts the union payload; `mapHookToSignal` is already per-adapter, and the route only needs the existing token check plus the session's adapter to translate.

Per-vendor injection mechanics:

- **Codex:** one `-c 'hooks.<Event>=[{hooks=[{type="command",command="node <relay> <Event>"}]}]'` per subscribed event on the spawn argv (verified working, and the only form `codex exec resume` accepts). Trust: start with `--dangerously-bypass-hook-trust` and its visible warning item; investigate seeding `trusted_hash` in M3 so supervised sessions run warning-free. Neutralize the in-app update prompt before any unattended spawn (find the config key; if none exists, detect the prompt state and answer "skip", never Enter, and surface an update-available note through Glissa's own update-check lane instead).
- **Grok:** a Glissa-managed `GROK_HOME` is the clean path but relocates `auth.json` too, so v1 uses the operator's real home plus an OPT-IN installed `~/.grok/hooks/glissa.json` (env-inert as above), installed by an explicit `glissa agent setup grok` command, never silently. Supervised spawns also set `[compat.claude] hooks = false` for the session (env `GROK_FOLDER_TRUST`-style resolution puts env above config; verify the exact env name in M4) so a supervised Grok session stops executing the operator's Claude Code hooks, which the probe caught happening by default.

## Detection tiers, honestly labelled

| Tier | Signal set | Who reaches it |
|---|---|---|
| hooks | Authoritative structural callbacks incl. awaiting-input | Claude Code; Codex (approvals only for awaiting-input); Grok |
| title | OSC-0 profile only: working/ready, plus awaiting-input where the profile has a marker (Codex, Grok; CC's has none) | Any adapter when hooks are not wired |
| exit | PTY lifecycle only | Fallback of last resort |

The card badge names the live tier. Degradations the code must keep explicit: Codex has NO signal for a prose question that ends a turn (indistinguishable from a completed turn; CC at least has the demoted `idle_prompt`); the completion gate stays OFF for Codex and Grok until their background-work signals are live-verified (SubagentStart/Stop firing unverified on Codex; `backgroundTasks` shape unverified under real background shells on Grok); work-cycle notification semantics start with the degraded no-resume-signal path only if a vendor's UserPromptSubmit proves unreliable (both probes saw it fire, so both should get the full cycle rule).

Grok's `events.jsonl` (`turn_started`/`turn_ended`, `phase_changed` incl. `permission_prompt`, `permission_requested`/`resolved`) is a richer stream than anything CC offers and would make a third StatusSource. Deliberately DEFERRED: it is a file-watch on an undocumented format, the hook tier already covers the same facts, and the no-scraping rule's spirit is fewer bespoke channels, not more. Revisit only if the hook relay proves flaky.

## What stays Claude-only (v1 non-goals)

- Packs delivery. Codex/Grok pack delivery has plausible paths (both read AGENTS.md conventions; Grok's `[compat.claude]` even loads `.claude` rules/skills) but none is verified. Capability-gated off; a project with packs plus a non-CC agent gets a decision-trace entry and no `--add-dir`.
- statusLine relay / plan limits: no equivalent exists. Codex `exec --json` per-turn `usage` and Grok's `total_cost_usd` already reach the usage lane via transcripts.
- Anti-slop `--append-system-prompt`: no exact Codex/Grok equivalent probed; capability off (their AGENTS.md files already carry the standing style rules).
- Headless lanes (pr-review, posthog, distiller, navigator dispatch) keep spawning Claude Code. Routing a lane to `codex exec` is attractive (flat-rate plan, `--output-last-message` matches the result-file contract) but is a cost-policy feature, not an agnosticism prerequisite. Explicitly out of scope here; noted for a later plan.
- `/clear`-`/compact` quiet handling generalization (both vendors have PreCompact/PostCompact; port when a real false-cycle is observed, not speculatively).
- Cross-worktree conversation history (`conversation-history.js`) stays CC; the Resume dialog for other agents lists from their own session stores in a later milestone or not at all.

## Milestones

**M1: seam extraction, byte-identical.** Create `session/adapters/claude-code.js` by MOVING the CC-specific tables and functions out of spawn-command.js, spawn-env.js, hook-source.js, and osc-title-source.js behind the adapter interface; a lazy per-agent command registry replaces the `CLAUDE_CMD` module-load global (also fixes every `require` of sessions.js paying a `where claude`). `makeSession` selects the adapter from `project.agent` (only `claude-code` valid, default when absent, config whitelist updated). Session constructor consumes the adapter instead of the loose option bag where the option is adapter-owned. Acceptance: the full existing test suite passes UNCHANGED (the CC-pinning tests above are the regression net), plus new pins that the spawn argv, injected settings file bytes, and hook handling are byte-identical for a CC session.

**M2: transport + capability plumbing.** `session/hook-relay.js` (pure decisions in `session/core/hook-relay-core.js`: env reading, target validation, payload passthrough rules). Ingress accepts relay-delivered envelopes (no route change; token check identical). `capabilities` gates wired through sessions.js (gate, packs, notices, statusLine, rtk, anti-slop, resume) and surfaced as a card badge + `toSnapshot().agent`. Recorder header gains `agent`; decision trace entries carry it. Acceptance: unit tests for the relay core and every capability-off path; a CC session's recording differs only by the new header field.

**M3: Codex adapter, interactive cards.** `session/adapters/codex.js`: exe resolution, `-c` hook injection for SessionStart/SessionEnd/UserPromptSubmit/Stop/PermissionRequest (PreToolUse deliberately NOT subscribed; per-tool-call callbacks are the pack-read-telemetry mistake without the justification), title profile (braille working, bare-basename idle, Action Required = awaiting-input, ConPTY first-title drop, title-silent spawn window), stable-id capture, `codex resume <id>` (interactive) with the flag-subset constraint honored, update-prompt neutralization, trust handling. Signal map: UserPromptSubmit opens the work cycle, Stop = ready, PermissionRequest = awaiting-input (hook precedence over the title, same StatusSource ordering as today), SessionStart/End lifecycle. Acceptance: a live scripted probe (reusing the M0 probe harness as a `test/` manual script) demonstrating spawn -> working -> awaiting-input -> ready -> resume on a real codex binary; recorded fixture + replay test for the signal sequence; gate off; notifications fire once per cycle.

**M4: Grok adapter.** `session/adapters/grok.js`: direct exe spawn with args array, opt-in `glissa agent setup grok` installing the env-inert hooks file, relay reuse, camelCase field aliasing, `Stop` gated on `reason == "end_turn"`, `Notification(approval_required)` = awaiting-input, pinned `[ui.notifications]` title format + profile, UUIDv7 capture, `-r <id>` resume, `[compat.claude] hooks = false` for supervised sessions. Acceptance: same shape as M3 (live scripted probe, fixture, replay test), plus a test pinning that the installed hooks file is inert without `GLISSA_HOOK_URL`.

**M5: identity and usage attribution.** Generalize the `claude-session-id` event to carry `{ vendor, sessionId }` (event name kept for wire/back-compat, field added); lane ledger and `usage-lane-core` move to a vendor-namespaced composite key (matching the scanner's existing dedup namespacing); per-card usage chips join Codex/Grok sessions to their own vendor entries by session id (the scanner already parses both), with blocks/plan-limits sections still Claude-only and labelled as they are today. `RESUME_ID_RE` deduplicated into one core with per-adapter overrides. Acceptance: a supervised Codex card shows its own token/cost chip from the Codex transcript; ledger round-trips old-format files.

**M6: surface polish.** Add Session dialog agent picker (gated on which adapters resolve a binary), card badge copy, Settings copy sweep for the "Claude" strings inventoried in the sweep, `bin/glissa.js doctor` gains per-agent resolution lines, AGENTS.md architecture section. Acceptance: `impeccable`-reviewed dialog change; docs updated; no orphan "Claude" copy on agent-neutral surfaces.

Sequencing note: M1 and M2 are pure-refactor milestones shippable independently with zero behavior change; M3 before M4 because Codex's argv injection needs no install step and exercises the whole relay path with the least new surface.

## Security notes

- The trust story does not widen: the relay POSTs to the same loopback ingress with the same per-session bearer token, and the token moves via spawn env, not argv or a world-listable command line.
- The relay refuses non-loopback targets, mirroring `statusline-relay.js`.
- `--dangerously-bypass-hook-trust` (Codex) is spawn-scoped and visible in the session; it must never be paired with writing trust entries into the operator's config. Any trusted-hash seeding writes only to files Glissa owns.
- Grok's default execution of `~/.claude/settings.json` hooks inside supervised sessions is disabled per spawn; Glissa never edits the operator's grok config, and the opt-in hooks file is env-inert by construction.
- Hook payload response bodies for non-CC vendors stay `{ ok, reason }` only; the pack-notice injection shape remains CC-gated, so the relay path can never become an injection channel.

## Open questions (resolve in-milestone, not before)

1. Codex update-prompt kill switch: config key vs answering the prompt; and whether a supervised session should ever be allowed to self-update (no).
2. Codex `trusted_hash` seeding format, so hook trust needs no bypass flag.
3. Grok env-var name for overriding `[compat.claude]` per spawn (env-above-config resolution was observed for other keys).
4. Whether Grok headless lanes need `-s <uuid>` always (a plain `-p` run persisted no session dir, which would break usage attribution for any future Grok lane).
5. SubagentStart/Stop firing conditions on Codex (multi-agent turn), before any gate enablement.

## Probe evidence

Raw captures (hook payloads, OSC timelines, `exec --json` streams, binary string dumps, probe harness scripts) live in the session scratchpad under `codexprobe/` and the grok probe files (`hooks-cmd.log`, `grok-hooks.log`, `pty-result.json`, `grok-strings.txt`). The probe harness scripts are worth promoting into `test/` as manual live-verification scripts during M3/M4; the captures themselves are point-in-time evidence for THIS doc, not durable fixtures (fixtures get recorded through Glissa's own recorder once adapters exist).
