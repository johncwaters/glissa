# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Resize Claude Code when the browser window changes**: Two fixes together. (1) PTY-side: previously, resizing while a session was IDLE/COMPLETE/WAITING parked the new dimensions in `_pendingResize` and only flushed them when the session next transitioned to RUNNING. If Claude was quiescent and the user did not type or trigger a state change, the PTY never learned the new size and Claude kept formatting output for the old dimensions. The resize now applies to the PTY immediately in all states; a 1500ms `_resizeGraceActive` flag suppresses the redraw-induced false IDLE/COMPLETE to RUNNING transitions and auto-recover counter inflation that the original deferral (commit 1464a9b) was added to prevent. (2) Browser-side: collapsed the resize trigger graph onto the per-terminal `ResizeObserver` (replacing the parallel `window.resize` listener and the scattered `scheduleFitAll()` calls that fired before the observer had measured the settled box), RAF-throttled so burst fires during a window drag coalesce to one fit per frame. The observer's callback now also owns the WebSocket resize push: instead of relying on xterm's `onResize` event (which silently no-ops when fit proposes the same cols/rows xterm already has), every fit reads `term.cols`/`term.rows` directly and sends if they differ from the last successfully-sent pair. A `lastSent` cursor only advances after the send actually goes out, so a fit that runs before the data WS is open still gets retransmitted on `open` via `ui._applyFit()` instead of being silently swallowed.

- **Recognize Claude Code "`· /command`" footer chrome**: Claude's status-bar footer rows (e.g. `1 claude.ai connector needs auth · /mcp`, `MCP server disconnected · /mcp`) were not in any Layer 4 filter, so when one sat as the pending line after a brief IDLE→RUNNING redraw, the idle timer fired `prompt_detected` Layer 4 and the session transitioned to WAITING. A structural regex `/·\s*\/[a-z][a-z0-9_-]*\b/i` now covers the whole `<text> · /<slash-command>` footer family.

- **OSC 52 clipboard writes from inside the terminal**: xterm.js drops the OSC 52 sequence by default, so every `\x1b]52;c;<base64>\x07` write from programs like Claude CLI was a silent no-op. Registered an OSC 52 parser handler that decodes the base64 payload and writes to the system clipboard via the Clipboard API. Also replaced the silent `.catch(() => {})` on the Ctrl+C copy path with `reportClipboardFailure`, which logs to console and raises a toast so Clipboard API rejections stop disappearing.

### Performance

- **Trim hot paths in PTY broadcast and pattern feed**: `backend.js` per-client `dataListener` now has a fast-path that skips the rope concat when the send buffer is empty and the chunk fits, letting the scheduled `setImmediate` flush the assigned chunk directly instead of paying string-build overhead on the common single-chunk case. `sessions.js` skips `emit("data")` when no listeners are subscribed (sessions with no attached WS clients no longer pay the EventEmitter fan-out cost), and caps the pattern-detector feed to the trailing 16 KB when the 64 KB buffer fires. IDLE/COMPLETE markers always render in the recent tail, and the older middle-burst bytes were costing ~2 ms of event-loop block per flush.

## [0.11.0] - 2026-05-21

### Added

- **Dormant boot for instant dashboard load**: Sessions now construct in a new `DORMANT` state and no PTY is spawned until the user clicks to expand the chip. Eliminates the wasted CPU/IO of auto-spawning every configured project on launch and keeps dashboard startup constant-time regardless of project count. Newly added/modified config sessions still auto-start.
- **Auto-kill sessions minimized + sleeping for 15 minutes**: `sleep()` now schedules a 15-minute timer that calls `killSession()` if the session is still asleep, reclaiming the PTY and the `claude.exe` process tree. Previously, minimized sessions kept their PTY and `claude.exe` alive indefinitely (one user observed 6 concurrent `claude.exe` holding ~1.15 GB). Only `IDLE`/`COMPLETE` sessions actually get killed; `DONE`/`FAILED` no-op. Threshold is currently hardcoded.
- **Health monitor footer**: Collapsible footer panel renders a 10-second backend snapshot of process memory, per-session internals (PTY status, buffer bytes, timer state, listener count), and WebSocket counts, broadcast over the control channel.
- **Session debug overlay**: New per-card overlay (gated behind a Debug Mode toggle in Settings > Advanced) queries live server-side diagnostics over the control WebSocket: current state, last 5 transitions with trigger details, pattern-detector status (layer, matched line, armed/timer states), and session timers (auto-recover, idle, startup grace, sleep). Live-updates on every state change.
- **Multiple terminals on the same project**: Adding a project that already has a session no longer fails with a duplicate-name error. The Add Session picker shows every project with a `(N open)` suffix when sessions already exist and auto-disambiguates the name as `Foo`, `Foo (2)`, `Foo (3)`, etc. Sessions remain keyed by stable UUID, so each terminal gets its own PTY, recorder, and lifecycle while sharing the project `cwd`.
- **Wide-screen minimized card badges**: On screens >=1200px the 240px-wide minimized cards re-enable the Idle/Exited/Complete state badges and YOLO perms badge that were hidden on smaller viewports.

