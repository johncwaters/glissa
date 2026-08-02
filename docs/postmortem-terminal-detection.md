# Post-mortem: Terminal Detection (status / notification / sleep)

Date: 2026-05-29
Branch: `feat/detection-rewrite`
Related: `.omc/plans/rewrite-terminal-detection.md`

## Why the old approach failed

Glissa originally inferred session status by **scraping the rendered TUI** out of the raw PTY
byte stream. That stack was:

- `patterns.js`: 3-layer prompt heuristics (exact strings, regex, silence timer + arm/confirm).
- `ansi-tokenizer.js` + `line-assembler.js`: reconstruct screen lines (CR-overwrite, cursor moves).
- `completion-detector.js`: OSC-0 title braille-spinner -> idle stabilization.
- `sessions.js` Layer-4: a growing blacklist of chrome strings (`"Galloping"`, `"Brewed for"`,
  cactus ASCII `-+-`, OMC HUD regexes) plus an idle-timer "pending content" heuristic.

Root causes of unreliability:

1. **Screen content is for humans, not parsers.** Every Claude Code / OMC HUD version changed the
   chrome, so detection was maintained by *accreting string blacklists* (inherently version-coupled).
2. **Three overlapping mechanisms** (body-text PatternDetector, OSC-title completion-detector,
   idle-timer Layer-4) with diffuse responsibility, hard to reason about which fired and why.
3. **Timer soup**: silence/confirm/idle/startup-grace/auto-recover/feed-debounce all interacting,
   with many documented race band-aids.
4. **Unmeasurable.** No ground-truth corpus; tuning was by anecdote.

## The decision

Delete the content-scraping stack and derive status from **structural, machine-emitted signals**:

- **Primary: Claude Code hooks** (`Stop`, `Notification`, `UserPromptSubmit`, `SessionStart/End`)
  injected at spawn via `claude --settings <file>` (HTTP-type hooks POSTing to Glissa's localhost
  server). Hooks fire at turn boundaries, carry `session_id`/`cwd`, and require no repo mutation.
- **Fallback: OSC-0 title source** (`detection/osc-title-source.js`), the proven braille-spinner /
  idle-glyph signal, but with an *honest* contract: it emits only `working`/`ready`/`unknown`,
  never `awaiting-input`, and an unrecognized glyph is `unknown` (not silently `ready`).

This is "fix the stack we own": use the signals Claude emits intentionally instead of
reverse-engineering its rendered chrome. See the ADR in the plan for the full rationale and the
rejected alternatives (status line, OpenTelemetry, stream-json, Agent SDK, pure OSC, pure hooks).

## Step 0: live verification findings (2026-05-29, Windows 11, this machine/Claude version)

A ConPTY-free probe (`.omc/step0-print-probe.js`) spawned `claude -p` via `child_process` with
HTTP hooks injected through `--settings`, under `--dangerously-skip-permissions`. Results:

| Hook | Fired? | Notes |
|---|---|---|
| `UserPromptSubmit` | yes, t~9.7s | payload `permission_mode: "bypassPermissions"`, `session_id`, `cwd` |
| `Stop` | yes, t~14s | **fires under bypassPermissions**, the COMPLETE signal works in YOLO |
| `SessionEnd` | yes, t~16s | lifecycle |
| `SessionStart` | no (in `-p`) | did not fire in print mode; verify in interactive (US-009) |
| `Notification` | no (in `-p`) | idle/permission notifications are interactive-only; verify in US-009 |

Confirmed:
- `--settings` HTTP-hook injection works end-to-end with **no repo modification**.
- Hook payload carries `session_id`, `cwd`, `permission_mode`.
- Under `--dangerously-skip-permissions` (the user's config for all 10 projects) `Stop` +
  `UserPromptSubmit` + `SessionEnd` all fire, so the signals that matter in YOLO are available.
- The `-p` output (`"PONG"`) returned fine; the historical Stop-breaks-print bug (#38651) did not
  reproduce on this version.

**ConPTY limitation reconfirmed.** An interactive node-pty probe (`.omc/step0-hook-probe.js`)
**wedged at `pty.spawn`** while the user's Glissa had ~5 live ConPTY `claude` sessions, matching
`.omc/probes/common-patterns.md`: ConPTY does not allow concurrent node-pty spawns. Implication:
interactive live verification (SessionStart, `Notification(idle_prompt)`, the #3118
tool-call-end-Stop gap) must be run with Glissa stopped; deferred to US-009.

**Decision: proceed with Option C (hooks-primary, OSC-title fallback).** The authoritative path is
empirically validated for the YOLO config.

## Hook gotchas designed around (from docs + GitHub issues)

- **`Stop` misses turns that end on a tool call** (#3118, interactive). Mitigation: pair `Stop` with
  `Notification(idle_prompt)`; either reaching the session means "done."
- **`Stop` can double-fire** (#3465). Mitigation: StatusSource dedup window.
- **HTTP-hook default timeout is 600s, no retry, blocks Claude's loop.** Mitigation: inject a short
  timeout (about 2 to 5s) and make the `/hook` handler record-and-return-200 immediately.
- **Managed/enterprise settings outrank `--settings`** (`disableAllHooks`/`allowManagedHooksOnly`)
  and could silently block injected hooks (realistic in the ELM corporate env). Mitigation: startup
  guard: if no hook callback arrives for a known-working session, fall back to OSC-title + a visible
  "detection degraded" badge.
- Bun HTTP client fails to *external* URLs (#30613); **localhost works**, Glissa binds `127.0.0.1`.

## Lessons

1. Prefer signals the tool emits on purpose over scraping its human-facing output.
2. A fallback must be *honest*: report `unknown` rather than guess, so a degraded mode is visible.
3. Make reliability measurable (replay corpus) before deleting the thing you're replacing.
4. On Windows, don't probe live with node-pty while other ConPTY sessions run; use `-p` +
   `child_process` for mechanism checks.
