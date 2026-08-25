# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.23.0] - 2026-08-25

### Added

- **First-class Codex CLI sessions**: Glissa now discovers installed agent adapters, offers an agent picker when more than one is available, and reports resolved binaries through `glissa doctor`. Codex sessions gain structural hook and title status detection, safe workspace permissions, resume support, context-pack delivery, per-vendor usage attribution, and an adapter badge.
- **Grok Build sessions**: an opt-in `glissa agent setup grok` command installs a guarded home hook file for supervised Grok sessions, with status detection, resume, background-task completion gating, context-pack delivery, and Grok-specific usage attribution.
- **Opt-in long-term memory**: Glissa can retain HMAC-signed knowledge, intent, feedback, and transcript records in a machine-wide SQLite store with FTS5 retrieval, automatic budgeted backfill across Claude, Codex, and Grok transcripts, retention controls, and secure forgetting that scrubs the row, search index, and WAL. This raises the Node floor to 22.16.0.
- **Distilled memory delivery**: a bounded headless lane turns remembered records into verified global and per-project claims, diverts proposed changes to locked facts for review, and delivers relevant memory through fenced Visions prompts and data-only context packs while suppressing quoted-memory feedback loops.
- **Mill dashboard**: a new desktop tab and phone screen report context-pack budgets, builds, versions, drift, outputs, watchers, consumers, and live delivery state without adding a polling timer.
- **Per-project context-pack controls and variants**: Mill can assign packs to a checkout through delta-safe checkboxes, build and watch only packs with consumers, keep dormant sessions dormant during assignment, group duplicate session records by resolved project path, and derive independent project-specific variants with base-pack fallback.
- **Automatic remote session-branch cleanup**: a default-on lane periodically removes remote `glissa/session/*` branches that are proven merged or orphaned beyond the staleness threshold, while protecting configured sessions and integration branches. Set `branchGc.enabled` to `false` to opt out.
- **Managed rtk support for Codex**: when rtk is enabled but missing, Glissa downloads a pinned release into `~/.glissa/bin`, verifies its pinned SHA-256 digest, reports installation status in Settings and `glissa doctor`, and enables Codex command rewriting through a dedicated guarded hook relay.
- **Native Linux and Pop!_OS support**: Glissa now handles POSIX process groups, worktree links, command resolution, secure config modes, ephemeral files, and session teardown natively, with Linux installation coverage added to CI and platform-specific notification fallback.
- **Durable Telegram escalation**: Telegram notifications are queued before delivery and replayed after a crash until confirmed, while an unacknowledged terminal notification can escalate to Telegram even when a dashboard connection remains open.

### Changed

- **Navigator is now Visions**: the feature, configuration key, WebSocket route, LSP identity, files, and VS Code companion were renamed consistently to Visions.
- **Project-aware Visions intent and diagnostics**: intent is persisted per stable project id, selected by the deepest matching project root, and shared correctly when multiple sessions use the same checkout. Model diagnostics are always low-severity hints and exclude syntax, type, formatting, and lint findings that belong to the real toolchain.
- **Denser dashboard navigation and reporting**: desktop view tabs now use a centered segmented-pill control, the Mill phone screen uses bounded cards and compact grids, Usage and Mill copy is shorter while preserving provenance labels, and the Glissa server terminal tab identifies itself by port.
- **Leaner bundled Glissa context pack**: the pack now delivers only its distilled brief and rules instead of repeating the raw source documents, reducing its budget from 12,000 to 6,000 tokens.
- **Quieter automated PR reviews**: review comments identify themselves as automated, omit praise and empty re-review updates, avoid unconditional agent guidance, and keep finding summaries focused on actionable changes.

### Fixed

- **Dashboard reconnects after restarts and device wake**: control and terminal sockets now recover from server shutdowns, phone sleep, black-holed handshakes, half-open connections, stale page tokens, and cached sequence reuse; protocol heartbeats reap dead sockets, and a changed server build reloads the page into a fresh snapshot.
- **Local dashboard trust boundary hardened**: browser connections now require an exact listener-port Origin and per-process page token, Host values are allow-listed, decoded pairing paths close traversal bypasses, and managed hook directories and files must have safe ownership, type, and permissions. Hook injection also falls back to title detection when project Claude settings could contribute untrusted hooks.
- **Visions dispatches stay current and bounded**: blank documents spend no budget, edits arriving during a dispatch invalidate stale results, ERROR verdicts cannot carry findings or intent, oversized relay frames force a clean resync, shared documents clear only after their last editor closes, and prompts are read from capped files instead of riding process arguments.
- **Context-pack publishing survives races and crashes**: per-pack locks serialize concurrent builders, stale locks are reclaimed atomically, interrupted rotation falls back to the previous good build, duplicate output paths fail before publishing, and lock-release failures no longer hide the original build error. Packless sessions also scrub inherited pack-discovery flags.
- **Worktree review and cleanup are safer**: a session branch tracking its own remote copy no longer uses that copy as the review base, so the sidebar shows only the session's changes after a rebase. Discard now preserves committed-but-unmerged work, process-group checks catch background holders, and new rerere resolutions immediately retrigger cooled-down rebases.
- **Background lanes shut down cleanly**: restart and shutdown now await every lane drain and killed PTY tree under named bounds before worktrees are discarded. PR Review and Radar state writes are serialized asynchronously, and PR polling uses jittered outage backoff.
- **Session switching keeps visual continuity**: desktop switches no longer publish a temporary 80x24 terminal size or produce a large layout jump, and elapsed time in the current state survives a dashboard reload instead of resetting.
- **External config edits are no longer swallowed**: content-signature suppression now distinguishes Glissa's own writes from later saves, reloads, and operator reversions, closing both timing-window cases that could silently leave disk and live state out of sync.
- **Memory ingestion and distillation boundaries hardened**: transcript timestamps are clamped, backfill and live offsets cannot race, oversized lines stay intact through secret scrubbing, projected paths cannot escape their roots, and ephemeral memory lanes are confined to throwaway working directories with capped result files.

### Removed

- **Manual Visions intent correction**: the editable and lockable intent control is gone; intent is now maintained by the model, with incorrect intent treated as an upstream Visions defect instead of operator-managed state.

## [0.22.0] - 2026-08-22

### Added

- **First-class phone layout**: the dashboard now has dedicated Board, Terminal, Review, Radar, PRs, and Usage screens on phones, with bottom navigation, live element re-parenting, attention-first triage, and soft-keyboard handling that routes phone text input around xterm's fragile IME path.
- **Phone image upload**: the phone key strip can upload an image into the active session, saving the file under Glissa's upload area and bracket-pasting the path into the PTY for the operator to send.
- **Radar error monitoring**: an opt-in lane that polls PostHog error tracking, classifies every issue against the last poll (spiking, regressed, new, worsened, quiet), pings Telegram for the ones that matter, and dispatches headless agents that diagnose them into a report and an investigations inbox on the dashboard.
- **Radar auto-fix**: with `posthog.autoFix` on, a spiking, regressed, or new issue in a project that maps to a real git checkout dispatches a reproduce-then-fix agent instead of the diagnose-only investigation. The agent works in an isolated throwaway worktree and may only commit locally; Glissa pushes the branch and opens the pull request itself, refuses a diff that touches `.github/workflows/`, and never merges. A finished fix pings Telegram with the pull request link and whether the bug was reproduced first; a fix that needs a decision or failed outright pings too, and a non-event stays silent.
- **Navigator model diagnostics (tier 2)**: dispatch results may carry model-proposed diagnostics, validated and capped by the same rules as comments and published as a union with the deterministic rule sweep. They are cleared on any edit or close, and an ERROR verdict never blanks a standing set.

