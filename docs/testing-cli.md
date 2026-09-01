# Glissa CLI Testing Guide

Test scenarios for Glissa's CLI functionality. Run these before cutting a release, since the startup update check keys on the `vX.Y.Z` release tag. See `distribution.md` for the shipping model.

## Prerequisites

- **Node.js** v18+ (`node --version`)
- **npm** v8+
- Repository cloned, dependencies installed (`npm install`)
- Windows 11 (PowerShell commands below; bash alternatives noted where relevant)

## Configuration Resolution Order

1. `--config <path>` flag (highest priority)
2. `~/.glissa/config.json` (user home)
3. `./config.json` in the app directory (local dev fallback)
4. If none exist, seeds `~/.glissa/config.json` with defaults

---

## Test 1: `--help` Flag

```powershell
node bin/glissa.ts --help
```

**Expected:**

```
Usage: glissa [command] [options]

Commands:
  doctor            Diagnose install / PATH issues and exit
  pair              Mint a single-use pairing link for a remote device
  pair --list       List paired devices
  pair --revoke <id>  Revoke a paired device

Options:
  --name <label>    Label for the device being paired (with: pair)
  --port <number>   Override the server port (default: 3000)
  --config <path>   Path to config file (default: ~/.glissa/config.json)
  --version         Show version number
  --help, -h        Show this help message
```

**Exit code:** 0

---

## Test 2: `-h` Short Flag

```powershell
node bin/glissa.ts -h
```

**Expected:** Same output as `--help`.

---

## Test 3: `--version` Flag

```powershell
node bin/glissa.ts --version
```

**Expected:** matches the `version` field in `package.json`

---

## Test 4: `--port` Override

Start the server on a custom port. Press `Ctrl+C` to stop after verifying.

```powershell
node bin/glissa.ts --port 4567
```

**Expected output includes:**

```
Glissa server listening on http://localhost:4567
```

Open `http://localhost:4567` in a browser to verify the dashboard loads. Then `Ctrl+C` to stop.

---

## Test 5: `--config` with Explicit Path

Use the repo's local config explicitly:

```powershell
node bin/glissa.ts --config ./config.json --port 4568
```

**Expected:** Server starts using the specified config, listening on port 4568. `Ctrl+C` to stop.

---

## Test 6: `--config` with Nonexistent Path

```powershell
node bin/glissa.ts --config C:\nonexistent\config.json
```

**Expected:**

```
Config file not found: C:\nonexistent\config.json
```

**Exit code:** 1

---

## Test 7: Default Config Auto-Seeding

Remove the home config (back it up first if you have one):

```powershell
# Backup if exists
if (Test-Path "$env:USERPROFILE\.glissa\config.json") {
    Copy-Item "$env:USERPROFILE\.glissa\config.json" "$env:USERPROFILE\.glissa\config.json.bak"
}

# Remove it
Remove-Item "$env:USERPROFILE\.glissa\config.json" -ErrorAction SilentlyContinue
```

Run glissa (no flags). Since local `./config.json` exists in the repo, it will use the local fallback. To truly test seeding, temporarily rename the local config too:

```powershell
Rename-Item config.json config.json.bak
node bin/glissa.ts --port 4569
```

**Expected output includes:**

```
Created default config at C:\Users\<you>\.glissa\config.json
Glissa server listening on http://localhost:4569
```

**Verify the seeded config:**

```powershell
Get-Content "$env:USERPROFILE\.glissa\config.json"
```

Should contain valid JSON with `port`, `projects`, `repoRoots`, and timeout fields.

**Restore:**

```powershell
# Ctrl+C to stop the server first
Rename-Item config.json.bak config.json

# Restore backup if you had one
if (Test-Path "$env:USERPROFILE\.glissa\config.json.bak") {
    Move-Item "$env:USERPROFILE\.glissa\config.json.bak" "$env:USERPROFILE\.glissa\config.json" -Force
}
```

---

## Test 8: Local Dev Fallback

Verify `node server/main.ts` still works as before (backward compatibility):

```powershell
node server/main.ts
```

**Expected:** Server starts using `./config.json` from the repo directory. `Ctrl+C` to stop.

---

## Test 9: `glissa doctor`

```powershell
node bin/glissa.ts doctor
```

**Expected:** A read-only report, no server started and nothing written to disk: glissa/node/platform versions, where the CLI is running from, the npm (and pnpm, if present) global bin directory and whether each is on PATH, a `node-pty` load probe, and the resolved config path. When the npm global bin directory is not on PATH, it also prints the one-step fix.

**Exit code:** 0

---

## Test 10: `glissa pair`

Use a temporary config so the test does not modify your normal pairing store. Start Glissa in one PowerShell window:

```powershell
$pairDir = Join-Path $env:TEMP "glissa-pair-cli-test"
New-Item -ItemType Directory -Force $pairDir | Out-Null
$pairConfig = Join-Path $pairDir "config.json"
@'
{
  "port": 3000,
  "remote": {
    "enabled": true,
    "port": 3456
  },
  "projects": []
}
'@ | Set-Content -Encoding UTF8 $pairConfig

node bin/glissa.ts --config $pairConfig --port 3455
```

