'use strict';

// 8.3 short-path fixtures. A GitHub Actions windows-latest runner has %TEMP% =
// C:\Users\RUNNER~1\AppData\Local\Temp, so every os.tmpdir()-derived path in the suite is a SHORT
// path while git porcelain and libuv both report the long form of the same directory. Reproducing
// that locally needs a real 8.3 alias, which only the filesystem can mint.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WIN = process.platform === 'win32';

// The 8.3 alias of an existing path, or null when the volume has short-name generation disabled
// (`fsutil 8dot3name query C:`), in which case there is no second spelling to test against.
// windowsVerbatimArguments keeps our own quotes intact: without it Node re-quotes the argument and
// `for` receives a mangled path.
function shortPathOf(target) {
  if (!WIN) return null;
  try {
    const out = execFileSync('cmd', [`/d /c for %I in ("${target}") do @echo %~sI`], {
      encoding: 'utf8',
      windowsVerbatimArguments: true,
    }).trim();
    if (!out || out.toLowerCase() === String(target).toLowerCase()) return null;
    return out;
  } catch {
    return null;
  }
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-shortpath-longname-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Whether this volume mints 8.3 aliases at all, probed once against a real directory.
const SHORT_NAMES_AVAILABLE = withTempDir((dir) => shortPathOf(dir) !== null);

module.exports = { SHORT_NAMES_AVAILABLE, shortPathOf, withTempDir };