### Changed

- **Distribution moved to GitHub installs**: Glissa is no longer published to the npm registry; standalone installs now use `npm install -g github:johncwaters/glissa`, and release/update docs now point at GitHub tags and the `main` branch package metadata.
- **The update check keys on releases, not commits**: the update banner now fires only when a newer `vX.Y.Z` GitHub release exists (resolved from `git ls-remote --tags`, with the GitHub releases API as fallback) instead of on every commit that reaches `main`. The npm-global update command pins the release tag and the banner links the release page instead of a commit compare.

### Fixed

- **WebSocket upgrades are routed by pathname**: control and data upgrades are classified before handoff, unknown local upgrades are left for Vite, remote unknown upgrades are closed, and both control and terminal clients now use jittered reconnect backoff instead of reconnecting in lockstep.
- **Server lifecycle and install diagnostics are quieter and more reliable**: service-managed restarts now exit non-zero under systemd so the supervisor restarts Glissa, pairing writes dedupe stored devices, and PATH diagnostics dedupe duplicate Claude command matches.
- **Shell-history tail survives same-path rewrites**: a history file rewritten in place (PSReadLine trimming to its cap) or deleted and recreated reusing its inode no longer replays from a stale offset, which could publish mid-command fragments into the ring. A 512-byte head sample now proves the file is still the one the tail was reading, and a changed head re-baselines instead of publishing.
- **Windows short-path watcher abort, again**: the agent-log and shell-history ingest watchers bypassed the 0.21.0 `canonicalizePath` seam, so watching an 8.3 short path (CI temp dirs) aborted the whole process from native code. Both are wrapped now, and a repo-wide guardrail test fails any future `fs.watch` call whose target is not canonicalized.
- **GitHub release creation from non-Windows hosts**: `scripts/release.js` probed for the `gh` CLI with the Windows-only `where`, silently skipping the GitHub release when run from Linux.

### Removed

- **Navigator LSP sync was simplified**: the relay now advertises full-text document sync, so incremental range updates and the framer's malformed-header resync are gone.

## [0.21.0] - 2026-08-05

A hardening and housekeeping release: detection survives Windows 8.3 short paths instead of aborting the process, team configs must now declare their permission mode explicitly, the focus rail's quick-add button stops trading places with the dismiss control, and lint moves under CI enforcement.

### Fixed

- **Focus rail quick-add no longer shifts position**: the dismiss control shown on an empty project group used to render after the "+" quick-add, so the rightmost click target flipped between "add a session" and "remove this project" depending on the group. The "+" now always owns the rightmost slot, ending accidental project dismissals.
- **Windows 8.3 short paths no longer abort the process**: watching a directory through an unresolved short path (e.g. `C:\Users\RUNNER~1\...`) tripped a native libuv assertion inside `fs.watch` that no JS `try/catch` can intercept, killing the whole server. Every watched path is now canonicalized first, and path comparison falls back to canonical forms so short/long spellings of the same directory still match (Windows only).
- **PR-review sessions appear in the health snapshot**, so the footer telemetry no longer undercounts live sessions while the PR auto-review lane is working.
- **Control-channel relay messages can no longer be spoofed by their own payload**: a forwarded event carrying a same-named key could overwrite the relay's `type`, `id`, `session`, or `timestamp`; the relay's own identity fields now always win.

### Changed

- **`team.json` must declare `permissions.mode` explicitly**: the silent default is gone, and validation reports an honest error for a missing or unknown mode. Existing team definitions need a one-line addition.
- **Lint is now enforced**: `npm run lint` runs Biome and CI fails on findings; the whole tree was brought clean.
- **README demo GIF and docs cleanup**: the static screenshot is replaced with a captured demo GIF, stale design docs moved to `docs/archive/`, and AGENTS.md file trees were synced with reality.
- Internal hardening across the tree: pure-core extractions in session/detection, shared modal scaffolding in the dashboard, control-plane dedupe, and PR-review/team-session wiring extracted from `backend.js`.

### Removed

- **The qa-walk team is retired**, along with the never-honored `stage.optional` field in team definitions.

### Security

- Dependency patches for known CVEs: `postcss`, `body-parser`, `nanoid`.

## [0.20.0] - 2026-07-31

The review sidebar learns to see and fix base-branch drift with a live ahead/behind indicator and a one-click Resync, every session now leaves a lightweight forensic recording by default, and crash-safe auto-resume actually works: the session id capture it depends on was keyed to a hook that current Claude Code never fires.

### Added

- **Branch sync in the review sidebar**: the sidebar now shows whether the project's base branch (e.g. `develop`) is ahead of or behind its remote upstream, counted after a bounded best-effort fetch that runs only in the main checkout and never touches a session worktree. A new **Resync** button (and `Alt+R` when nothing is parked) resolves the drift on demand: fast-forward when behind, push when ahead, and report-only on diverged, in-sync, no-upstream, or unknown, so it never rebases or force-pushes. Never polled: it fires only on sidebar open or an explicit click, since it performs a git fetch. A branch with an upstream whose counts cannot be parsed now reports a distinct unknown state instead of masquerading as having no upstream.
- **Signals-mode session recording (on by default)**: every session writes a lightweight JSONL forensic log to `~/.glissa/recordings` (header, verbatim hook payloads, state transitions) even when raw PTY capture is off. Raw bytes, input, and resizes stay behind the existing `capture.enabled` opt-in. The file opens lazily on first write, so a session that never starts leaves nothing behind, and retention now caps files per session (`retainFiles`, default 20) alongside the age sweep, both async off the shared event loop. `recordSignals: false` is the kill switch.
- **Missing integration branch is auto-created**: a worktree-backed session no longer parks DORMANT when the configured integration branch does not exist locally; it is created from `origin/<branch>`, a local or remote default branch, or HEAD, in that order.

### Fixed

- **Boot auto-resume never actually resumed**: the crash-safe session id capture was keyed to the `SessionStart` hook, which Claude Code 2.1.220 never fires, leaving the resume id permanently empty. The id is now captured from whichever main-agent hook arrives first, and persisting fires only on an actual id change.

### Changed

- **Docs refresh**: README now covers the background-agent completion gate, PR auto-review, session recording, all four bundled teams (including qa-walk), project-level shared packs, and the FIX revision loop, with new dashboard screenshots. `docs/publishing.md` is rebuilt around `npm run release` as the primary path, `docs/testing-cli.md` is corrected against the real CLI and package manifest, and three superseded design docs moved to `docs/archive/`.

## [0.19.0] - 2026-07-27

The Focus rail keeps a project's slot after its last session closes and gains one-click quick-add/remove, session worktrees survive a broad set of races and edge cases (double-spawn, config-modify recreate, branch-in-use, server shutdown), an opt-in GitHub PR auto-review poller can review and merge your own clean PRs unattended, and the Rainbow Unicorns nyan easter egg grows from 2 animals to 18.

### Added

