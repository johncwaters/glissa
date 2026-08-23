# Glissa

[![CI](https://github.com/johncwaters/glissa/actions/workflows/test.yml/badge.svg)](https://github.com/johncwaters/glissa/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Platform: Windows | Linux](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-0078d4)](https://github.com/johncwaters/glissa)

**Run dozens of Claude Code agents at once. See every session. Miss nothing.**

Running more than a couple of Claude Code agents at once turns into alt-tabbing between terminal windows, missing the exact moment one finishes or silently blocks on a prompt, and merging work you never watched happen. Glissa is the shipped fix: one browser dashboard, live terminal output for every session, exact status instead of a guess, and per-agent git worktrees you can review and merge without leaving the page.

I run my daily agent fleet in it. This README was written inside a Glissa session: Glissa is developed inside Glissa.

![Glissa dashboard mid-run: two Claude Code sessions streaming live terminal output, one working, one flipping to Complete with its real output and worktree diff visible in the review sidebar](assets/pictures/glissa-demo.gif)

## Install

Glissa ships from this repo, through two channels. It is not an npm package: nothing is published to any registry, and the `github:` spec below is the only supported install.

### Server machines: claude-setup

My own always-on machines are provisioned by the [`claude-setup`](https://github.com/johncwaters/claude-setup) server profile: it clones this repo to `~/Projects/glissa`, runs `npm ci` and `npm run build`, installs a systemd user service, and fronts the remote listener with `tailscale serve`. Updating is re-running its apply script.

### Standalone CLI

Requires npm 12 or newer (`npm --version` to check). npm 12 refuses git dependencies by default, so the install carries an explicit opt-in flag. On Windows and macOS this is the whole command (node-pty ships prebuilds there, and `prepare` builds `dist/` during npm's git preparation regardless of the install-scripts policy):

```bash
npm install -g github:johncwaters/glissa --allow-git=root
```

On Linux, node-pty has no prebuilds and must compile through node-gyp at install time, which npm 12's default script-skipping prevents; add the broad scripts opt-in (and have the build toolchain from Requirements installed):

```bash
npm install -g github:johncwaters/glissa --allow-git=root --dangerously-allow-all-scripts
```

On an older npm, run the same command through `npx npm@12 install -g ...` without upgrading. The npm 12 floor is hard, not advisory: npm 11 global installs from git specs are broken outright ([npm/cli#9406](https://github.com/npm/cli/issues/9406), the package lands as a link into npm's cache temp clone, which npm then deletes). The broad scripts flag on Linux is deliberate, all three alternatives verified against npm 12.0.2: the targeted `--allow-scripts node-pty` form FAILS the whole git-spec install (`EALLOWSCRIPTS`, the git-dep preparation runs as a project-scoped subprocess that refuses the flag), and a plain `npm rebuild node-pty` afterwards is blocked by the same allowScripts policy. A scripts-skipped Linux install is repaired in place with `cd "$(npm root -g)/glissa" && npm rebuild node-pty --dangerously-allow-all-scripts` (also verified), or by rerunning the install with the flag above. `glissa doctor` reports whether the native module loads.

Or clone and run it in place:

```bash
git clone https://github.com/johncwaters/glissa.git
cd glissa
npm ci
npm run build
npm start
```

Open `http://localhost:3000` to view the dashboard.

To update a clone, pull and rebuild (Glissa's own startup update check nudges you with the same three steps; `--ff-only` is the safer form of the pull):

```bash
git pull --ff-only && npm ci && npm run build
```

Then restart the server (`systemctl --user restart glissa` where the service is installed). See [docs/distribution.md](docs/distribution.md) for the full picture.

### Docker preview

The Dockerfile is a courtesy preview path, not the recommended daily path. The container has no authentication and must only ever be published to localhost.

```bash
docker build -t glissa .
docker run -e GLISSA_HOST=0.0.0.0 -e GLISSA_INSECURE_BIND=1 -p 127.0.0.1:3000:3000 glissa
```

The two env vars make Glissa bind all interfaces INSIDE the container (docker port mapping cannot reach the container's loopback); the `-p 127.0.0.1:...` prefix is what keeps the host side loopback-only. Never publish the port wider. Claude Code credentials and repos must be mounted for real use.

## Usage

```
glissa                        # Start on default port 3000
glissa doctor                 # Diagnose install / PATH issues and exit
glissa pair                   # Mint a single-use pairing link for a remote device
glissa pair --list            # List paired devices
glissa pair --revoke <id>     # Revoke a paired device

glissa pair --name <label>    # Label the device being paired
glissa --port 3001            # Override the server port (default: 3000)
glissa --config <path>        # Path to config file (default: ~/.glissa/config.json)
glissa --version              # Show version number
glissa --help                 # Show help
```

Open `http://localhost:3000` to view the dashboard.

## Remote access

Remote access is off unless you add a `remote` block to `config.json`; it opens a second loopback listener designed to sit behind a reverse proxy such as `tailscale serve`, never a wider bind. Pair a device with `glissa pair`, which prints a single-use URL valid for 10 minutes and sets an auth cookie on redemption; `glissa pair --list` and `glissa pair --revoke <id>` manage devices, and a revoke takes effect without a restart.

```bash
glissa pair --name phone
glissa pair --list
glissa pair --revoke <device-id>
```

Pairing grants real access to your machine; see [Limitations](#limitations) for the whole trust boundary.

## Troubleshooting

### `glissa` is not recognized after the global install

The install succeeded, but the directory where npm placed the `glissa` command is not on your PATH (common with a zip/standalone Node, a locked-down corporate image, or pnpm without `pnpm setup`). To fix it:

1. Confirm it installed: `npm ls -g glissa`
2. Find npm's global command directory: `npm config get prefix`. On Windows the command shims (`glissa.cmd`, `glissa.ps1`) live directly in that directory.
3. Make sure that directory is on your PATH. The official Node.js Windows installer adds it for you; if you installed Node from a zip, add it in PowerShell, then open a NEW terminal:

   ```powershell
   [Environment]::SetEnvironmentVariable("PATH", [Environment]::GetEnvironmentVariable("PATH","User") + ";$(npm config get prefix)", "User")
   ```

4. Using pnpm? Run `pnpm setup` once (it configures and registers the global bin directory), then reinstall.
5. Once `glissa` resolves, run `glissa doctor` to confirm PATH, the native module, and the config path are all healthy.

## Features

- Focus view: a single-session work surface with a roster rail of every session beside a worktree review sidebar
- Per-session git worktree isolation: review and merge each agent's committed work from the dashboard while it keeps running
- Spawn and manage multiple Claude Code sessions simultaneously
- Real-time terminal output via xterm.js with WebGL acceleration
- Structural status detection: hooks as the authoritative signal, an OSC-0 title fallback, never screen scraping (see below)
- Background sub-agent completion gate: a session with live background agents or tasks stays out of Complete until they finish
- Native browser notifications when a session needs input, finishes, or fails (opt-in Windows toast fallback)
- Phone layout as a first-class second layout, not a squeezed desktop: Board, Terminal, Review, Radar, PRs and Usage screens, attention-first ordering, and soft-keyboard handling that resizes the terminal instead of covering it
- Remote mode (opt-in): a separate listener with single-use device pairing and cookie auth (see [Remote access](#remote-access))
- Telegram notifications (opt-in): pings your phone only when no dashboard tab is open anywhere, so it fills the gap instead of duplicating the browser notification
- Image upload from the phone key strip: pick an image, and its saved path is pasted into that session's prompt for you to send
- Keyboard navigation: jump between sessions, step through the ones needing attention, and merge or resolve from the keyboard
- GitHub PR auto-review (opt-in): reviews your own open PRs headlessly, comments its findings, and auto-merges only the clean PRs whose checks are green
- Radar error monitoring (opt-in): polls PostHog error tracking, pings Telegram the moment an issue spikes, regresses, or first appears, and sends a headless agent to diagnose it and write a report
- Radar auto-fix (opt-in): a spiking, regressed, or new issue gets an agent that reproduces the bug first, repairs it in a throwaway worktree, and hands back a pull request Glissa opens for you; the agent can never push or merge
- Auto-resume by default: sessions that were live when Glissa stopped come back on the next start with their Claude conversation resumed
- Configurable themes, hot-reloadable configuration

## Why the status detection is hard (and how Glissa does it)

The obvious way to know if a Claude Code session finished, is waiting on you, or is still working is to scrape the terminal: watch for a prompt string, a spinner glyph, some text pattern. It breaks constantly. Every TUI redraw, every theme change, every Claude Code release that adjusts spacing invalidates the scrape. Glissa never does this.

Instead, at spawn Glissa injects Claude Code hooks scoped to that one session, no changes to the target repo, that POST to a local HTTP endpoint on every lifecycle event: prompt submitted, turn stopped, notification raised, sub-agent started or finished. These hooks are the authoritative signal. An OSC-0 terminal title fallback (spinner glyph = working, idle glyph = ready) covers the gap for anything that predates or bypasses the hooks. The two are merged with explicit precedence (hook beats title) and a short conflict window so a racing signal can still win before the UI settles.

That design didn't arrive whole. Three incidents shaped it:

`/clear` and `/compact` fire no `UserPromptSubmit` and no `Stop`, but the terminal redraw briefly flashes a spinner then an idle glyph in the title. Early on, that flash looked exactly like a finished work cycle, so Glissa fired a "session complete" notification on every `/clear`. (The bug report was, more or less, "why did my terminal congratulate me for clearing the screen.") The fix: on a detected clear/compact, reset both signal sources and mute title-only signals until the next real prompt.

A background sub-agent (launched via `Task` with `run_in_background`, or Ctrl+B) can still be running when the main agent's own turn ends and its `Stop` hook fires. Treating that `Stop` as completion closed the card while real work was still happening in the background. The fix is a completion gate: Glissa counts live sub-agents from `SubagentStart`/`SubagentStop` and reconciles that count against `background_tasks`, a field Claude Code's own hook payloads declare independently. Staleness between the two is resolved by a sequence number, not a timestamp, because concurrent signals routinely land in the same millisecond.

Boot auto-resume (reattaching a session's Claude conversation after Glissa restarts) depends on capturing Claude's session id from a hook. It was wired to capture that id from `SessionStart`, which seemed reasonable until testing showed Claude Code doesn't reliably fire `SessionStart` on interactive startup at all, silently dead in production, no error, resume just never happened. The fix: capture the session id from whichever main-agent hook arrives first, since they all carry it.

Every session also writes a JSONL forensic recording by default (hook payloads and state transitions, not raw terminal bytes), and a version-aware replay harness drives recorded traffic back through the detection code as regression fixtures. That's how bugs like the ones above get diagnosed from real session data instead of guesswork, and how they stay caught if the logic regresses.

## Engineering notes

- Pure-core seam architecture: IO-free decision logic lives in `session/core/` and `*-core.mjs` modules; thin shells around them do the actual I/O.
- `node:test` suite in `tests/`, zero test-framework dependency.
- Table-driven state machines, e.g. `session/core/state-machine.js`.
- Fail-closed PR auto-review merge gate: `server/core/pr-review-core.js` only merges a clean, non-stale, green-checks PR; anything ambiguous (no checks, a `gh` error, a touched workflow file) blocks instead of guessing.
- Server-side fix handoff in the Radar lane: the fix agent may only commit locally (`git push` and every `gh` call are denied it, because a prefix deny-list cannot constrain a push target), so `server/posthog-wiring.js` does the push and opens the pull request from arguments it built itself, refusing any diff that touches `.github/workflows/`.
- Bounded-retention session recorder: `session/session-recorder.js`, capped by file size, file count, and age so it can run unattended indefinitely.

## Focus

Glissa centers on one session at a time. A left **roster rail** lists one pill per session (grouped by project, with a live working heartbeat and a "needs you" queue); the **center** borrows that session's live terminal as the work surface; a right **review sidebar** shows its changes.

Every git-repo session runs in its own git worktree forked from the integration branch (`integrationBranch`, default `develop`), so an agent's edits stay out of your main checkout until you review them. The sidebar splits **Committed** (the mergeable unit) from **Uncommitted** work, keeps the diff live, and merges into the integration branch with one click while the session keeps running. If a merge hits conflicts it parks, and **Resolve in session** hands the conflict back to the agent that owns the worktree with a ready-to-run prompt.

Navigate it all from the keyboard: `Alt+1`..`Alt+9` jump to a session, `Alt+Up`/`Alt+Down` move through the rail, `Alt+W` steps through the sessions needing attention, and `Alt+M` / `Alt+R` merge or resolve the selected one. Press `?` for the full list.

## Configuration

On first run, Glissa creates `~/.glissa/config.json` with defaults. You can also configure from the dashboard Settings button.

```json
{
  "port": 3000,
  "projects": [
    { "name": "my-project", "path": "C:\\path\\to\\project" }
  ],
  "repoRoots": ["C:\\path\\to\\repos"]
}
```

This is a minimal starting example. The full key list (`integrationBranch`, `autoResume`, `prReview`, `posthog`, `detectBackgroundAgents`, `recordSignals`, and more) is documented in the dashboard's Settings dialog and can also be edited directly in `config.json`.

## Requirements

- **Node.js** >= 18 to run Glissa (clone path). The standalone CLI install needs **Node.js >= 22.22.2**, because it goes through npm 12 and that is npm 12's own engine floor (`npx npm@12` fails the same check on an older Node). Distro-packaged Node is usually far older than either floor; use nodesource or nvm.
- **Windows 11 or Linux**
- **Claude Code CLI** installed and available on PATH
- **Linux build tools for node-pty:** `sudo apt install build-essential python3`

## Development

```bash
npm install
npm run dev             # Vite dev server with HMR (port 5173)
npm run dev:server-only # Express backend only (port 3000)
npm run build           # Production build to dist/
npm start               # Production server
```

`tests/` is the automated `node:test` suite (`npm test`). `test/` holds manual smoke scripts, run by hand, not part of CI.

## Limitations

- **Windows 11 and Linux.** Developed daily on Windows 11, which is where the multi-session tooling didn't exist; it also runs on Linux servers, which is how my always-on machines are provisioned. macOS is untested, not merely undocumented.
- **Local-first, with an opt-in remote door.** By default Glissa binds `localhost` and neither WebSocket channel has authentication, so any local process can connect. That's a deliberate single-user scope choice, not an oversight, but it means the local port must never be exposed to the network. Remote access is a separate opt-in listener gated by single-use pairing tokens and cookies, meant to sit behind a reverse proxy such as `tailscale serve`; a pairing cookie grants full code execution as the server account, so pairing URLs are passwords and should be handled like them.
- **Requires the Claude Code CLI.** Glissa spawns and manages it; it doesn't replace it.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

[MIT](LICENSE)
