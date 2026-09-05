# Distributing Glissa

Glissa is not an npm package. Nothing is published to any registry (`package.json` is `"private": true`), and the GitHub repo (`github.com/johncwaters/glissa`) is the only source of truth. npm appears below purely as the install tool: a `github:` spec install clones this repo and packs it locally, never touching a registry.

## Server machines

Provisioning and updating are owned by the operator's dotfiles repo. Its server profile:

1. Clones `https://github.com/johncwaters/glissa.git` to `~/Projects/glissa`.
2. Ensures Linux has the node-pty build tools: `sudo apt install build-essential python3`.
3. Runs `npm ci` then `npm run build`.
4. Installs a systemd user unit (`glissa.service`) and enables linger so it survives logout.
5. Fronts the remote listener with `tailscale serve`.

To update a server, re-run the dotfiles apply script; it does `git pull --ff-only`, `npm ci`, `npm run build`, and restarts the service. By hand, the same sequence is:

```bash
cd ~/Projects/glissa
git pull --ff-only && npm ci && npm run build
systemctl --user restart glissa
```

## Standalone CLI

For a machine that only needs the `glissa` command (npm 12 or newer required). Windows and macOS (node-pty prebuilds ship, and `prepare` builds `dist/` during npm's git preparation regardless of the scripts policy):

```bash
npm install -g github:johncwaters/glissa --allow-git=root
```

Linux additionally needs node-pty compiled at install time, which npm 12's default script-skipping prevents:

```bash
npm install -g github:johncwaters/glissa --allow-git=root --dangerously-allow-all-scripts
```

On an older npm, run the same command through `npx npm@12 install -g ...`. The floor is hard: npm 11 global installs from git specs land as a link into npm's cache temp clone, which npm then deletes (npm/cli#9406, fixed by pacote 22 which ships in npm 12). `--allow-git=root` is npm 12's opt-in for git dependencies, scoped to the root package. The Linux scripts flag must be the broad one, all alternatives verified against npm 12.0.2: targeted `--allow-scripts node-pty` FAILS the whole git-spec install (`EALLOWSCRIPTS` from the project-scoped git-dep preparation), and a plain post-hoc `npm rebuild node-pty` is blocked by the same allowScripts policy. The repair for a scripts-skipped Linux install is `cd "$(npm root -g)/glissa" && npm rebuild node-pty --dangerously-allow-all-scripts` (verified), or rerunning the install with the flag. `glissa doctor` reports whether the module loads.

npm packs the repo before installing from a GitHub spec, so `package.json`'s `files` whitelist still bounds exactly what lands in the install.

## Releases

A release is a version bump plus a `CHANGELOG.md` entry plus an annotated `vX.Y.Z` tag pushed to GitHub (`scripts/release.ts`, `npm run release`). Nothing is published anywhere. The running server's update check keys on the latest valid release tag, not on the tip of `main`, so unreleased commits do not trigger the banner. The npm-global update command pins that tag (`github:johncwaters/glissa#vX.Y.Z`); clone updates still use `git pull --ff-only && npm ci && npm run build`. The check is advisory and notify-only, rechecks daily while a dashboard is connected, and persists a 6h throttle in `~/.glissa/update-check.json`.

## What is enforced, and where

Per the repo's docs-must-be-enforceable norm, these claims are pinned by tests rather than by this page:

- The update check (installed identity, latest release sources, advisory-only failure paths, the per-flavor update command, the persisted throttle): `tests/update-check.test.ts` and `tests/update-core.test.ts`, part of `npm test`.
- Dashboard-driven update staging, guarded handoff, startup recovery and lifecycle coordination: `tests/update-apply.test.ts`, `tests/update-apply-core.test.ts`, `tests/recover-handoff.test.ts`, `tests/server-lifecycle.test.ts` and `tests/git-workspace-session.test.ts`, part of `npm test`.
- The `files` whitelist covering every module the entry points require, and every SHIPPED pack spec having its sources inside the tarball (a spec reaching outside `packs/`, like the repo-development `glissa` pack, must be excluded or first boot logs a rebuild failure): the packaged-install job in `.github/workflows/test.yml` installs the real tarball and runs `glissa doctor` against it.

The provisioning flow itself (clone path, systemd unit, tailscale serve, apply script) lives in the dotfiles repo, not here. Treat the steps above as a description of that repo's behavior, and change them there.