- **GitHub PR auto-review (opt-in, off by default)**: a background lane that reviews the operator's own GitHub PRs and merges the clean ones unattended. Configured from Settings > PR Review (enable toggle, Telegram bot token/chat id, project picker, poll interval, concurrency, timeout, merge method); inert unless both PR Review and Telegram are configured. Every 15 minutes it reviews new commits on your own non-draft PRs with an ephemeral headless Claude session (in place for a clean PR, in an isolated worktree for a conflicting one), posts findings as a PR comment, and merges only once GitHub checks are green and the PR touches no workflow file. Actionable transitions (changes requested, conflicts resolved, merged, error) ping Telegram.
- **Focus rail keeps a project after its last session closes**: every project path Glissa has seen stays in the rail as an empty group (header, quick-add, dismiss) instead of disappearing and forcing a re-add through the Add Session dialog.
- **Quick add/remove sessions from the rail**: a "+" on each project header spawns another session on that project's path with an auto-suggested name; a hover (mouse) or Delete/Backspace (keyboard) control retires a pill directly, without the Add Session dialog or the card overflow menu. A clean session retires immediately with no confirm; a session with unmerged work still prompts before discarding.
- **Nyan menagerie grows to 18 animals**: cat and unicorn are joined by dragon, pig, whale, fox, frog, penguin, bee, owl, cow, panda, red panda, deer, horse, sheep, hamster, and giraffe, each with its own 6-frame sprite, motion, and themed trail (embers, bubbles, clover, acorns, sunflower seeds, and more).

### Fixed

- **Session worktree reliability**: fixes several worktree races and edge cases uncovered under normal use, including a double-spawn race on concurrent session starts, a worktree left orphaned across a config-driven session recreate, a session that fell back to running in place after failing to clean up its own worktree, worktrees no longer surviving a server shutdown/restart, and a worktree/branch leak on quick-delete when the PTY still held the directory locked.
- Manual Park is removed; the rail's one-click remove now covers retiring a session, including discarding its worktree.

## [0.18.0] - 2026-07-21

Conversations now survive a crash or shutdown and resume themselves on the next boot, the dashboard reconnects without losing notifications, and a new Rainbow Unicorns dark theme ships with a fully animated nyan cat easter egg.

### Added

- **Crash-safe auto-resume (on by default)**: Glissa captures Claude's session id the moment each conversation starts and persists it immediately, so even a hard kill of Glissa loses nothing. On the next boot, every project that was mid-conversation is respawned with `--resume` and picks up where it left off. Sessions with no captured id stay dormant rather than guessing at a conversation. A new "Auto-Resume" setting (Settings > General, `autoResume` in `config.json`, default on) is the kill switch.
- **Rainbow Unicorns (Dark) theme**: a new dark plum theme with soft lavender text, a dusty rose accent, and a rainbow identity carried by clearly separated status colors, including a vivid azure "complete" that stands out at a glance. Selecting it releases an animated pixel-art nyan cat that flies across the dashboard on randomized flights, alternating with a unicorn that trails twinkling parallax sparkles instead of the rainbow. Sprites are frame-animated (running legs, wagging tails, waving rainbow), trails fade out with a soft outline, flights prefer the upper screen and stay clear of the header, reduced-motion hides the whole show, and switching to the theme plays a short original chiptune jingle.
- **Prompt-kind chip**: while Claude is waiting on you, the session card now shows an advisory chip distinguishing a permission prompt from a question, driven by Claude Code hooks. It never affects state detection.
- **Worktree conflict pre-check**: creating a session worktree for a branch that is already checked out elsewhere now degrades gracefully to running in place, with a notice naming the conflicting path instead of a raw git error. Each worktree is also stamped with its integration branch so later reconciliation no longer assumes the config never changed.
- **Control-channel replay**: the dashboard's control connection now replays missed transient events (notifications, session errors, post-turn results, team events) after a reconnect, so a brief network blip or server restart no longer drops them.

### Fixed

- **Shutdown can no longer hang on an open dashboard tab**: Ctrl+C and service-stop signals are routed through the same guarded lifecycle as a dashboard-initiated shutdown, with a bounded wait for session teardown and a fallback exit timer.

Adds a startup update check so an outdated install tells you how to update itself.

### Added

- **Startup update check**: on launch Glissa checks the npm registry once for a newer published version and, when one exists, shows a dismissible banner under the header with the running and latest versions and a copy button for the update command (`npm install -g glissa@latest`), plus a one-line console notice. It is advisory and fail-open: any network error, timeout, or offline start is silently ignored and never delays or blocks startup. A new "Check for Updates on Startup" setting (Settings > General, on by default; `checkForUpdates` in `config.json`) is the kill switch, and a dev run from a source checkout is skipped so it never nags while you work on Glissa itself.

## [0.16.0] - 2026-06-19

A maintenance release. It adds install diagnostics (the `glissa doctor` command and post-install PATH guidance), retires the experimental Headroom proxy integration, and stops the burst of Windows console windows that flashed when sessions start and park.

### Added

- **`glissa doctor` diagnostic command**: `glissa doctor` prints a read-only report (glissa and node versions, which install is answering, the npm and pnpm global command directories and whether each is on your PATH, a node-pty load probe, and the resolved config path), so a "glissa is not recognized" or otherwise unhealthy install can be diagnosed in one step. It never starts the server or modifies anything.
- **Post-install PATH guidance**: a global `npm install -g glissa` now prints where the `glissa` command was installed and, when that directory is not on your PATH, the exact one-step fix. The notice is print-only (it never edits your PATH), stays silent for local and dependency installs, and is wrapped so it can never fail an install. A new README "Troubleshooting" section documents the same fix, including pnpm (`pnpm setup`) setups.

### Removed

- **Headroom proxy integration**: Removed the opt-in Headroom proxy supervisor (the `headroomEasyStart` and `headroomPort` settings, the header chip, start/stop control, and live savings analytics) together with the generic `proxyBaseUrl` setting that injected `ANTHROPIC_BASE_URL` into spawned sessions. Local-proxy compression did not pay off against Claude Code's own prompt caching, so the entire proxy surface (all introduced in 0.15.0) is gone. Sessions no longer read `proxyBaseUrl`; an `ANTHROPIC_BASE_URL` already present in the environment is left untouched.

### Fixed

- **Console windows no longer flash on session start or park**: starting or parking a session could pop a burst of Windows console (`cmd`) windows that stole focus and interrupted work. On a machine where Glissa runs without its own console, the worktree git probes, the junction setup, and the `taskkill` on park each spawned a visible window. Every child process Glissa spawns is now launched hidden, with a guard test that keeps any future spawn site from regressing.

## [0.15.0] - 2026-06-18

This release rolls up everything since 0.14.0. It hardens the Focus review workflow (a parked merge hands Merge back once the conflict is resolved, the review sidebar is resizable and stops repeating itself, sessions can be parked back to dormant for reuse), routes sessions through a local LLM proxy with optional one-click management and live savings analytics for an installed Headroom proxy, makes the roster rail resizable, and moves the worktree git engine and session teardown off the shared event loop, so a slow machine no longer freezes every terminal at once. It also closes a menu-restart bug that could spawn an unkillable session respawn loop.

### Added