### Changed

- **Quieter minimized cards on narrow viewports**: Minimized cards suppress Idle, Exited, Complete, and YOLO badges to reduce visual noise. Active states (Working, Needs Input, Starting, Preparing, Failed) still display so users know when a session needs attention.
- **Compact minimized bar layout**: Minimized cards shrunk from 240px to 120px and lost their state/perms badge text on narrow viewports, fitting far more per row. The collapse arrow is repurposed as a state-colored dot (steady green for `RUNNING`, pulsing amber for `WAITING`, dim neutral otherwise). The minimized bar moved from `position: fixed` to in-flow so the terminal grid shrinks to make room rather than being overlapped.
- **O(1) output buffer eviction**: Per-session output buffer eviction switched from `Array.shift()` to a head-index ring with periodic compaction at 1024 entries.

### Fixed

- **Suppress IDLE/COMPLETE state churn from user-echo PTY data**: PTY echo arriving while the user was mid-typing in `IDLE`/`COMPLETE` was transitioning the session to `RUNNING` and could fire Layer 4 `idle_pending_content` on the user's own typed text. Mid-typing keystrokes within the input grace window are now treated as echo and skip the transition; submissions (any `\r` or `\n`) still promote the session back to `RUNNING`.
- **Auto-restart sleep-killed sessions on wake**: Sessions auto-killed by the 15-minute sleep timer landed in `DONE` and required a manual Restart click. The kill reason is now tracked and `wake()` drives a restart for sleep-timer kills, so opening the card resumes the session.
- **Tree-kill PTY process tree on Windows**: Background processes spawned inside Claude Code (e.g. `astro dev`) were surviving session exit because `ptyProcess.kill()` only terminates the `cmd.exe` wrapper. Both `kill()` and natural PTY exit now upfront tree-kill via `taskkill /PID <pid> /T /F`. One user had 19 stale `astro` processes holding ~1.2 GB. POSIX path unchanged.
- **Terminals undersized on first load until refresh**: Initial fit ran in a single RAF, which fired before layout settled, so the grid measured a 0x0 box and xterm locked at the default 80x24. Switched to double-RAF to match the established `scheduleFitAll` pattern.
- **Compact bar no longer clips terminal content**: Moving the minimized bar from `position: fixed` to in-flow means `.sessions` (flex: 1) shrinks as the bar grows, so open terminals are never overlapped no matter how many bar rows there are. Also matched `.xterm`/`.xterm-viewport` background to `--bg-card` to hide xterm.js's bundled black default as leftover row-snap pixels.
- **Debug overlay contained to card with close button**: `.session-card` was missing `position: relative` so the absolutely-positioned overlay anchored to the viewport and covered the screen with no dismiss. Added the anchor and a top-right X close button (existing outside-click handler still closes on click outside the card).
- **Defensive session lifecycle**: `start()` now force-kills any lingering `ptyProcess` (bounded 2s timeout) before respawn to prevent orphaned `onData`/`onExit` subscriptions. `destroy()` sets `_destroyed` first and start/wake/restart/`forceRestart`/`_handlePtyData`/kill-poll early-return on `_destroyed` so late deliveries cannot resurrect a torn-down session. `forceRestart()` guards against re-entry that would stack `once('exit')` listeners and double-spawn.

### Tests

- Added a node:test suite for `_isUserEchoData` and IDLE/COMPLETE handler behavior covering non-submit, submit, stale, and no-input paths plus the no-arg `recordUserInput()` compatibility used by `dismiss()`.
- Added `DORMANT` state coverage to the session state machine suite and a new in-process smoke test verifying all sessions boot `DORMANT` and only the targeted one transitions on user start.

## [0.10.0] - 2026-05-06

### Added

