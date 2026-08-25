# Plan: Codex pack delivery, Grok adapter (M4), and monitor-report hardening

Status: drafted 2026-08-24 from three Codex GPT-5.6 research passes over the tree at `30bd4c6`
(codex-cli 0.149.0 and Grok Build 1.0.5 probed locally, no credentialed turns run) plus an
official-docs lookup. `AGENTS.md` and the code win over this doc. Milestone numbering continues
`docs/plan-agent-adapters.md` (M4, M6 open) and `docs/plan-visions-3.md` (M17 open).

## Part A: Codex pack and memory delivery (closes Visions M17 for Codex)

Today `session/adapters/codex.js` declares `packs: false`; the gate in `session/sessions.js`
records `unsupported` and passes no directory. Claude gets `--add-dir <pack>/current` plus
`CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` (`session/adapters/claude-code.js:188`,
`session/core/spawn-env.js:60`); Codex has no equivalent.

Probed on 0.149.0 (`codex debug prompt-input`, credential-free):

| Candidate | Result |
|---|---|
| `--add-dir <pack>` | Pack `CLAUDE.md` NOT discovered. Flag grants a WRITABLE root, which a pack dir must never be. Reject. |
| `model_instructions_file` | REPLACES the built-in system prompt, one file only, can 400 on GPT-5 models. Reject. |
| AGENTS.md overlay | Discovery is git-root-to-cwd only; would mean writing into the supervised repo or `~/.codex`. Reject. |
| `-c developer_instructions="<string>"` | Additive developer-role text, repo `AGENTS.md` still loaded, sentinel visible in prompt-input. `workspace-write` sandbox already READS `~/.glissa/packs`. Select. |

Design: one `-c developer_instructions=<TOML literal>` argv token carrying a CONSTANT
Glissa-authored directive plus, per delivered pack, `<name>: <abs path to current/CLAUDE.md>`.
Nothing else may enter the string: no manifest description, no rule text, no memory byte. The
pack index is the only entry point, so the M16 build gate (no memory byte in `CLAUDE.md` or
`.claude/rules/`) still bounds what a pointer can reach, and the memory pack's own index already
labels its `data/` files as recorded observation, never instructions.

Staleness notice: Codex documents `hookSpecificOutput.additionalContext` on `UserPromptSubmit`,
and `server/backend.js:576` already answers in that shape, but `session/hook-relay.js:36`
discards the response body. The relay gains a bounded read and writes to stdout ONLY a validated
`UserPromptSubmit` object whose `additionalContext` came from the Glissa server (accepted
callback, size-capped); every other event, status, or shape stays silent. With hook trust
withheld (bypass opt-in off) the spawn-time carrier still works and notices do not; `glissa
doctor` says so.

Change list:

- `session/adapters/codex.js`: `packs: true`, `packNotice: true`; `renderPackArgs(deliveries)`
  emitting the single `-c` token; never `--add-dir`. Path validation reuses the relay-path
  charset rule (a TOML literal cannot escape a single quote, so a path holding one is refused).
- `session/adapters/claude-code.js`: same `renderPackArgs` seam around today's `--add-dir` loop,
  byte-identical output pinned.
- `session/sessions.js` `_resolvePacks`: resolve first, then hand the ORDERED list to the adapter
  renderer once (fixes the M7 window below as a side effect if the delivered map is swapped
  atomically after resolution).
- `session/hook-relay.js` plus `session/core/hook-relay-core.js`: `decideHookStdout(event,
  status, body)` pure; relay prints it or nothing.
- `bin/glissa.js doctor`: per-agent carrier line and the hook-trust caveat.
- Pack read telemetry: Codex does not subscribe `PreToolUse`, so read counts are OMITTED for a
  Codex card rather than shown as zero.

Tests: `tests/agent-codex.test.js` (capability flip, exact token, multi-pack order, no
`--add-dir`, quote refusal, hostile path, no memory sentinel in argv), `tests/session-packs.test.js`
(variant resolution and missing-build skip for a codex session, no Claude env flag),
`tests/control-project-packs.test.js` (fan-out and cap with a codex record),
`tests/memory-delivery-negative.test.js` (argv carries the index path only), relay stdout tests
(accepted vs non-200, oversized, wrong event, malformed all silent), doctor tests.

Open risks: whether a real Codex turn actually follows the pointer and reads the index
(UNVERIFIED, needs one credentialed probe, added to `test/probe-codex-session.js`); resume
carrying `developer_instructions` (UNVERIFIED); Windows shim reparse of the TOML literal
(needs the hostile-path test on the `cmd.exe /c` form).

## Part B: Grok adapter (agent-adapters M4) and Grok delivery