- **Manage an installed Headroom proxy from the dashboard**: An opt-in `headroomEasyStart` setting lets Glissa detect the `headroom` CLI and start, stop, or restart a local `headroom proxy` from a header chip, with a shortcut that fills `proxyBaseUrl`; off by default, and the chip shows a dim install hint when Headroom is not installed.
- **Headroom proxy savings on the dashboard**: While the proxy runs, a header pill shows tokens removed and savings percent (request count before compression starts), with a tooltip cost breakdown and a click-through to the proxy's own dashboard.
- **Resizable session rail**: A drag handle between the roster rail and the center resizes the rail (clamped 180 to 480px), with the width persisted per browser; arrow keys nudge the handle and a double-click resets it.
- **Route sessions through a local LLM proxy**: A new `proxyBaseUrl` setting (Settings > Advanced, or `config.json`) injects `ANTHROPIC_BASE_URL` into every spawned session's environment so Claude Code routes API traffic through a local proxy (e.g. Headroom, LiteLLM). Glissa only points sessions at the proxy, never spawns or manages one; a settings change reaches existing sessions on their next start or restart, and an inherited `ANTHROPIC_BASE_URL` keeps working when the setting is empty.
- **Park a session back to dormant**: A new "Park" card-menu action returns a quiescent or finished session to DORMANT so its card parks for reuse, the inverse of starting it. Park refuses a RUNNING session and discards the session's worktree; parking a session with unmerged changes asks for inline confirmation first.
- **Pending-wakeup chip for scheduled self-revivals**: A session that schedules its own revival (a dynamic `/loop` wakeup or a cron task) now shows a "sleeping until ~HH:MM" card chip instead of looking simply finished. Advisory only, never a completion gate; `detectScheduledWakeups: false` is the kill switch.
- **Resizable review sidebar with session identity and line totals**: The review sidebar gains a drag handle (width persisted per browser), shows the selected session's name in its header, totals +added/-removed lines overall and per file, and marks Merge and Resolve with `alt+m` / `alt+r` shortcut hints. Discard reads as destructive at rest, and a "Resolve prompt sent" indicator confirms the handoff.
- **Code-slop detector**: An opt-in, report-only post-turn `slop` rule flags AI code-slop patterns (swallowed exceptions, narration-opener comments, placeholder stubs, debug leftovers, type escapes) and surfaces the count on the session card; off by default via `rules.slop`.
- **Preventive anti-slop prompt**: An opt-in `antiSlopPrompt` appends a fixed anti-slop note to a user session's system prompt at spawn (team and pack-setup stages are excluded); off by default.

### Changed

- **Switching sessions clears a completed session's alert**: Switching to a session through the Focus shortcuts or a rail-pill click now returns a COMPLETE session to IDLE, instead of leaving it COMPLETE until its terminal is clicked; a WAITING session is never dismissed on a switch.
- **Unified navbar status indicators**: The connection status, Headroom chip, and aggregate readout now share one chip shell and a quieter resting style, where a healthy state shows only its dot and label color is reserved for states that need attention.
- **Pinned review sidebar controls**: The review sidebar's Merge, Resolve in session, and Discard controls sit in a pinned region that stays in view as the diff scrolls, and Merge is always shown while a session is selected, disabled with a one-line reason when it cannot run.
- **Deduplicated review sidebar copy**: The sidebar no longer repeats the same +/- numbers at three levels and no longer states "nothing to merge" twice; while the diff loads, the reason line doubles as the loading indicator.

### Fixed

- **Terminal bottom row clipped on some displays**: The centered terminal sized its fit from the wrong element and overstated the available space, cutting off the bottom TUI row at some font metrics and display scales; the padding now lives on the measured element so the bottom edge stays on screen.
- **Menu restart could spawn an unkillable session respawn loop**: Restarting Glissa from the menu and then reopening a session could flood the screen with `cmd` windows in a tight loop that survived closing the Glissa window (only a reboot stopped it). The restart now respawns the replacement hidden (no stray console window) and at most once, waits for the previous session processes to be reaped before exiting so none are orphaned, refuses to start a second instance on the port already in use, and keeps project IDs stable across config reloads so a reload never re-spawns existing sessions.
- **Merge comes back after a parked merge is resolved**: A parked worktree merge (rebase conflict, lost fast-forward, or uncommitted changes) could never return to the Merge button once the agent resolved it; the operator had to ask the agent to merge manually. The gate now self-heals to pending-review when the worktree is clean, ahead, and not mid-rebase, and the sidebar re-renders from a fresh diff.
- **Diff base follows the session's upstream branch**: The review diff and merge gate were always computed against the globally configured integration branch; a session branch tracking a different remote ref showed commits that belonged to the wrong base. The diff base now prefers the session's upstream tracking branch, and the "merges into X" label follows it.
- **Card stuck on Idle while the session kept working**: A premature Stop hook could move the card to Idle or Complete while the spinner never paused, after which no title signal could ever wake it; the title working latch now re-opens on entry to those states so the next spinner frame self-heals the card.
- **Stale terminal after parking the focused session**: Parking and rebuilding the centered session could leave its terminal wired to a disposed instance (a stale WebSocket reconnect timer from the removed card), so the visible card received nothing until reload.
- **No spurious clipboard error on refresh**: Replayed OSC-52 clipboard sequences in the reconnect scrollback no longer trigger a "Write permission denied" toast; the write is skipped silently when there is no real user activation.
- **Worktree badge on fresh spawn**: A session's worktree badge appears the moment its worktree is provisioned, instead of only after a page reload.
- **Merge button on turn end**: The Merge button appears the instant a session finishes its turn, instead of only after clicking a review file to expand it.
- **Discoverable Alt+W attention-queue placeholder**: The roster rail's attention-queue head shows a persistent resting placeholder (a dim Alt+W hint with an "ALL CLEAR" label in a neutral box) and earns its accent only when sessions need attention, so the shortcut is discoverable and the resting head no longer reads as half-finished.

### Performance

- **Worktree git engine runs off the event loop**: The worktree git subsystem (liveness probes, per-turn post-turn checks, and worktree provision, rebase, merge-back, and discard) now runs as async, non-blocking subprocess calls, with merges into a shared branch serialized, so a session doing git work no longer freezes, stutters, or buffers the other sessions' terminals on slower machines; a `liveWorktreeReview` kill-switch can drop the backstop entirely.
- **Event-driven worktree detection**: The 10-second cross-session worktree liveness poll is replaced by an integration-branch reflog watcher, removing the recurring git spend and keeping merge gates fresh server-side even with no dashboard open.
- **Async session process termination**: The Windows `taskkill` on a session's kill and exit paths now runs asynchronously instead of blocking the shared event loop.
- **Skip the health snapshot when no dashboard is open**: The 10-second health snapshot is no longer built or broadcast when no dashboard tab is connected.
- **Lighter dashboard rendering**: The dashboard skips rendering hidden views, caches roster pill references, and the render scheduler reuses its queue array and advances by a read cursor, cutting per-render work.

## [0.14.0] - 2026-06-08

This release replaces the multi-session grid with **Focus**, a single-session navigation model: a left roster rail of one pill per session, a center work surface, and a right review sidebar. Every git-repo session now runs in its own git worktree, and you review and merge its committed work from the dashboard while it keeps running.

### Added

