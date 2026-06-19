'use strict';

// Pure helpers shared by the post-install PATH notice (scripts/postinstall-path-check.js)
// and `glissa doctor` (bin/glissa.js). They require only node:path, so they load
// even when the server or the node-pty native module cannot.
//
// Why this exists: the npm `bin` field already makes npm create a `glissa` shim,
// but a package cannot (and must not) silently rewrite the user's PATH. When the
// global-bin directory is not on PATH, `glissa` is "not recognized". These
// functions locate that directory and report whether it is reachable so we can
// TELL the user the one-step fix.

const path = require('node:path');

function isWin(platform) {
  return platform === 'win32';
}

// Normalize one PATH entry for comparison: trim, drop surrounding quotes, strip a
// trailing separator, and lowercase on Windows (its filesystem is case-insensitive).
function normalizeDir(dir, platform) {
  if (!dir) return '';
  let d = String(dir).trim();
  if (d.length >= 2 && d.startsWith('"') && d.endsWith('"')) {
    d = d.slice(1, -1);
  }
  d = d.replace(/[\\/]+$/, '');
  if (d === '') return '';
  return isWin(platform) ? d.toLowerCase() : d;
}

// Is `dir` present in the PATH string? Splits on ';' on Windows and ':' elsewhere,
// then compares normalized entries. Never throws on missing/empty inputs.
function onPath(dir, { pathEnv, platform } = {}) {
  const target = normalizeDir(dir, platform);
  if (!target) return false;
  const sep = isWin(platform) ? ';' : ':';
  for (const entry of String(pathEnv || '').split(sep)) {
    if (normalizeDir(entry, platform) === target) return true;
  }
  return false;
}

// Where npm places global command shims. On Windows the global PREFIX directory
// itself holds the .cmd/.ps1/.exe shims (there is no bin/ subdir); on POSIX it is
// <prefix>/bin. Falls back to the official-installer default on Windows.
function npmGlobalBinDir({ env = {}, platform, homedir } = {}) {
  const prefix = env.npm_config_prefix || null;
  if (isWin(platform)) {
    if (prefix) return prefix;
    if (homedir) return path.join(homedir, 'AppData', 'Roaming', 'npm');
    return null;
  }
  if (prefix) return path.join(prefix, 'bin');
  return null;
}

// Best-effort pnpm global-bin directory. pnpm requires `pnpm setup` to put this on
// PATH, so it is a common "command not found" culprit for pnpm users.
function pnpmGlobalBinDir({ env = {}, platform, homedir } = {}) {
  if (env.PNPM_HOME) return env.PNPM_HOME;
  if (!homedir) return null;
  if (isWin(platform)) return path.join(homedir, 'AppData', 'Local', 'pnpm');
  return path.join(homedir, '.local', 'share', 'pnpm');
}

// Human-readable notice. Pure string (no I/O) so it is unit-testable. Uses the safe
// registry-preserving PowerShell idiom on Windows (NOT `setx`, which truncates PATH
// at 1024 chars and writes the expanded value).
function formatPathNotice({ installedBinDir, onPathFlag, platform } = {}) {
  const dir = installedBinDir || '(unknown)';
  if (onPathFlag) {
    return [
      'glissa installed. Its command directory is on your PATH:',
      `  ${dir}`,
      'Run "glissa" to start, or "glissa doctor" to check your setup.',
    ].join('\n');
  }
  const lines = [
    'glissa was installed, but its command directory is NOT on your PATH:',
    `  ${dir}`,
    'That is why typing "glissa" is not recognized yet. To fix it:',
  ];
  if (isWin(platform)) {
    lines.push('  In PowerShell (adds it to your user PATH, permanent):');
    lines.push(`    [Environment]::SetEnvironmentVariable("PATH", [Environment]::GetEnvironmentVariable("PATH","User") + ";${dir}", "User")`);
    lines.push('  Then open a NEW terminal and run "glissa".');
    lines.push('  (Reinstalling Node.js from the official installer also adds this directory for you.)');
  }
  if (!isWin(platform)) {
    lines.push(`  Add to your shell profile:  export PATH="$PATH:${dir}"`);
    lines.push('  Then open a new terminal and run "glissa".');
  }
  lines.push('See the README "Troubleshooting" section for more, including pnpm setups.');
  return lines.join('\n');
}

module.exports = {
  onPath,
  npmGlobalBinDir,
  pnpmGlobalBinDir,
  formatPathNotice,
};