- **Sleep/wake mode for minimized sessions**: Minimized sessions in idle/done/failed states automatically sleep, disposing the xterm terminal, WebGL addon, ResizeObserver, and data WebSocket to free browser resources. Expanding a sleeping session recreates the terminal and replays the ring buffer. Server-side pattern detection is paused during sleep while the PTY remains alive.
- **Failed-launch diagnostics**: Session exit now carries a `reason` field. `no_output_before_exit` is emitted when STARTING exits with zero bytes ever delivered, distinguishing silent-launch failures from normal exits in backend logs.
- **PATH conflict probe**: Boot-time `where claude` / `which -a claude` resolution surfaces multiple `claude` matches (Bun shim shadowing risk) before runtime instead of as a stack trace.
- **Per-session spawn log**: Each session logs its `shell`, args, and cwd at spawn time for diagnosability.

### Fixed

- **Sleep/wake race conditions**: Reordered DOM operations to attach the card before waking, preventing layout measurement on detached nodes. Server now refuses sleep in active states; client auto-wakes when the server rejects sleep.
- **Grid layout on wake**: Switched grid to auto-fit and removed auto-centering margin to keep wake transitions stable.

### Changed

- **Biome formatting pass**: Applied consistent quoting, trailing commas, and spacing across `sessions.js`. No behavior change.

### Tests

- Added a session state machine test suite covering transitions, guards, and sleep/wake gating.

## [0.9.1] - 2026-04-29

### Fixed

- **Server restart on Windows**: Production restart fallback no longer dies on exit. Closes the HTTP server before spawning the replacement and uses detached stdio to prevent Windows `CTRL_CLOSE_EVENT` from killing the child process.
- **Session restart from COMPLETE state**: `forceRestart()` now includes COMPLETE in its killable states, matching `killSession()` and the frontend.
- **Terminal bottom clipping in session cards**: Prevented terminal content from being clipped at the bottom of session cards.

## [0.9.0] - 2026-04-27

### Added

- **Viewport-filling terminal grid**: Sessions fill the full viewport height with an auto-split layout that shows two sessions side-by-side when exactly two are active.
- **Browser tab favicon**: SVG favicon matching Glissa's purple brand identity.

### Changed

- **Responsive layout for all screen sizes**: Dashboard fills ultrawide and 4K screens instead of capping at 1920px. Laptops (1280px) now display two columns. Fluid padding replaces hard breakpoint jumps.

### Fixed

- **Oversized paste notification**: Users are now notified when a paste is silently rejected for exceeding the size limit.
- **PTY resize for inactive sessions**: Deferred PTY resize for idle, complete, and waiting sessions to avoid unnecessary processing.
- **Session card order on full-screen exit**: Card order is now preserved when exiting full-screen mode.
- **Action button overlap**: Prevented overlap between adjacent session action buttons.

## [0.8.0] - 2026-04-13

### Changed

- **Microtask-based terminal flushing**: Replaced interval-based PTY output flushing with microtask scheduling, adding a circuit breaker and input queuing to eliminate UI freezes under high throughput.
- **Batched PTY data path**: WebSocket and xterm write paths now batch PTY data, reducing per-chunk overhead.
- **Dashboard UI polish**: Addressed design-critique findings across the dashboard for consistency and visual hierarchy.
- **Deduplicated expand logic**: Consolidated duplicate expand/collapse code paths and simplified the circuit breaker implementation.

### Fixed

- **UI freeze vectors**: Eliminated remaining freeze vectors in terminal rendering and drag-and-drop interactions.

### Security

- **Vite 7.3.2**: Bumped Vite to patch security advisories.

## [0.7.0] - 2026-04-03

### Added

- **Settings dialog for terminal and detection**: Expose terminal dimensions, replay buffer size, and pattern detection toggles in the settings UI.
- **Configurable replay buffer size**: New `replayBufferKB` setting controls how much terminal history is retained per session.

### Changed

- **Debounced pattern detection feed**: Pattern detection input is now debounced to reduce CPU usage, especially in no-flicker mode.
- **Startup performance**: Optimized initialization, reduced logging verbosity, and increased default scrollback buffer.

### Fixed