- **Focus view (now the default and only navigation model)**: A three-column layout (roster rail | centered session | review sidebar) replaces the multi-session grid. The left rail carries one pill per session; the center borrows the selected session's live terminal as the work surface; the right sidebar reviews its worktree. Clicks and arrow-nav move the focus, starting a dormant session when you land on it.
- **Isolated git worktree per session**: Every git-repo session runs in its own worktree forked from the integration branch (`integrationBranch`, default `develop`), so an agent's edits stay out of the main checkout until they are reviewed and merged back. Worktrees default to a `.glissa-worktrees` sibling of the repo, orphans are swept at boot, and every end path (merge, discard, exit) tears the worktree down without losing work.
- **Session worktree review sidebar**: A right-docked sidebar (present on every view) shows the selected session's changes per file and merges them into the integration branch while the session keeps running. Committed history is the mergeable unit: the sidebar splits **Committed** (will merge) from **Uncommitted** (not in the merge until committed), the diff stays live with no manual refresh (a turn-end hook, an fs-watch over the worktree, and a 10s backstop push deltas), and the merge gate is derived from the live relationship to the integration branch, so work that lands on the branch out-of-band self-corrects to "nothing to merge" and a stranded gate self-heals instead of phantom-counting.
- **Resolve a parked merge inside the session**: When a merge-back cannot fast-forward (conflicts), a "Resolve in session" action hands the conflict back to the agent that owns the worktree: it pastes a context-rich prompt (why it parked, the exact rebase-and-resolve steps, the conflicting files) into the live session. Nothing is ever auto-resolved, so no side is silently dropped.
- **Warn before discarding unmerged session work**: Removing a session that still holds unmerged worktree changes now warns that the changes will be lost and relabels the action "Discard & Remove".
- **Project-grouped roster rail**: Rail pills group by repo under quiet, collapsible per-project headers (a single-project roster stays flat); groups sort A->Z, never reorder on a state change, and the collapse state persists per browser.
- **Keyboard navigation and a Shortcuts help panel**: Global `Alt` shortcuts fire even while the centered terminal holds focus: `Alt+0` opens a session, `Alt+1`..`Alt+9` jump to the Nth, `Alt+Up`/`Alt+Down` center the previous/next session (starting a dormant target), `Alt+W` steps through the attention queue (waiting or completed) one session per press, `Alt+M` merges the selected session, and `Alt+R` resolves a parked merge. A read-only Shortcuts panel in Settings, opened by the header `?` button or the `?` key, documents them all.
- **Restore the open session and active view across reloads**: The active tab (Focus/Teams) and the centered session are remembered per browser and restored on reload or tab switch; a restored session is re-centered without auto-starting a dormant one.
- **Top-right notice stack**: The center-bottom error toast is recast as an opaque, stacking top-right notice region: transient hiccups (clipboard, rename collision) auto-dismiss after 6s, real failures persist until dismissed, identical back-to-back messages collapse into one notice with an `xN` counter, and each notice is keyboard-dismissible with `role="alert"`.
- **Live working heartbeat**: A working session's roster pill glyph breathes and beats on each terminal chunk and goes quiet after output stops.
- **Name-first roster pills with a time-in-state clock**: Roster pills lead with the session name, and the focused card header shows a clock counting time in the current state.
- **Background sub-agent completion gate**: A session with a running background sub-agent (Task `run_in_background` or Ctrl+B) stays out of Complete until the sub-agent finishes, so a background task no longer fires a false completion alert, and a live "N agents" chip shows the count. On by default via `detectBackgroundAgents`.
- **Teams: `changelog` team**: A new on-demand team (analyst -> curator -> auditor -> announcer) reconciles `CHANGELOG.md` against git history and, on a final `SHIP`, drafts a release announcement in the project's voice (drafts only, never posted).
- **Teams: operator conversation during a run**: A manual run can pause when a stage emits a `QUESTION` and resume once the operator answers in a chat pane, bounded by a question budget and timeout.
- **Teams: project-level shared pack**: Cross-team pack files (voice-guide, avoid-list, brand) are filled once per project under `.glissa/pack/` and reused by every team that declares them as shared.
- **Deterministic post-turn auto-fix on turn completion**: When a session completes a turn, Glissa runs text-hygiene fixes over its git-changed files (strip em and en dashes and ellipses, trim trailing whitespace, ensure a final newline, strip a UTF-8 BOM) and reports the result on the card; on by default.

### Changed

- **Notifications delivered via browser Web Notifications**: Notifications now raise a native browser notification by default; the BurntToast/msg path is demoted to opt-in via `osToast`, and a Desktop Notifications settings toggle gates the new channel.
- **Skip-permissions (YOLO) is the session default**: New sessions spawn with `--dangerously-skip-permissions` unless their project opts out, and the Add Session dialog now offers an opt-out "Require permission prompts" (widening the localhost-only trust boundary).
- **The centered session reads as a work surface, not a transplanted tile**: In the Focus center the borrowed session card drops its floating border, radius, and state glow and runs edge to edge; its header becomes a slim status toolbar (the name promoted to the title voice, the worktree/agents/post-turn markers compacted, YOLO kept as a legible warning), and state recedes to the rail pill plus one quiet 2px toolbar accent line (steady FAILED, breathing WAITING, a one-shot sweep on a DONE finish).

### Removed

- **Multi-session grid and its controls**: The Sessions grid's minimize and maximize, the minimized bar, drag-and-drop reordering, the manual/split layout control, and sleep/wake are gone; sessions are now navigated through the Focus view.
- **Dropped the "N sessions running" navbar banner**: The always-on active-session counter is gone (`computeAggregate` no longer emits a running/active state). The navbar now speaks only for `WAITING` (needs input) and `FAILED`, plus the terminal "All sessions exited" / "N dormant" roll-ups, and is hidden for a steady active mix. The counter was noise that carried no actionable signal. The leftover grab/grabbing drag cursor went with it.
- **Teams: standalone `release-notes` team**: Removed; its git-range research and GitHub release draft are now covered by the `changelog` team's reconciliation and announcer.

### Fixed

- **New sessions no longer read as "Working" before any prompt**: A just-spawned session landed in `RUNNING` on its first PTY byte (Claude painting its TUI), so it showed "Working" with nothing submitted. `first_output` now lands in `IDLE`; the card wakes to `RUNNING` on the first real work signal (the `UserPromptSubmit` resume hook or the title spinner), and the process-exit edges are unchanged.
- **Team run output stranded on its worktree branch**: An untracked header-only `log.md` blocked the fast-forward merge-back of a finished run; the merge-back now clears the blocking collisions first so the run lands in the project.
- **Stale stage header in the Teams view**: The run header no longer sticks on the finished stage while the next stage spawns.
- **Dropped terminal history on reconnect under backpressure**: A reconnect replay frame dropped under backpressure left scrollback history stranded; the drop now rewinds the send offset so the backfill re-pulls the missed history.
- **Inconsistent completion alerts**: A finished turn now plays the alert sound, completion notifications debounce per session and category so simultaneous completions stop cross-suppressing each other, and a process exit notifies like a turn completion.
- **WebGL glyph ghosts on expand**: Expanding a card now forces a full repaint, so stale cached glyphs no longer linger.
- **Merge a session that is parked for your input**: The review sidebar allowed merging only an idle or completed session, so a session sitting in WAITING (it ended its turn awaiting your reply) could not have its committed work merged even though the agent is quiescent. WAITING now joins IDLE and COMPLETE as a mergeable state, single-sourced so the client gate and the server `mergeAndContinue` cannot drift; RUNNING stays excluded so a worktree is never rebased underneath an actively editing agent.

## [0.13.0] - 2026-06-01

### Added

- **Linked-worktree marker on session cards**: A session whose terminal `cwd` is a linked git worktree now shows a small `worktree` chip on its card. Detection is fs-only (a linked worktree has a `.git` *file* pointing at `worktrees/<name>`, vs a `.git` *directory* for a normal checkout; submodule `modules/` pointers are excluded), so it adds no dependency, no subprocess, and no TUI scraping. Status is refreshed on the existing 10s health tick and rebroadcast as a minimal `session-git` delta, so the card toggles its marker without a recreate (which would tear down the terminal). The `.git`-file parse is hardened for Windows: the captured gitdir is `.trim()`-ed before slash normalization so a trailing CR (CRLF) and backslash separators no longer defeat the `worktrees/` segment test.
- **Keyboard navigation for sessions**: `Alt+0` opens a new session and `Alt+1`..`Alt+9` jump to the Nth session card. The handlers are guarded (no modifier mix, not in a typing context) so the keys never leak into a focused xterm, which forwards most keys straight to the PTY.
- **Teams: `qa` team (green the suite)**: A 4-stage code-writing pipeline (runner-triager -> fixer -> auditor -> reporter) that keeps a target repo's test suite green by fixing the SOURCE, with the existing human-written tests as the trusted oracle. The tests are protected two ways: excluded from the team's `writeScope` (a test edit can never merge back) and restored to the run's base SHA before every audit, so the auditor always grades source against the unedited tests. New `writeScope`/`testGlobs` fields in `team-registry.js` gate source staging on a final `SHIP` only (marketing's empty `writeScope` is byte-identical to before); `team-git.js` gained an additive per-glob `restoreTests` (one `checkout` + a `testGlobs`-scoped `clean` per glob, so a no-match glob cannot abort the whole restore and the run folder plus new source survive).
- **Teams: `release-notes` team**: A researcher -> writer -> editor -> publisher pipeline that turns merged PRs and commits since the last release into user-facing notes in the project's voice. The editor emits the `SHIP`/`FIX`/`BLOCK` verdict; the publisher drafts a GitHub release body and never auto-publishes.
- **Deterministic project context for guided team setup**: Guided pack setup now seeds the interview with a machine-gathered "STARTING FACTS" block from a pure parser core (`teamlib/project-context-core.js`) plus an fs-only scanner (`teamlib/project-context.js`) that reads a small top-level allowlist (`package.json`, README, `.git/config`, and `_config.yml`/`config.toml` only when there is no `package.json`). The scanner is total (never throws), non-recursive, never reads `.env`/`node_modules`/`.git` objects, caps the README read, and sanitizes stray dashes out of scanned content. PASS 1 of the interview was reworded from blind-explore to verify-not-rediscover, so the setup agent confirms the gathered facts instead of re-deriving them each run.

