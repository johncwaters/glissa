# Publishing Glissa to npm

Glissa releases through `scripts/release.js` (`npm run release`). It automates the whole flow: npm auth check, clean-tree check, tag-exists check, package-files check, build, publish, git push, tag, and an optional GitHub release. Use it for every release; the manual walkthrough in the appendix below is a fallback for when the script cannot run (no npm auth on the box, a partial failure needs finishing by hand, or a one-off task like unpublishing).

The `/release` skill wraps this script with preflight gates and evidence collection; see `.claude/release-profile.yml` for the profile it derived from this repo.

---

## Primary path: `npm run release`

### Before running it

- Bump the version in `package.json` (the tag is derived from it: `v<version>`).
- Move the relevant `CHANGELOG.md` entries out of `[Unreleased]` into a `## [<version>] - <date>` section; the script extracts that section verbatim for the GitHub release notes.
- Commit and make sure the working tree is clean (`git status --porcelain` must be empty; the script checks this and exits if not).
- Be logged in to npm (`npm whoami`). An automation token (`npm token create --type=automation`) avoids the OTP prompt in a non-interactive shell.

### What it does

```powershell
npm run release
```

In order:

1. Verifies `npm whoami` succeeds.
2. Verifies the working tree is clean.
3. Verifies the release tag (`v<version>`) does not already exist.
4. Runs `node scripts/check-package-files.js`, which traces every local `require()` from the `bin`/`main` entry points and fails if any required file is missing from `package.json`'s `files` array.
5. Runs `npm run build` (Vite) and checks `dist/index.html` exists.
6. Publishes with `npm publish --ignore-scripts` (scripts are skipped here since the build already ran).
7. Pushes commits: `git push`.
8. Creates and pushes the tag: `git tag v<version>` then `git push origin v<version>`.
9. If the `gh` CLI is installed, creates a GitHub release from the matching `CHANGELOG.md` section; otherwise prints the manual release URL.

The script is not atomic. If it fails partway through, check what actually landed (npm registry, git tag, GitHub release) before re-running any step by hand; do not blindly re-run the whole script.

### After running it

Verify the release actually shipped:

```powershell
npm view glissa version
gh release view v<version>
```

The release profile also expects `main` to be fast-forwarded from `develop` after each release (Glissa releases from `develop`; `main` otherwise drifts behind).

---

## Appendix: manual publish walkthrough

Use this only when `npm run release` cannot run. It duplicates the same npm-facing steps by hand; `scripts/release.js` supersedes every step here, including the version bump. Glissa releases from `develop`, not `main`.

### Pre-Publish Checklist

```powershell
# 1. Check version in package.json
node -e "console.log('Version:', require('./package.json').version)"

# 2. Verify CLI works
node bin/glissa.js --help
node bin/glissa.js --version

# 3. Test npm pack (dry run, does not publish, just shows what will be included)
npm pack --dry-run

# 4. Verify no secrets in published files
# Check that config.json, .env, spike/, .claude/, .omc/ are NOT in "files" array
node -e "console.log(JSON.stringify(require('./package.json').files, null, 2))"

# 5. Ensure git is clean (no uncommitted changes in published files)
git status
```

See `docs/testing-cli.md` for the expected `npm pack` file list; it should match `package.json`'s `files` array (currently `bin/`, `dist/`, `server.js`, `server/`, `session/`, `notifications/`, `detection/`, a selected subset of `teamlib/`, `teams/`, and a selected subset of `shared/`).

**Do NOT include:** `config.json`, `spike/`, `.omc/`, `.claude/`, `docs/`, `node_modules/`

### npm Account Setup

#### 1. Create Account (if new)

Go to https://www.npmjs.com/signup and create an account. You will need:
- Email address
- Username (used later for scoped packages if needed)
- Password

#### 2. Log In Locally

```powershell
npm login
```

Prompts for username, password, and email verification code. You will receive a code via email.