- **LineAssembler CSI H handling**: Handle absolute cursor positioning (CSI `H`/`f`) in `LineAssembler` by flushing the current line on row change. Cursor-positioned content (companion cactus, HUD, status bars) no longer accumulates into a single giant pending line across multiple screen rows, eliminating the primary source of false-positive "needs input" notifications on idle sessions.
- **Layer 4 false positive elimination**: Add 7 new detection categories to `isLayer4Chrome` — wide-spaced user typing, short garbled fragments, URLs, task checkbox rendering, system messages (Bypass Permissions, Pasted text), HUD counter fragments, and OMC/auto-update chrome strings. Eliminates spurious "needs input" notifications especially when sessions are idle.
- **Companion cactus ASCII art false positives**: Suppress Layer 4 false positives triggered by companion cactus ASCII art output.
- **`killSession()` missing COMPLETE state**: Sessions in COMPLETE state could not be killed from the UI despite the transition table supporting `user_kill → DONE`. Added COMPLETE to the killable state list.
- **Cross-platform force kill**: `_forceKillAfterTimeout` now uses `SIGKILL` on non-Windows platforms instead of the Windows-only `taskkill` command.
- **Kill poll timer leak**: Force-kill poll timers are now tracked in `_killPollTimer` and cleaned up in `destroy()`, preventing potential unhandled exceptions on destroyed sessions.
- **Unbounded audit log growth**: `auditLog` is now capped at 200 entries to prevent memory growth in long-running sessions with frequent state oscillation.

### Removed

- **Guided onboarding tutorial**: Removed the first-install welcome tour (guide engine, tooltip component, and all related CSS/state).

## [0.6.0] - 2026-03-28

### Added

- **Skip-permissions visual indicator**: Session cards show a shield icon when `dangerouslySkipPermissions` is enabled, with redesigned card header layout.
- **Stable UUID session keys**: Sessions are now keyed by a stable UUID (`id`) instead of mutable display name. Includes inline rename support and skip-permissions toggle per session.

### Fixed

- Suppress false "needs input" notification during typing pause.
- Trigger tutorial and clear empty placeholder on first-time setup.

### Docs

- Document trust boundary, session identity, and skip-permissions security model.

## [0.5.2] - 2026-03-26

### Added

- Pre-publish validation script for package.json `files` array.

### Changed

- Bumped version for npm publish.

## [0.5.1] - 2026-03-26

### Fixed

- Include `ansi-tokenizer.js` and `line-assembler.js` in npm package files.
- Resolve doubled paste output and add Ctrl+Backspace word delete.

### Docs

- Update AGENTS.md with new modules and remove stale references.

## [0.5.0] - 2026-03-24

### Added

- **Split layout mode**: Two side-by-side full-height terminals for focused parallel work.
- **Trust prompt detection**: Detect "Enter to confirm" trust prompts as needs-input events.

### Changed

- **ANSI processing pipeline**: Replace `stripAnsi` with a proper ANSI tokenizer + line assembler pipeline for more robust pattern detection.

### Fixed

- Prevent OSC sequences from cancelling armed prompt matches.
- Minimized tab sizing and Layer 4 idle prompt false positives.

## [0.4.0] - 2026-03-21

### Added

- **NotificationManager**: Centralized notification system with state machine (IDLE→PENDING→DELIVERED→ESCALATED) replacing inline `notify()` calls in sessions.js.
- **Channel architecture**: Pluggable notification channels via adapter pattern (`channels/toast.js` for BurntToast/msg fallback). Future channels (Slack, email) can be added without touching core logic.
- **Input grace period**: Suppress false "needs input" prompt detections for a configurable window after user input (`inputGraceSeconds`, default 5s).
- **Layer 3 pattern filters**: Reduce false positive prompt detections — skip short fragments, trailing URL schemes (`://`), and indented short menu items.
- `rearmSilenceTimer()` on PatternDetector for retrying detection after grace period rejection without clearing pending line state.

### Changed

- Notification lifecycle (debounce, escalation, suppression) is now managed by NotificationManager in backend.js instead of being scattered across sessions.js and notify.js.
- Biome lint scope expanded from `public/**` to `**` with exclusions for `dist/`, `node_modules/`, ESM files, and Vite config.
- Disabled `noRedundantUseStrict` (CJS uses `'use strict'` intentionally) and `noControlCharactersInRegex` (ANSI stripping requires control chars) in biome.json.
- Applied biome lint fixes: `&&` guard → optional chaining, `let` → `const` where appropriate, unused params prefixed with `_`.
- `configStore.getSettings()` now exposes `inputGraceSeconds` and `notifyDebounceMs`.

### Fixed

- Escalation ping-pong no longer re-records category debounce, which could suppress notifications for other sessions.

### Deprecated

- `notify.js` — functions are now no-ops with one-time deprecation warnings. Use NotificationManager instead.

### Removed