### Changed

- **Sessions view visual hardening**: An impeccable-critique pass on the Sessions/Teams tabs and terminal cards: the tabs read as primary navigation (lifted resting color, bold active tab, 1px divider from the wordmark), the Maximize button drops its cyan decoration so the DONE-state color stays reserved for real state changes, and FAILED cards keep a steady at-rest ring so a failure stays legible across the grid even when it landed on another tab.
- **Health/stat footer gated behind Debug Mode**: The bottom health/stat footer (process memory, per-session internals, WebSocket counts) was always visible. Its visibility now follows the existing `debugMode` setting, driven through the one `applyTerminalSettings` funnel alongside `setDebugMode` so initial load and live Settings toggles both update it. The footer defaults to hidden, so there is no flash before settings load.
- **Internal restructuring (no behavior change)**: Decomposed the monolithic `public/session-card.js` into focused `public/session-card/` modules (shared state/registry, toast, naming, webgl-pool, card-dom, terminal, layout, drag-drop, lifecycle) with pure logic split into `*-core.mjs` files behind characterization tests, then deleted the barrel and repointed consumers directly. Extracted the pure cores of `sessions.js` into `session-core/` (`spawn-command`, `spawn-env`, `state-machine`, `status-mapper`), leaving the stateful `Session` class at root. Moved the team server modules into `teamlib/`.
- **Dropped the "N sessions finished" navbar banner**: A finished (`COMPLETE`) session now shares the terminal "exited" bucket with `DONE` in `computeAggregate`, so it no longer raises its own navbar banner nor counts toward the `(N)` title badge. Only `WAITING` and `FAILED` still nag for attention. All-terminal still renders "All sessions exited", and a finished session beside a running one shows "N running".

### Fixed

- **Recover dropped terminal output in place after backpressure**: Terminals dropped characters and scrambled into "alien" output, usually after a reconnect. The data-WS sender discarded its coalesce buffer when the socket went over high-water and only re-sent those bytes when the client *reconnected*, so a client that drained in place kept a permanent gap, and a dropped frame carrying cursor/clear escapes desynced the xterm grid into garbage. Added a monotonic per-session output offset plus a per-client cursor and a drain-triggered backfill that re-pulls the exact missed range in place (exact tail, evicted clear+replay, or no-op), with three triggers (flush, on-data short-circuit, stall-timer quiet drain). An in-place restart now re-baselines live clients via a `rebaseline` event (a brief ~500ms data-WS reconnect + clear, consistent with the existing restart-clear).
- **Persist team-run live state across tab switches; Cancel now stops the run**: Returning to the Teams tab mid-run rebuilt the view from a bare active flag, so the live phase, the elapsed timer, and the Cancelling state were lost (timer reset to 0, pipeline blank). Separately, Cancel called `session.destroy()`, whose `removeAllListeners()` stripped the exit listener the stage runner needs to resolve, so a cancelled run hung until the 900s stage timeout. The orchestrator now tracks per-run live state (`getRunState()`) and the client rehydrates the active stage, a continuous timer, and the cancelling state on mount (and for second clients); Cancel uses `session.kill()` so listeners survive and the stage exit resolves promptly. New `team-run-cancelling` event.
- **Stop session-card header reflow on status change**: The variable-width status badge sat upstream of the YOLO/worktree tags, so every status change reflowed them sideways (the "moving YOLO tag"). The header is now dimensionally rigid: a constant-width status-label slot (sized to "Needs Input" including its letter-spacing) plus a repositioned spacer that absorbs the badge's width change. The minimized bar is unaffected (it hides those elements by `display`, which is order-independent).
- **Guided team-pack setup focuses the interview terminal**: Clicking "Set up automatically" now jumps to the Sessions view and focuses the spawned interview session, so the click no longer appears to do nothing.
- **Guard PTY writes after kill and respawn at the last resized size**: Writes arriving after a kill no longer hit a dead PTY, and a respawn restores the last resized dimensions instead of reverting to the default geometry.
- **Never auto-sleep live-PTY sessions**: Auto-sleep eligibility included `IDLE` and `COMPLETE`, which are live-PTY (killable) states, so minimizing such a session auto-slept it and armed the 15-minute sleep-kill timer, terminating work that could still continue. Eligibility is now restricted to the dead-PTY terminal states (`DONE`/`FAILED`), whose process has already exited, in both the client guard (`layout.js`) and the server guard (`sessions.js`). GPU pressure from now-awake minimized live cards stays bounded by the WebGL LRU cap.
- **Guided-setup card X button now tears the session down**: The remove-session control handler routed every removal through the config-reload diff, which skips ephemeral sessions (the guided-setup card is never persisted to `config.projects`), so its X button was a dead click. Removal now routes ephemeral sessions to a direct teardown (`_teardownSession`, extracted in `backend.js` and reused by the config-removal path with the ack-before-destroy invariant preserved).
- **Windows crash creating guided-setup session settings**: Setup session ids look like `setup:<team>:<project>`; the colons are illegal in a Windows path segment and crashed the per-session settings `mkdir` with `ENOENT`. The settings injector now sanitizes only the on-disk directory segment; the real id still rides the hook URL (URL-encoded), so hook routing is unchanged.

### Removed

- **Redundant bottom "+ New Session" ghost card**: The minimized-bar ghost card duplicated the top-bar "+ Session" button, so it was removed; the minimized bar is now an empty `<div>` hidden via `.minimized-bar:empty`, and the remaining open paths (the dead `btn-add-session` listener and the empty-state CTA) route to the header button.
- **No-Flicker Mode setting removed**: `CLAUDE_CODE_NO_FLICKER` is now always set to `"1"` at spawn; the per-session toggle and `noFlicker` spawn option have been dropped.
- **Scrollback Lines setting removed**: Terminal scrollback is now fixed at 50,000 lines; the configurable `scrollbackLines` setting has been removed.
- **Timing settings removed**: The startup watchdog (`startingWatchdogSeconds`) has been dropped entirely; WAITING-notification escalation is now fixed at 5 minutes (previously `waitingEscalationSeconds`); the attention timeout (`attentionTimeoutSeconds`, already inert) has been removed.
- **Feed Debounce setting removed**: `feedDebounceMs` had no effect and has been removed as a dead vestige of the old content-scraping detection engine.

## [0.12.0] - 2026-05-31

### Added