Installed: `@xai-official/grok` 1.0.5 (native binary `~/.grok/bin/grok-1.0.5`). The 0.2.111
findings in `docs/plan-agent-adapters.md` still hold for: global hooks at `$GROK_HOME/hooks/*.json`
(always trusted, Claude-shaped JSON), camelCase stdin payload with `sessionId`, shell-interpreted
`command` hooks, UUIDv7 ids, `-r <id>` resume, `[compat.claude] hooks` defaulting on. Changed on
1.0.5, and the plan text must follow:

- Approval hook is `Notification` with `notificationType: "permission_prompt"`; `approval_required`
  is the terminal notification EVENT name, a different surface. Accept both spellings.
- New `StopFailure` and `StopCancelled`; a failed or interrupted turn emits NO `end_turn` `Stop`.
  Map both to `ready` (the turn is over and the operator's attention is needed), else a failed
  turn pins the card WORKING with no title fallback to save it.
- `idle_prompt` fires after failures and interrupts too: low confidence, quiescence-from-RUNNING
  only, exactly like the Claude rule.
- `UserPromptSubmit` is OBSERVE ONLY (stdout and exit ignored); only `Stop` may feed
  `additionalContext` back. A staleness notice on Grok therefore rides the Stop response, or
  waits. Notice capability stays false in M4.
- Title items cannot be pinned per session: the `GROK_CONFIG` overlay drops `[ui.*]` and project
  config refuses it, and writing the operator's `config.toml` crosses the ownership line. The
  title tier therefore classifies only shapes captured by the live probe and returns `unknown`
  otherwise, never a default `ready`.

Signal map: `SessionStart`/`SessionEnd` lifecycle (main agent only), `UserPromptSubmit` opens the
cycle, `Stop(end_turn)` and `StopFailure`/`StopCancelled` ready, any other `Stop` ignored,
`Notification(permission_prompt|approval_required)` awaiting-input. `backgroundAgents: false`
(docs expose camelCase `backgroundTasks`, tracker reads `background_tasks`, unprobed).

Spawn: resolved native binary, argv array, never a shim: `--no-auto-update [--always-approve]
[-r <id>] [extra] [prompt]`. Env adds `GROK_CLAUDE_HOOKS_ENABLED=false` (or the operator's
`~/.claude/settings.json` hooks fire inside a Grok card, which is the CC detection tier
misattributed) and `GLISSA_HOOK_URL`. `dangerouslySkipPermissions` maps to `--always-approve`.
`usageVendor: 'grok'`; the M5 composite key, rollup and chip join need no change.

Relay: opt-in `glissa agent setup grok` writes `$GROK_HOME/hooks/glissa.json` subscribing the five
events above, each `node "<packaged>/session/hook-relay.js" <Event>`; no URL, no token in the file,
inert without `GLISSA_HOOK_URL` (negative test invokes every extracted command with the env absent
and asserts exit 0, `reason: no-hook-url`, zero sockets). The shell-safe command builder moves out
of `codex.js` into `session/core/hook-command-core.js` with a byte-identical pin.

Packs on Grok: false in M4. Discovery walks `Agents.md`/`CLAUDE.md`/`AGENTS.md` per directory plus
`.grok/rules`, `.claude/rules` and `$GROK_HOME/rules` (no size cap, no `GROK.md`), so every
directory carrier means writing the repo or a global dir. `--rules <text>` is the Grok twin of
Codex `developer_instructions` and can carry the same constant pointer string; enabling it waits on
the live probe answering whether a Grok tool call can read `~/.glissa/packs` and whether the model
follows the pointer. M4b: flip `packs` on the shared `renderPackArgs` seam once that is captured.

Change list: `session/adapters/grok.js`, `session/adapters/index.js`, `session/core/hook-command-core.js`,
`session/sessions.js` (adapter `sessionIdOf(payload)` instead of hardcoded `payload.session_id`;
`home-hooks-file` injection kind that validates the installed file before minting a token),
`server/core/grok-agent-setup-core.js` (pure file render, foreign-file refusal),
`server/agent-setup-cli.js`, `bin/glissa.js`, `tests/agent-grok.test.js`, replay fixture
`tests/fixtures/v2-grok-approval-turn.jsonl`, `test/probe-grok-session.js` (isolated `GROK_HOME`,
credentials linked not copied, sanitized recording copied out, temp tree removed).

Acceptance: live probe spawn, RUNNING, WAITING (approval), COMPLETE, id capture, `-r` resume with the
same id, env inheritance into the hook child confirmed, raw OSC titles captured for the profile.

## Part C: hardening from `docs/monitor-report-context-mill-visions.md`

Audit at `30bd4c6`: FIXED V3 and V8 (`521f1b7`), M1 (`05fe2b6`), and M6 (`45c12c3`). Resolution
2026-08-24: V1 and V2 shipped in `8ff4038`; M2, M3, M5, M8, and M4 shipped in `656e9de`, `9c49f40`,
and `d4e54f6`; V4 through V7 shipped in `b9e1294` and `afa49f9`; V9 shipped in `ec11cac`; M7 shipped in
`77069f7`; M9 shipped in `ffa3c67`. The sole remaining note is the LOW symlink review of
`distillOutputPath`.

1. V1 + V2. SHIPPED `8ff4038` (`server/visions-dispatch.js:101`, `session/adapters/claude-code.js:207`,
   `session/core/spawn-command.js:108`): the buffer still rides argv, and on the Windows `.cmd`
   shim through `cmd.exe /c`. Write the prompt into the throwaway cwd, pass a constant
   metacharacter-free bootstrap argument, cap the prompt file BEFORE the budget is charged
   (`server/visions-wiring.js:653` charges before spawn). Tests: hostile quotes never reach shim
   argv; oversized input spends no cooldown or hourly slot.
2. M2. SHIPPED `656e9de` (`server/pack-builder.js:270`): `clearStaleTmpDirs` deletes any process's tmp dir. Per-pack
   exclusive lock from cleanup through rotation; reclaim only tmp dirs whose owner pid is dead or
   older than a bound. Test: two publishers cannot delete or rotate under each other.
3. M3. SHIPPED `656e9de` (`server/core/pack-core.js:592,684,795`): two skill dirs sharing a basename overwrite.
   Refuse duplicate final `relPath` in `planPackBuild`, publishing nothing.
4. V5 + V6. SHIPPED `b9e1294` (`server/visions-wiring.js:502,629,675,681`, `server/visions-dispatch.js:67`): carry the
   dispatched text hash across the await; accept comments, diagnostics, hand and intent only on a
   hash match; apply intent only after a non-ERROR verdict is accepted.
5. V7. SHIPPED `b9e1294`, `afa49f9` (`server/visions-wiring.js:61,201`, `session/visions-relay.js:201,215`): the relay resets its
   retry delay on open and replays a document above the 2 MB cap. Skip over-cap documents on replay;
   reset the delay only after a stable interval.
6. V9. SHIPPED `ec11cac` (`server/visions-wiring.js:202,209,896`): `didClose` from one relay wipes shared per-uri
   state. Track owners per uri; clear on the last close.
7. M9. SHIPPED `ffa3c67` (`server/pack-distiller.js:47,97`): `dangerouslySkipPermissions` plus bare `Edit(*)`/`Write(*)`
   denies, which `AGENTS.md` (Ephemeral Lane Write Boundaries) records as NOT a boundary and possibly
   as refusing the one write the lane needs. Move the distiller onto the `lane-permissions-core`
   posture (acceptEdits, throwaway cwd, result file rendered by Glissa). Test replaces the string
   presence check at `tests/pack-distiller.test.js:198`.
8. M5 + M8. SHIPPED `656e9de`, `9c49f40`, `d4e54f6` (`server/pack-builder.js:396,429,440`, `server/pack-service.js:134,168`): one throwing
   publish or watch-root provider escapes `buildPacks` or leaves no sweep timer. Per-spec isolation;
   timer armed independently of the first pass.
9. V4. SHIPPED `b9e1294` (`server/core/visions-dispatch-core.js:103,169`): `hashText('')` is truthy so the
   `empty-document` gate never fires. Gate on length; whitespace-only counts as empty.
10. M4. SHIPPED `656e9de` (`server/pack-builder.js:58,91,178`): a leading `**` yields an empty root and zero matches.
    Anchor to `baseDir` for both the walk and the watch root.
11. M7. SHIPPED `77069f7` (`session/sessions.js:1059,2433`): `pack-updated` landing mid-resolution finds no delivered
    entry. Closed structurally by Part A's atomic swap; keep a regression test either way.

## Sequencing

1. Part C slice 1 (V1 + V2): the only CRITICAL, small, independent.
2. Part A (Codex packs), which also lands the `renderPackArgs` seam and closes M7 (C.11).
3. Part C slices 2 and 3 (mill publish safety) while Part B's live probe is arranged.
4. Part B (Grok M4), then M4b packs-on-Grok gated on the probe.
5. Remaining Part C slices in order; each is a single commit with its test.

## Non-goals

- No writes to `~/.codex/config.toml`, `~/.grok/config.toml`, or a supervised repo to carry a pack.
- No `--add-dir` for packs on any agent that treats it as a writable root.
- No Grok `backgroundAgents` until a multi-agent Grok turn is probed.