#### 3. Verify Login

```powershell
npm whoami
```

Should print your npm username.

### First Publish (only if the package has never been published under this name)

```powershell
npm publish
```

Expected output:

```
npm info it worked if it ends with ok
npm info version <version>
npm info + glissa@<version>
npm info published to https://www.npmjs.com/package/glissa
```

### Post-Publish Verification

```powershell
# Open a new PowerShell window (clean environment)

# Install from npm (not your local copy)
npm install -g glissa

# Test it
glissa --help
glissa --version
glissa --port 3001
# Ctrl+C to stop
```

**Expected output:** Same as running `node bin/glissa.js --help` locally.

Check the npm page in a browser: https://www.npmjs.com/package/glissa. Verify version, description, homepage link.

### Manual Version Bump

Future releases use semantic versioning (semver):

- **Patch** (0.1.0 to 0.1.1): Bug fixes, no breaking changes
- **Minor** (0.1.0 to 0.2.0): New features, backward compatible
- **Major** (0.1.0 to 1.0.0): Breaking changes

```powershell
npm version patch    # or minor / major
npm publish
git push origin develop
git push origin --tags
```

`npm version <bump>` updates `package.json`, creates a git commit, and creates a git tag; `npm run release` folds all of this into one gated step, so prefer it over this manual sequence.

### node-pty Native Dependencies

Glissa depends on `node-pty`, which compiles C++ code. Glissa itself is Windows-only: `package.json`'s `os` field is `["win32"]`, so `npm install` refuses on any other platform. macOS and Linux are untested and unsupported; there is no pre-built or source install path for them.

### Unpublishing and Deprecation

#### Unpublish (within 72 hours)

```powershell
npm unpublish glissa@<version>
```

Only works within 72 hours of publish; after that, use deprecation instead. This removes the version from the npm registry entirely.

#### Deprecate (anytime)

```powershell
npm deprecate glissa@<version> "Use <newer-version> instead, which fixes XYZ"
```

The release profile's rollback plan prefers deprecation plus a forward-fix patch over unpublishing, retagging, or reusing a version number.

### Troubleshooting

#### 403 Forbidden

```
npm ERR! 403 Forbidden - PUT https://registry.npmjs.org/glissa
```

Cause: not logged in, or name already taken.

```powershell
npm whoami                # Verify logged in
npm view glissa           # Check if name is taken
npm login                 # Re-login if needed
```

#### ENOENT: Config File

```
npm ERR! ENOENT: no such file or directory, open '...\package.json'
```

Cause: running from the wrong directory. `cd` into the repo root and retry.

#### Port Already in Use (Post-Install Test)

```powershell
netstat -ano | findstr :3000
taskkill /PID <pid> /F
glissa --port 3001
```

#### node-pty Build Fails on Linux

```
gyp ERR! build error
gyp ERR! stack Error: 'python3' not found
```

```bash
sudo apt-get install build-essential python3
npm install -g glissa
```

### Manual Checklist

- [ ] `npm whoami`, logged into npm account
- [ ] `npm view glissa`, name is available (or a scoped package is used)
- [ ] `npm pack --dry-run`, correct files included, no secrets
- [ ] `git status`, repo is clean or changes committed
- [ ] `node bin/glissa.js --help`, CLI works locally
- [ ] `npm publish`, published successfully
- [ ] Fresh PowerShell window: `npm install -g glissa`, installs from npm
- [ ] `glissa --help`, works from new install
- [ ] https://www.npmjs.com/package/glissa, page exists and is public
- [ ] git tags pushed: `git push origin --tags`

### Reference

- **npm CLI docs:** https://docs.npmjs.com/cli/publish
- **semver guide:** https://semver.org/
- **npm scoped packages:** https://docs.npmjs.com/cli/v8/using-npm/scope
- **node-pty native builds:** https://github.com/microsoft/node-pty/releases