- **Teams: project-portable agent pipelines**: A team is a sequential agent pipeline (the bundled `marketing` team runs researcher -> strategist -> writer -> editor -> publisher) that can be pointed at any project Glissa manages. Ownership is split so the same agents serve every project: Glissa owns the generic, brand-neutral agents (`teams/<id>/team.json`, `agents/*.md`, `pack-templates/*.md`), and each project owns its specifics (voice-guide, avoid-list, brand, content-calendar, channels) under `<project>/.glissa/teams/<id>/pack/`. On first run the orchestrator scaffolds the pack from `pack-templates/`, emits `team-run-needs-setup`, and halts (zero stages) until the pack's `GLISSA:NEEDS-INPUT` sentinels are filled. Each run executes inside a throwaway git worktree from HEAD (`team-git.js`), commits, and fast-forwards back to the base branch so the working tree is never dirtied mid-run; a non-git target runs in place. Stages are headless `claude -p` sessions gated on required markdown sections in the handoff file; the editor emits a `SHIP` / `FIX` / `BLOCK` verdict and the publisher (Postiz drafts) runs only on `SHIP`. New modules: `team-registry.js`, `team-orchestrator.js`, `team-output.js`, `team-git.js`, `team-prompt.js`, `team-settings.js`, `team-blacklist.js`, `scheduler.js`, `spawn-gate.js`, with control-channel wiring in `control-handlers.js` and the `public/teams-panel.js` dashboard panel.
- **Guided team pack setup**: The dashboard's "Set up automatically" button sends `setup-team-pack`, which spawns ONE interactive Claude session (a normal PTY card, not a headless `-p` stage, since the interview needs back-and-forth). Seeded by `team-setup.js`, it reads the target repo, interviews the operator for the subjective pack fields (voice, avoid-list, audience), writes each pack file with the `GLISSA:NEEDS-INPUT` sentinel removed, and on exit broadcasts `team-pack-updated` so the dashboard drops the setup banner. The session is ephemeral: it lives in the `sessions` map, is never persisted to `config.json`, and is skipped by config-reload diffing.
- **Teams: bounded FIX revision loop**: A `FIX` verdict from the editor used to dead-end (the publisher is gated `runIfVerdict: "SHIP"`, so nothing shipped and a re-run only regenerated a new topic). The orchestrator now runs a bounded revision loop declared on the verdict stage (`revise: { onVerdict, stages, maxRounds }`, default `maxRounds: 2`): on `FIX` it re-runs the writer with the editor's FIX list (`review.md`) plus its prior `drafts.md` (via a new `reviseReads` stage field), then re-audits, until `SHIP` (publisher runs), `BLOCK`, a byte-identical no-progress bail, or the round budget. Each round's prior `drafts.md`/`review.md` are archived under `runs/<id>/rounds/r<n>-*` (`team-output.archiveRoundArtifacts`); the run log records the outcome (`FIX->SHIP (2 rounds)`, `FIX (maxRounds 2)`, `FIX (no-progress, round 1)`). The publisher still runs ONLY on a final `SHIP` (the `runIfVerdict` gate is unchanged). New `team-revise-round` control event; `round` added to `team-stage-started`/`team-stage-complete` and `rounds` to `team-run-complete`; the dashboard Teams panel shows a per-stage revision badge and a round count. The writer/editor/publisher prompts were hardened to converge (writer sourcing discipline + a Revisions section that softens unresolvable CTAs; editor re-audit; publisher CTA pre-queue check).
- **Teams: reusable shared blocks**: Agent role prompts and pack scaffolds moved from `teams/marketing/` to `teams/_shared/agents/` and `teams/_shared/pack-templates/` so new teams compose from shared blocks instead of copying. `team-registry.js` resolves each stage's prompt by explicit `stage.agent` (a shared role by name, path-traversal rejected) > team-local `agents/<id>.md` > shared `_shared/agents/<id>.md`; pack templates fall back to `_shared/pack-templates/` (`scaffoldPack` gained a fallback dir). A team that names its stages after shared roles needs no local agent files; the bundled `marketing` team now carries only its `team.json`.

### Changed

- **Design system pass**: Added `DESIGN.md`/`DESIGN.json` (renamed `.impeccable.md` -> `PRODUCT.md`) and reworked the dashboard surface (theme, Tailwind tokens, `index.html`, dialogs, settings dialog, `style.css`) for a more cohesive visual language. A new perf harness (`public/perf-harness.js`, `perf.html`, `render-scheduler.mjs`, `perf-corpus.mjs`) profiles render scheduling under load.
- **Spawn the resolved `claude.exe` directly instead of `cmd.exe /c claude`**: On Windows, sessions previously always spawned through `cmd.exe /c claude` so cmd would resolve `claude` against PATH + PATHEXT. `sessions.js` now resolves `claude` once at module load (`resolveClaudeCommand`, reusing the existing `where claude` first-match), classifies it by extension (`classifyClaudeKind`), and a pure `buildSpawnCommand` chooses the spawn form: a real PE image (`.exe`/`.com`) is handed straight to node-pty (`pty.spawn(<abs path>, args)`), while `.cmd`/`.bat`/`.ps1` shim installs (or a failed resolution) keep the byte-identical `cmd.exe /c claude` fallback. This removes the intermediate `cmd.exe` process on the common native-installer path, eliminates the double command-line parse (node-pty then cmd, a quoting/`%`-expansion hazard for paths with spaces or special chars), and removes cmd's own console-title write (`C:\...\cmd.exe`) that was the source of the startup `unknown leading title glyph U+43 ("C")` noise. Complements the OSC-title fix below rather than replacing it (ConPTY/claude can still set an initial title, which the title source already ignores). A `spawnCommand` constructor seam lets tests exercise every branch without a real claude install.

