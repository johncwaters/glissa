# Glissa CLI Testing Guide

Test scenarios for Glissa's CLI functionality. Run these before publishing to npm.

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
node bin/glissa.js --help
```

**Expected:**

```
Usage: glissa [options]

Options:
  --port <number>   Override the server port (default: 3000)
  --config <path>   Path to config file (default: ~/.glissa/config.json)
  --version         Show version number
  --help, -h        Show this help message
```

**Exit code:** 0

---

## Test 2: `-h` Short Flag

```powershell
node bin/glissa.js -h
```

**Expected:** Same output as `--help`.

---

## Test 3: `--version` Flag

```powershell
node bin/glissa.js --version
```

**Expected:** `0.1.0` (matches `package.json`)

---

## Test 4: `--port` Override

Start the server on a custom port. Press `Ctrl+C` to stop after verifying.

```powershell
node bin/glissa.js --port 4567
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
node bin/glissa.js --config ./config.json --port 4568
```

**Expected:** Server starts using the specified config, listening on port 4568. `Ctrl+C` to stop.

---

## Test 6: `--config` with Nonexistent Path

```powershell
node bin/glissa.js --config C:\nonexistent\config.json
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
node bin/glissa.js --port 4569
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

Verify `node server.js` still works as before (backward compatibility):

```powershell
node server.js
```

**Expected:** Server starts using `./config.json` from the repo directory. `Ctrl+C` to stop.

---

## Test 9: `npm pack` Verification

```powershell
npm pack --dry-run
```

**Expected files included:**

```
bin/glissa.js
server.js
sessions.js
notify.js
patterns.js
public/index.html
public/app.js
public/style.css
package.json
```

**Verify no unwanted files** — `config.json`, `spike/`, `.omc/`, `.claude/`, `docs/` should NOT appear.

---

## Test 10: `package.json` Fields

```powershell
node -e "const p=require('./package.json'); console.log(JSON.stringify({bin:p.bin,files:p.files,engines:p.engines},null,2))"
```

**Expected:**

```json
{
  "bin": {
    "glissa": "bin/glissa.js"
  },
  "files": [
    "bin/",
    "public/",
    "server.js",
    "sessions.js",
    "notify.js",
    "patterns.js"
  ],
  "engines": {
    "node": ">=18"
  }
}
```

---

## Testing as Global Install (npm link)

Simulate a global install:

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

Check `sessions.js` lines 204-208:

```javascript
delete env.CLAUDECODE;
delete env.CLAUDE_CODE_SSE_PORT;
delete env.CLAUDE_CODE_ENTRYPOINT;
delete env.GLISSA_PORT;
delete env.GLISSA_CONFIG;
```

This is a code-level verification — the env vars are deleted before `pty.spawn()`.

---

## Full Checklist

| # | Test | Pass? |
|---|------|-------|
| 1 | `--help` prints usage, exits 0 | |
| 2 | `-h` works as short flag | |
| 3 | `--version` prints 0.1.0 | |
| 4 | `--port 4567` starts on custom port | |
| 5 | `--config ./config.json` uses explicit config | |
| 6 | `--config <nonexistent>` errors with exit 1 | |
| 7 | Auto-seeds `~/.glissa/config.json` when none exist | |
| 8 | `node server.js` still works (backward compat) | |
| 9 | `npm pack --dry-run` includes correct files | |
| 10 | `package.json` has bin, files, engines | |
| 11 | `npm link` + `glissa --help` works globally | |
| 12 | `npm unlink -g glissa` cleans up | |

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
node bin/glissa.js --help
```
