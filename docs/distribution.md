# Distributing Glissa

Glissa is not published to the npm registry. `package.json` is `"private": true`, and the GitHub repo (`github.com/johncwaters/glissa`) is the only source of truth. The registry versions published before the switch (up to 0.20.0) are deprecated on npmjs.com, so a bare `npm install -g glissa` warns and installs a stale build; the `github:` spec below is the only supported install. The npm-registry runbook that used to live here is archived at `archive/publishing-npm.md`.

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

For a machine that only needs the `glissa` command (npm 12 or newer required):

```bash
npm install -g github:johncwaters/glissa --allow-git=root
```

On an older npm, run it through npm 12 instead: `npx npm@12 install -g github:johncwaters/glissa --allow-git=root`. The floor is hard: npm 11 global installs from git specs land as a link into npm's cache temp clone, which npm then deletes (npm/cli#9406, fixed by pacote 22 which ships in npm 12). The `--allow-git=root` flag is npm 12's opt-in for git dependencies, scoped to the root package. npm 12 skips install scripts by default and warns about it; harmless here, since `prepare` builds `dist/` during packing and node-pty runs from its shipped prebuilds.

npm packs the repo before installing from a GitHub spec, so `package.json`'s `files` whitelist still bounds exactly what lands in the install.

## Releases

A release is a version bump plus a `CHANGELOG.md` entry plus an annotated tag pushed to GitHub (`scripts/release.js`, `npm run release`). Nothing is published anywhere. Update visibility does not wait for a release: the running server's update check compares the commit this install was built from (the hidden npm lockfile's resolved sha, `package.json` `gitHead`, or `git rev-parse HEAD` for a clone) against the tip of `main` (`git ls-remote`, GitHub API fallback), so any merged commit makes clients see an update; the version pair is only the label beside the commit pair. The check is advisory and notify-only, rechecks daily while a dashboard is connected, and persists a 6h throttle in `~/.glissa/update-check.json`.

## What is enforced, and where

Per the repo's docs-must-be-enforceable norm, these claims are pinned by tests rather than by this page:

- The update check (installed-commit resolution, remote-tip sources, advisory-only failure paths, the per-flavor update command, the persisted throttle): `tests/update-check.test.js` and `tests/update-core.test.js`, part of `npm test`.
- The `files` whitelist covering every module the entry points require: `scripts/check-package-files.js`, run as a gate by `npm run release`. It is a script, not a unit test, so it does not run in CI.

The provisioning flow itself (clone path, systemd unit, tailscale serve, apply script) is pinned by `claude-setup`'s own test suite, not by anything in this repo. Treat the steps above as a description of that repo's behavior, and change them there.