- **Rewrote status/notification detection around structural signals (deleted content scraping)**: Replaced the brittle screen-scraping stack (`patterns.js` 3-layer prompt heuristics, `ansi-tokenizer.js`, `line-assembler.js`, and the `sessions.js` Layer-4 chrome blacklist + idle-timer guesswork) with a small two-source `StatusSource` pipeline. Status now comes from **Claude Code hooks** (authoritative) injected at spawn via `claude --settings <file>` HTTP hooks that POST to a localhost `POST /hook/:glissaId/:event` route (per-session bearer token; no repo modification), with a minimal **OSC-0 title** source (`detection/osc-title-source.js`) as an honest, degraded-only fallback that emits `working`/`ready`/`unknown` and never guesses "needs input". Signals map to the state machine per a documented signal x state matrix; two new transitions (`WAITING`/`IDLE` -> `COMPLETE` on an authoritative `Stop`) prevent dropping a late turn-end. A conflict window makes `awaiting-input` dominate a racing `ready`, killing the spurious "finished" toast when a turn ends on an attention prompt. The PTY stream is now a pure display pipe: the only hot-path work is OSC-title scanning (~1 MB parses in ~20 ms; no tokenizer/line-assembler). Hook gotchas designed around: `Stop` misses tool-call-end turns (#3118, paired with `Notification(idle_prompt)`), `Stop` double-fire (#3465, deduped), 600 s default hook timeout (short timeout + instant-200 handler), and managed-settings hook blocking (OSC-title fallback). See `docs/postmortem-terminal-detection.md`.
- **Recorder format v2**: `session-recorder.js` bumped to version 2; replaced the legacy `detection` record with a `hook` record (`{"type":"hook","event","payload"}`) capturing inbound hook callbacks interleaved with PTY data. A version-aware replay harness (`detection/replay.js`) drives recordings (v1 and v2) back through the real detection pipeline for ground-truth regression testing.

### Removed

- **Session layout toggle (Auto / Grid / Split)**: The header segmented control that let an operator pin the session arrangement is gone; the layout is now always automatic, following the live session count (exactly two sessions render side-by-side, any other count is a grid). Dropped the `#layout-toggle` markup and its `.layout-toggle`/`.layout-opt` styles, the `_manualLayout` pin and `updateLayoutToggleUI` in `app.js` (collapsing `autoLayout` to the count rule), and the unused `layout` UI-pref accessors (`getLayout`/`setLayout`). The split-rendering engine (`setLayoutMode`, `.layout-split`) is unchanged, so two-session split still happens automatically.

### Fixed

- **Injected hooks failing with ECONNREFUSED under `npm run dev`**: Glissa injects per-session Claude Code hooks with IPv4-literal URLs (`http://127.0.0.1:<port>/hook/...`), and `server.js` binds `127.0.0.1` in production. The Vite dev server set no host, so it defaulted to `localhost`, which on Windows binds `::1` (IPv6) only; every injected HTTP hook (`Stop`, `UserPromptSubmit`, `SessionStart`, ...) then hit IPv4 loopback with nothing listening and failed. `vite.config.js` now pins `server.host` to `127.0.0.1` so the dev listener matches the injected URLs and production.
- **Stop logging cmd.exe window titles as "unknown glyph"**: On Windows, Glissa spawns `cmd.exe /c claude`, and cmd sets the console title to its command line (`C:\...\cmd.exe`) before Claude takes over the title. `detection/osc-title-source.js` assumed every OSC-0 title leads with a Claude activity glyph, so the leading ASCII `C` hit the `unknown` branch and logged `unknown leading title glyph U+43 ("C")` at every spawn. Claude's glyphs (braille spinner U+2800-28FF, idle `✳` U+2733) are all > U+007F, so the source now drops any title whose leading char is plain ASCII (<= U+007F) as a generic shell/OS window title: no signal, no warning. `unknown` is now reserved for genuine non-ASCII new-glyph candidates worth triaging into `KNOWN_IDLE_CODEPOINTS`. No behavioral impact on detection (hooks remain authoritative; `unknown` was already meta-only), purely removes the false warning.
- **Resize Claude Code when the browser window changes**: Two fixes together. (1) PTY-side: previously, resizing while a session was IDLE/COMPLETE/WAITING parked the new dimensions in `_pendingResize` and only flushed them when the session next transitioned to RUNNING. If Claude was quiescent and the user did not type or trigger a state change, the PTY never learned the new size and Claude kept formatting output for the old dimensions. The resize now applies to the PTY immediately in all states; a 1500ms `_resizeGraceActive` flag suppresses the redraw-induced false IDLE/COMPLETE to RUNNING transitions and auto-recover counter inflation that the original deferral (commit 1464a9b) was added to prevent. (2) Browser-side: collapsed the resize trigger graph onto the per-terminal `ResizeObserver` (replacing the parallel `window.resize` listener and the scattered `scheduleFitAll()` calls that fired before the observer had measured the settled box), RAF-throttled so burst fires during a window drag coalesce to one fit per frame. The observer's callback now also owns the WebSocket resize push: instead of relying on xterm's `onResize` event (which silently no-ops when fit proposes the same cols/rows xterm already has), every fit reads `term.cols`/`term.rows` directly and sends if they differ from the last successfully-sent pair. A `lastSent` cursor only advances after the send actually goes out, so a fit that runs before the data WS is open still gets retransmitted on `open` via `ui._applyFit()` instead of being silently swallowed.

- **Recognize Claude Code "`· /command`" footer chrome**: Claude's status-bar footer rows (e.g. `1 claude.ai connector needs auth · /mcp`, `MCP server disconnected · /mcp`) were not in any Layer 4 filter, so when one sat as the pending line after a brief IDLE→RUNNING redraw, the idle timer fired `prompt_detected` Layer 4 and the session transitioned to WAITING. A structural regex `/·\s*\/[a-z][a-z0-9_-]*\b/i` now covers the whole `<text> · /<slash-command>` footer family.

- **OSC 52 clipboard writes from inside the terminal**: xterm.js drops the OSC 52 sequence by default, so every `\x1b]52;c;<base64>\x07` write from programs like Claude CLI was a silent no-op. Registered an OSC 52 parser handler that decodes the base64 payload and writes to the system clipboard via the Clipboard API. Also replaced the silent `.catch(() => {})` on the Ctrl+C copy path with `reportClipboardFailure`, which logs to console and raises a toast so Clipboard API rejections stop disappearing.

- **Ghost glyph artifacts on browser resize and terminal scroll**: Two fixes together. (1) When the terminal buffer reflowed after a dimension change, the WebGL renderer left stale cached glyphs in cells that had shifted, surfacing as fragmentary text (e.g. `ei`, `ha`, `n-`) pinned to the left edge of the viewport. `applyFit()` now tracks the last fitted cols/rows and calls `webglAddon.clearTextureAtlas()` whenever the new fit changes either dimension. Per the addon docs that invalidates the cached atlas and triggers a full redraw, overwriting the ghost cells. (2) The same renderer also left column-0 glyphs (bullets, leading words) drawn over scrolled-in content. Added a RAF-coalesced `term.onScroll` handler that calls `term.refresh(0, term.rows - 1)` so every visible row is redrawn after a scroll.

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
- **Layer 4 false positive elimination**: Add 7 new detection categories to `isLayer4Chrome` - wide-spaced user typing, short garbled fragments, URLs, task checkbox rendering, system messages (Bypass Permissions, Pasted text), HUD counter fragments, and OMC/auto-update chrome strings. Eliminates spurious "needs input" notifications especially when sessions are idle.
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
- **Layer 3 pattern filters**: Reduce false positive prompt detections - skip short fragments, trailing URL schemes (`://`), and indented short menu items.
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

- `notify.js` - functions are now no-ops with one-time deprecation warnings. Use NotificationManager instead.

### Removed

- Unused imports in control-handlers.js (`makeSession`, `wireSessionEvents`, `closeSessionDataClients`).
- `_escalationTimer` and `_destroying` flag from Session class (responsibility moved to NotificationManager).

## [0.3.0] - 2026-03-19

_Skipped in changelog - incremental fixes and version bump._

## [0.2.0] - 2026-03-17

### Added

- **Maximize mode**: Click the Maximize button to expand a terminal full-screen while all others collapse to the minimized bar. Click any minimized session to switch. Press ESC or click Restore to return to grid view.
- **COMPLETE state**: When an agent works for 30+ seconds and goes quiet, the session shows a green "Complete" badge and triggers a Windows toast notification. Clicking the terminal dismisses it back to Idle.
- **Notification debouncing**: Deduplicate toast notifications per category (waiting, failed, complete) within a configurable window.
- Suppress Windows toast notifications when the dashboard browser window is focused.

### Changed

- Rename "Running" badge to "Working" - reflects active agent output.
- Rename "Done" badge to "Exited" - reserved for process exit; "Complete" now indicates finished tasks.
- Reduce default idle timeout from 60s to 5s - terminals return to Idle quickly when output stops.
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

- Focus mode (CSS-only) - replaced by maximize mode which uses real minimization.
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

[0.16.0]: https://github.com/johncwaters/glissa/releases/tag/v0.16.0
[0.15.0]: https://github.com/johncwaters/glissa/releases/tag/v0.15.0
[0.14.0]: https://github.com/johncwaters/glissa/releases/tag/v0.14.0
[0.13.0]: https://github.com/johncwaters/glissa/releases/tag/v0.13.0
[0.12.0]: https://github.com/johncwaters/glissa/releases/tag/v0.12.0
[0.11.0]: https://github.com/johncwaters/glissa/releases/tag/v0.11.0
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
