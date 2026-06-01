<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-30 -->

# detection/ — Structural Status Detection

## Purpose

The status-detection subsystem. Derives a session's live status from **machine-emitted structural signals**, never from parsing the rendered TUI. Two raw sources feed one merge layer that emits a normalized signal stream; `sessions.js._onStatus` maps each normalized signal to a state-machine transition per the signal x state matrix.

Authoritative path = Claude Code hooks (HTTP callbacks). Degraded fallback = OSC-0 terminal title glyphs. There is NO body/line content scraping anywhere in this directory — reintroducing it is explicitly forbidden (see `docs/postmortem-terminal-detection.md`).

## Key Files

| File | Description |
|------|-------------|
| `status-source.js` | `StatusSource` (EventEmitter). Merges hook + title signals into one normalized stream. Precedence hook > title; conflict window holds `ready` so a racing `awaiting-input` wins; dedups rapid duplicates (absorbs the `Stop` double-fire). Emits `status` (transition-driving) and `meta` (telemetry-only `unknown`). Exports `StatusSource`, `createStatusSource()` |
| `hook-source.js` | **Authoritative.** `HookRouter` validates a per-session bearer token then invokes the session's `onSignal`. `mapHookToSignal(event, payload)` maps a Claude Code hook event to a normalized signal (`Stop`/`Notification(idle_prompt)` -> `ready`; `PermissionRequest`/`Notification(permission_prompt|elicitation*)` -> `awaiting-input`; `UserPromptSubmit` -> `resume`; `SessionStart`/`SessionEnd` -> lifecycle). Backed by `POST /hook/:glissaId/:event`. Exports `HookRouter`, `mapHookToSignal` |
| `osc-title-source.js` | **Degraded fallback.** `OscTitleSource` scans PTY bytes for OSC-0 titles. Braille glyph (U+2800..U+28FF) -> `working`; known idle glyph (U+2733) after a spinner, stabilized -> `ready`; unrecognized non-ASCII glyph -> `unknown` (one-time warning). NEVER emits `awaiting-input`. ASCII-leading titles (shell/OS window titles) dropped silently. Exports `OscTitleSource`, `createOscTitleSource()`, `findOscTitle`, `isBrailleChar`, `isKnownIdleChar`, `KNOWN_IDLE_CODEPOINTS` |
| `settings-injector.js` | Writes a per-session Claude Code `--settings` file containing HTTP hooks whose URLs carry `glissaId` + bearer token. Files live under a per-session subdir of the OS temp dir (`%TEMP%/glissa-hooks/<glissaId>`); `cleanup()` removes them on destroy; `sweepOrphans()` clears stale dirs at boot. Exports `buildHookSettings`, `writeSessionSettings`, `sweepOrphans`, `generateToken`, `HOOK_EVENTS`, `DEFAULT_BASE_DIR`, `DEFAULT_TIMEOUT_SEC` |
| `replay.js` | Version-aware replay harness. Drives recorded sessions (session-recorder JSONL: v1 data-only, v2 data+hook) back through the REAL detection pipeline so reliability is measurable against ground truth. Exports `parseRecording`, `replayDetection`, `summarize` |

## Normalized Signal Vocabulary

`StatusSource` emits exactly these (consumed by `sessions.js._onStatus`):

```
working | ready | awaiting-input | resume | session-start | session-end
```

`unknown` is NOT a state signal — it is forwarded as a `meta` event for telemetry / degraded-badge use, never as a transition.

## For AI Agents

### Working In This Directory

- **CommonJS only** (`require` / `module.exports`), matching the server convention.
- **No content scraping.** The OSC-title source scans ONLY OSC-0 title sequences. The hook source consumes structured HTTP callbacks. Do not parse the rendered terminal body, prompt lines, or conversational text. This is the single hardest constraint here.
- **The title source must stay honest.** It emits only `working`/`ready`/`unknown`. `awaiting-input` is exclusively the hook source's job, because a title cannot tell "needs input" from "finished". Do not add an `awaiting-input` path to `osc-title-source.js`.
- **New idle glyph?** Add its codepoint to `KNOWN_IDLE_CODEPOINTS` in `osc-title-source.js` (it currently warns once and reports `unknown`). Do not guess-map unknown glyphs to `ready`.
- **Token check is load-bearing.** `HookRouter.handle()` rejects `unknown-session` (404) and `bad-token` (403). Keep that validation if you touch the route or router — it is the trust boundary for the one HTTP write ingress.
- **Precedence and the conflict window** in `status-source.js` exist to prevent a spurious COMPLETE -> WAITING flip (and its false toast) when a turn ends on an attention prompt. Changing `DEFAULT_CONFLICT_WINDOW_MS` / `DEFAULT_DEDUP_WINDOW_MS` affects that race; verify against `tests/status-source.test.js` and the replay fixtures.
- All sources expose `reset()` and `destroy()`. `destroy()` must clear timers and remove listeners — these are created per session and leak if not torn down.

### Wiring

```
PTY bytes ─────────────► OscTitleSource.feed() ──signal('title')─┐
                                                                  ├─► StatusSource.ingest()
POST /hook/:id/:event ─► HookRouter.handle() ──onSignal('hook')──┘        │
                                                                  status / meta
                                                                          ▼
                                                          sessions.js._onStatus -> transition
```

- `settings-injector.js` runs at spawn: writes the `--settings` file, returns the `--settings <path>` arg and the token. `sessions.js` appends the arg to the `claude` spawn and registers `{ token, onSignal }` with the `HookRouter`.
- `replay.js` rebuilds the title + status pipeline (plus `mapHookToSignal`) standalone for offline ground-truth testing — it does not touch the live server.

### Testing Requirements

```bash
npm test    # node --test "tests/**/*.test.js"
```

Covered by `tests/osc-title-source.test.js`, `tests/status-source.test.js`, `tests/hook-source.test.js`, the §4a signal x state integration matrix (`tests/sessions-detection.test.js`), and the replay harness over recorded fixtures (`tests/replay-harness.test.js`, fixtures in `tests/fixtures/`). When changing detection behavior, add or update a fixture and assert on resolved signals, not on internal state.

## Dependencies

### Internal
- Consumed by `sessions.js` (`_onStatus` mapping), `backend.js` / `control-handlers.js` (HookRouter route + registration)
- `replay.js` consumes `osc-title-source.js`, `status-source.js`, `hook-source.js`
- Replays recordings produced by `session-recorder.js`

### External
- Node.js built-ins only: `node:events`, `node:fs`, `node:os`, `node:path`, `node:crypto`, `node:timers/promises`. No third-party packages.

## Related Documentation
- `docs/postmortem-terminal-detection.md` — why content-scraping was removed and the structural-signal design
- `.omc/plans/rewrite-terminal-detection.md` §4a — the signal x state transition matrix

<!-- MANUAL: -->
