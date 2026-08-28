# session/adapters

Per-agent vocabulary: one adapter per CLI, tables and pure functions only.

## Invariants

Each entry is a rule, its why, and where it is pinned. Mechanism lives in the code.

### Agent Adapters

- An adapter is TABLES and PURE FUNCTIONS: what varies between agent CLIs is vocabulary, and flags cannot express one (`docs/plan-agent-adapters.md`). `resolveCommand` is lazy and cached per id, or a `require` costs a PATH lookup.
- Key on `capabilities`, never `adapter.id`, which rots once a third agent shares a behavior with the first. An UNDECLARED capability is absent (`tests/agent-capabilities.test.js`).
- The Add Session agent picker and the card badge are adapter-driven and BINARY-GATED: `list-agents` probes each registered adapter's `resolveCommand` (cached per id), `decideAgentPicker` offers only the ones that resolve and hides itself for a single-agent install, and the badge shows a short label for a non-default agent only, so a Claude-Code-only machine looks unchanged (`public/session-card/agent-core.mjs`, `tests/frontend-agent-core.test.js`). `glissa doctor` prints the same per-agent resolution.
- rtk is self-installed from a PINNED release with a PINNED sha256 into `~/.glissa/bin`, never "latest" and never a checksum fetched beside the binary, or one compromised release page swaps both halves (`server/core/rtk-install-core.js`).
- A relay hook forwards the envelope UNTOUCHED and exits 0 whatever happened, since a hook that fails must never fail its turn. Field aliasing stays server-side.
- The relay target rides `GLISSA_HOOK_URL` in the spawn env, never argv: a command line is readable by any local process, and an env target leaves an installed hooks file inert unsupervised.
- Codex (`agent: "codex"`) reaches the hook tier: snake_case payloads mapped by a table (`session/adapters/codex.js`, live-verified 0.149.0), hooks injected as `-c 'hooks.<Event>=...'` argv (the only form `exec resume` takes). Gaps: no `Notification` event, so a prose question looks like a finished turn, and `backgroundAgents: false` (a live child spawn emitted only the main Stop); statusLine and anti-slop are off. rtk is ON via its own `PreToolUse` group (`session/rtk-relay.js`): codex honours `updatedInput` only beside `permissionDecision: allow`, which rtk omits for some rewrites, so the relay stamps it (`session/core/rtk-hook-core.js`).
- Grok uses an opt-in home hooks file inert without `GLISSA_HOOK_URL`; injection is refused when operator Claude settings have hooks, `Stop(end_turn)`, `StopFailure` and `StopCancelled` complete, subagent hooks plus camelCase `backgroundTasks` gate completion, Stop feedback carries pack notices, titles never default ready, packs ride one `--rules` index-pointer token (`session/adapters/grok.js`, `tests/agent-grok.test.js`).
- The codex hook-trust bypass is `projects[].codexBypassHookTrust`, config-file only, default OFF, and refused even when opted in if the cwd ancestry holds a `.codex/config.toml` that could contribute hooks or a `.codex/hooks.json` at all. The bypass is not scoped to Glissa's own hooks: it runs every hook the invocation loads (operator config PLUS repo-shipped PLUS agent-written), so it fails toward the title tier (`session/sessions.js._decideHookTrustBypass`, `tests/agent-codex.test.js`).
- A captured resume id is validated before it becomes argv: `RESUME_ID_RE` requires an alphanumeric first char (one shared definition), or a forged hook payload of `--dangerously-bypass-approvals-and-sandbox` would ride `args.push("resume", id)` as a flag (`session/core/auto-resume.js`).
- `dangerouslySkipPermissions` on a codex card keeps the sandbox: it maps to `-a never -s workspace-write`, never `--dangerously-bypass-approvals-and-sandbox`, so the same checkbox that only silences prompts on Claude does not buy an unrestricted, network-capable session on codex.
- The codex title tier reads the WHOLE title against this session's cwd basename (`OscTitleSource.setContext`) and never emits a transition, anything unrecognized being `unknown`. A `quietUntilFirstPrompt` latch (with a `titleQuietFallbackMs` deadline) swallows codex's boot title spin that once flashed a fresh card COMPLETE. `-c check_for_update_on_startup=false` kills the blocking self-update prompt; a supervised session never self-updates.
