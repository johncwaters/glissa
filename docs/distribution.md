# Distributing Glissa

Glissa is not published to the npm registry. `package.json` is `"private": true`, and the GitHub repo (`github.com/johncwaters/glissa`) is the only source of truth. The npm-registry runbook that used to live here is archived at `archive/publishing-npm.md`.

## Server machines

Provisioning and updating are owned by the `claude-setup` repo (`github:johncwaters/claude-setup`). Its server profile:

1. Clones `https://github.com/johncwaters/glissa.git` to `~/Projects/glissa`.
2. Runs `npm ci` then `npm run build`.
3. Installs a systemd user unit (`glissa.service`, `ExecStart` = `node server.js`, `Restart=on-failure`) and enables linger so it survives logout.
4. Fronts the remote listener with `tailscale serve`.

To update a server, re-run the `claude-setup` apply script; it does `git pull --ff-only`, `npm ci`, `npm run build`, and restarts the service. By hand, the same sequence is:

```bash
cd ~/Projects/glissa
git pull --ff-only && npm ci && npm run build
systemctl --user restart glissa
```

## Standalone CLI

For a machine that only needs the `glissa` command:

```bash
npm install -g github:johncwaters/glissa
```

npm packs the repo before installing from a GitHub spec, so `package.json`'s `files` whitelist still bounds exactly what lands in the install.

## Releases

A release is a version bump plus a `CHANGELOG.md` entry plus an annotated tag pushed to GitHub (`scripts/release.js`, `npm run release`). Nothing is published anywhere. The running server's startup check reads `package.json` from the `main` branch on `raw.githubusercontent.com`, so a merged bump is what makes clients see a new version.

## What is enforced, and where

Per the repo's docs-must-be-enforceable norm, these claims are pinned by tests rather than by this page:

- The startup update check (GitHub source, advisory-only failure paths, the update command it prints): `tests/update-check.test.js`, part of `npm test`.
- The `files` whitelist covering every module the entry points require: `scripts/check-package-files.js`, run as a gate by `npm run release`. It is a script, not a unit test, so it does not run in CI.

The provisioning flow itself (clone path, systemd unit, tailscale serve, apply script) is pinned by `claude-setup`'s own test suite, not by anything in this repo. Treat the steps above as a description of that repo's behavior, and change them there.