In a second PowerShell window, mint and redeem a pairing link:

```powershell
$pairConfig = Join-Path (Join-Path $env:TEMP "glissa-pair-cli-test") "config.json"
$mintOutput = node bin/glissa.ts --config $pairConfig pair --name Phone
$mintOutput
$pairUrl = ($mintOutput | Select-String "http://127.0.0.1:3456/pair/").Matches.Value
Invoke-WebRequest $pairUrl -SessionVariable pairedSession | Out-Null
```

**Expected mint output includes:** `http://127.0.0.1:3456/pair/` and `Treat this link like a password.`

List the paired device:

```powershell
node bin/glissa.ts --config $pairConfig pair --list
```

**Expected output includes:** a table with `ID`, `NAME`, `PAIRED`, `LAST SEEN`, `STATUS`, and a row whose `NAME` is `Phone`.

Revoke it, replacing `<id>` with the `ID` from the list output:

```powershell
node bin/glissa.ts --config $pairConfig pair --revoke <id>
node bin/glissa.ts --config $pairConfig pair --list
```

**Expected output includes:** `Revoked <id>. A running Glissa applies this within 30 seconds, no restart needed.` and the same device row with `revoked` in the `STATUS` column.

**Exit code:** 0 for mint, list, and revoke.

Stop the server from the first PowerShell window with `Ctrl+C`.

---

## Test 11: `npm pack` Verification

Installing from the GitHub spec packs the repo first, so this list is exactly what lands in a global install.

```powershell
npm pack --dry-run
```

**Expected files included** (per the `files` array in `package.json`):

```
bin/glissa.ts
bin/path-doctor.ts
scripts/prepare-build.js
scripts/postinstall-path-check.js
dist/            (built frontend, excludes dist/AGENTS.md and dist/pictures/)
server/
session/
notifications/
detection/
shared/states.js
shared/client-trust.js
shared/client-trust.esm.mjs
shared/notification-states.js
shared/paths.js
package.json
```

**Verify no unwanted files**: `config.json`, `spike/`, `.omc/`, `.claude/`, `docs/`, `node_modules/` should NOT appear.

---

## Test 12: `package.json` Fields

```powershell
node -e "const p=require('./package.json'); console.log(JSON.stringify({bin:p.bin,files:p.files,engines:p.engines},null,2))"
```

**Expected:** `bin.glissa` points at `bin/glissa.ts`, `engines.node` is `>=22.18.0`, and `files` matches the array above (check `package.json` directly for the current list; it grows as new server-side modules ship).

---

## Testing as Global Install (npm link)

Simulate the `npm install -g github:johncwaters/glissa` result without a network round trip:

```powershell
npm link
```

Then test:

```powershell
glissa --help
glissa --version
glissa --port 4570
# Ctrl+C to stop
```

**Cleanup:**

```powershell
npm unlink -g glissa
```

---

## Environment Variable Isolation

Verify `GLISSA_PORT` and `GLISSA_CONFIG` don't leak to child Claude processes.

Check the pure scrub in `session/core/spawn-env.ts` (`buildAgentEnv`, applied with the Claude Code adapter's `envProfile`), which unsets, at minimum:

```javascript
CLAUDECODE
CLAUDE_CODE_SSE_PORT
CLAUDE_CODE_ENTRYPOINT
GLISSA_PORT
GLISSA_CONFIG
```

This is a code-level verification: `buildAgentEnv` returns a scrubbed copy of the environment before `pty.spawn()`, so the same check works standalone (`session/core/spawn-env.ts` has no IO and no dependency on the rest of the session module).

---

## Full Checklist

| # | Test | Pass? |
|---|------|-------|
| 1 | `--help` prints usage, exits 0 | |
| 2 | `-h` works as short flag | |
| 3 | `--version` prints the package.json version | |
| 4 | `--port 4567` starts on custom port | |
| 5 | `--config ./config.json` uses explicit config | |
| 6 | `--config <nonexistent>` errors with exit 1 | |
| 7 | Auto-seeds `~/.glissa/config.json` when none exist | |
| 8 | `node server/main.ts` still works (backward compat) | |
| 9 | `glissa doctor` prints a read-only report, exits 0 | |
| 10 | `glissa pair` can mint, list, and revoke a device | |
| 11 | `npm pack --dry-run` includes correct files | |
| 12 | `package.json` has bin, files, engines | |
| 13 | `npm link` + `glissa --help` works globally | |
| 14 | `npm unlink -g glissa` cleans up | |

---

## Troubleshooting

### Port Already in Use

```powershell
# Find and kill process on port 3000
netstat -ano | findstr :3000
taskkill /PID <pid> /F
```

### Config File Corruption

Delete and let it re-seed:

```powershell
Remove-Item "$env:USERPROFILE\.glissa\config.json"
node bin/glissa.ts --help
```
