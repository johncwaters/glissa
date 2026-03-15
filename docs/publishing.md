# Publishing Glissa to npm

Step-by-step guide to publish Glissa as a public npm package. This guide is Windows 11 / PowerShell focused.

---

## Pre-Publish Checklist

Before publishing, verify:

```powershell
# 1. Check version in package.json
node -e "console.log('Version:', require('./package.json').version)"

# 2. Verify CLI works
node bin/glissa.js --help
node bin/glissa.js --version

# 3. Test npm pack (dry run — doesn't publish, just shows what will be included)
npm pack --dry-run

# 4. Verify no secrets in published files
# Check that config.json, .env, spike/, .claude/, .omc/ are NOT in "files" array
node -e "console.log(JSON.stringify(require('./package.json').files, null, 2))"

# 5. Ensure git is clean (no uncommitted changes in published files)
git status
```

Expected files in `npm pack` output:
- `bin/glissa.js`
- `server.js`
- `sessions.js`
- `notify.js`
- `patterns.js`
- `public/index.html`
- `public/app.js`
- `public/style.css`
- `package.json`

**Do NOT include:** `config.json`, `spike/`, `.omc/`, `.claude/`, `docs/`, `node_modules/`

---

## npm Account Setup

### 1. Create Account (if new)

Go to https://www.npmjs.com/signup and create an account. You'll need:
- Email address
- Username (used later for scoped packages if needed)
- Password

### 2. Log In Locally

```powershell
npm login
```

Prompts for username, password, and email verification code. You'll receive a code via email.

### 3. Verify Login

```powershell
npm whoami
```

Should print your npm username.

---

## Check npm Name Availability

Before publishing, verify the name "glissa" is available:

```powershell
npm view glissa
```

**If available:** Shows "404 — not found" (good, you can use it)

**If taken:** Shows package details. Then choose:
1. **Use a scoped package:** `@username/glissa` (e.g., `@jcwaters/glissa`)
2. **Pick a different name:** Update `name` in `package.json`

### Updating package.json for Scoped Package

If using a scoped package, update `package.json`:

```json
{
  "name": "@username/glissa",
  "version": "0.1.0",
  ...
}
```

Then update install instructions in README:

```powershell
# Instead of:
npm install -g glissa

# Use:
npm install -g @username/glissa

# CLI command remains the same:
glissa --help
```

---

## First Publish

Once you've verified the name and logged in:

```powershell
npm publish
```

**For public scoped packages, add `--access public`:**

```powershell
npm publish --access public
```

Expected output:

```
npm info it worked if it ends with ok
npm info version 0.1.0
npm info + glissa@0.1.0
npm info published to https://www.npmjs.com/package/glissa
```

### What Happens

- Your code is uploaded to npm's registry
- Publicly visible at https://www.npmjs.com/package/glissa
- Installable globally: `npm install -g glissa`
- Installable locally: `npm install glissa`

---

## Post-Publish Verification

Verify the package is live and works:

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

Check the npm page in a browser:
- https://www.npmjs.com/package/glissa (or `@username/glissa`)
- Verify version, description, homepage link

---

## Bumping Versions for Subsequent Releases

After publishing, future releases use semantic versioning (semver):

- **Patch** (0.1.0 → 0.1.1): Bug fixes, no breaking changes
- **Minor** (0.1.0 → 0.2.0): New features, backward compatible
- **Major** (0.1.0 → 1.0.0): Breaking changes

### Bump Version

```powershell
# Patch (bug fix)
npm version patch

# Minor (new feature)
npm version minor

# Major (breaking change)
npm version major
```

This:
- Updates `package.json` version
- Creates a git commit
- Creates a git tag

Then publish:

```powershell
npm publish
```

Example workflow:

```powershell
# You fixed a bug
npm version patch          # 0.1.0 → 0.1.1
npm publish               # Published as 0.1.1
git push origin main
git push origin --tags
```

---

## node-pty Native Dependencies

Glissa depends on `node-pty`, which compiles C++ code. Here's what users need:

### Windows & macOS

**Good news:** Pre-built binaries are included for:
- Windows x64, arm64
- macOS x64, arm64

Users can install without build tools:

```powershell
npm install -g glissa
```

### Linux

**Requires:** `build-essential` and `python3`

Users should run:

```bash
sudo apt-get install build-essential python3
npm install -g glissa
```

### Document This

Add to your **README.md** or npm package description:

```markdown
## Installation

```bash
npm install -g glissa
```

### Linux Users

If you see a compilation error:

```bash
sudo apt-get install build-essential python3
npm install -g glissa
```

Pre-built binaries are available for Windows and macOS.
```

---

## Unpublishing & Deprecation

### Unpublish (Within 72 Hours)

If you need to remove a version immediately after publishing:

```powershell
npm unpublish glissa@0.1.0
```

Restrictions:
- Only works within **72 hours** of publish
- After 72 hours, use deprecation instead
- Removes from npm registry

### Deprecate (Anytime)

Mark a version as deprecated (users see a warning, but can still install):

```powershell
npm deprecate glissa@0.1.0 "Use 0.1.1 instead, which fixes XYZ"
```

Deprecate entire package (rare):

```powershell
npm deprecate glissa "This package is deprecated. Use @newname/glissa instead."
```

---

## Troubleshooting

### 403 Forbidden

```
npm ERR! 403 Forbidden - PUT https://registry.npmjs.org/glissa
```

**Cause:** Not logged in, or name already taken.

**Fix:**
```powershell
npm whoami                # Verify logged in
npm view glissa           # Check if name is taken
npm login                 # Re-login if needed
```

### ENOENT: Config File

```
npm ERR! ENOENT: no such file or directory, open '...\package.json'
```

**Cause:** Running from wrong directory.

**Fix:**
```powershell
cd C:\Users\john.c.waters\source\repos\glissa
npm publish
```

### Port Already in Use (Post-Install Test)

```powershell
# Kill process on port 3000
netstat -ano | findstr :3000
taskkill /PID <pid> /F

# Then run glissa again
glissa --port 3001
```

### node-pty Build Fails on Linux

```
gyp ERR! build error
gyp ERR! stack Error: 'python3' not found
```

**Fix:**
```bash
sudo apt-get install build-essential python3
npm install -g glissa
```

---

## Checklist for Publishing

- [ ] `npm whoami` — logged into npm account
- [ ] `npm view glissa` — name is available (or decided on scoped package)
- [ ] `npm pack --dry-run` — correct files included, no secrets
- [ ] `git status` — repo is clean or changes committed
- [ ] `node bin/glissa.js --help` — CLI works locally
- [ ] `npm publish` — published successfully
- [ ] Fresh PowerShell window: `npm install -g glissa` — installs from npm
- [ ] `glissa --help` — works from new install
- [ ] https://www.npmjs.com/package/glissa — page exists and is public
- [ ] git tags pushed: `git push origin --tags`

---

## Reference

- **npm CLI docs:** https://docs.npmjs.com/cli/publish
- **semver guide:** https://semver.org/
- **npm scoped packages:** https://docs.npmjs.com/cli/v8/using-npm/scope
- **node-pty native builds:** https://github.com/microsoft/node-pty/releases