- Unused imports in control-handlers.js (`makeSession`, `wireSessionEvents`, `closeSessionDataClients`).
- `_escalationTimer` and `_destroying` flag from Session class (responsibility moved to NotificationManager).

## [0.3.0] - 2026-03-19

_Skipped in changelog — incremental fixes and version bump._

## [0.2.0] - 2026-03-17

### Added

- **Maximize mode**: Click the Maximize button to expand a terminal full-screen while all others collapse to the minimized bar. Click any minimized session to switch. Press ESC or click Restore to return to grid view.
- **COMPLETE state**: When an agent works for 30+ seconds and goes quiet, the session shows a green "Complete" badge and triggers a Windows toast notification. Clicking the terminal dismisses it back to Idle.
- **Notification debouncing**: Deduplicate toast notifications per category (waiting, failed, complete) within a configurable window.
- Suppress Windows toast notifications when the dashboard browser window is focused.

### Changed

- Rename "Running" badge to "Working" — reflects active agent output.
- Rename "Done" badge to "Exited" — reserved for process exit; "Complete" now indicates finished tasks.
- Reduce default idle timeout from 60s to 5s — terminals return to Idle quickly when output stops.
- Minimized tabs are fixed-width (240px) with truncated names and right-aligned status badges.
- Minimized sessions show an up arrow (▲) instead of right arrow to indicate they can be restored.
- Hide Restart and Remove buttons when a session is minimized.
- Debounce focus-state reporting (150ms) to prevent spurious notifications during DOM operations.
- Extract `_buildSpawnEnv`, `_handlePtyData`, `_handlePtyExit` from `Session.start()` to reduce method length.
- Extract `_forceKillAfterTimeout` from `Session.kill()` with named constants.
- Add `DATA_HANDLERS` table for state-driven PTY data dispatch, replacing if-else chain.
- Extract helpers from `applyConfigReload()` in backend.js and `applyState()` in session-card.js.
- Replace `getSessionUIs()` exposure with encapsulated helpers.
- Use PowerShell `Get-Module -ListAvailable` for BurntToast discovery with path-scanning fallback.

### Fixed

- Resolve SonarLint and Biome lint issues across frontend (sorted imports, optional chaining, nested ternaries, negated conditions).

### Removed

- Focus mode (CSS-only) — replaced by maximize mode which uses real minimization.
- Dead code: `user_input`/`user_skip` transitions and guards in sessions.js.
- Dead exports from theme.js, local-store.js, config-store.js.

## [0.1.0] - 2026-03-15

### Added

- Initial release
- Spawn and manage multiple Claude Code sessions via browser dashboard
- Real-time terminal output with xterm.js and WebGL acceleration
- Dual WebSocket architecture (control channel + per-session PTY streaming)
- 7-state session lifecycle (INITIALIZING, STARTING, RUNNING, WAITING, IDLE, DONE, FAILED)
- 3-layer prompt detection (exact match, regex, silence heuristic)
- Windows toast notifications via BurntToast PowerShell module
- Drag-and-drop session reordering with persistence
- Configurable themes (Golgari, Midnight, Phyrexian, Compleated)
- Hot-reloadable configuration with auto-seeding to `~/.glissa/config.json`
- Guided onboarding tutorial for first-time users
- Alert sounds for session attention events
- CLI with `--port`, `--config`, `--help`, `--version` flags

[0.10.0]: https://github.com/johncwaters/glissa/releases/tag/v0.10.0
[0.9.1]: https://github.com/johncwaters/glissa/releases/tag/v0.9.1
[0.9.0]: https://github.com/johncwaters/glissa/releases/tag/v0.9.0
[0.8.0]: https://github.com/johncwaters/glissa/releases/tag/v0.8.0
[0.7.0]: https://github.com/johncwaters/glissa/releases/tag/v0.7.0
[0.6.0]: https://github.com/johncwaters/glissa/releases/tag/v0.6.0
[0.5.2]: https://github.com/johncwaters/glissa/releases/tag/v0.5.2
[0.5.1]: https://github.com/johncwaters/glissa/releases/tag/v0.5.1
[0.5.0]: https://github.com/johncwaters/glissa/releases/tag/v0.5.0
[0.4.0]: https://github.com/johncwaters/glissa/releases/tag/v0.4.0
[0.3.0]: https://github.com/johncwaters/glissa/releases/tag/v0.3.0
[0.2.0]: https://github.com/johncwaters/glissa/releases/tag/v0.2.0
[0.1.0]: https://github.com/johncwaters/glissa/releases/tag/v0.1.0
