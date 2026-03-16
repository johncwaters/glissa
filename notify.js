'use strict';

const { execFile, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

let burntToastModulePath = null; // null = unknown, false = not found, string = resolved path
let _suppressed = false;
const _recentCategories = new Map(); // category -> lastFireTimestamp

function escapeForPowerShell(str) {
  return String(str).replace(/'/g, "''");
}

function findBurntToastViaPowerShell() {
  try {
    const result = execFileSync('powershell', [
      '-NoProfile', '-Command',
      '(Get-Module -ListAvailable BurntToast | Select-Object -First 1).ModuleBase'
    ], { encoding: 'utf8', timeout: 5000 }).trim();
    if (result && fs.statSync(result).isDirectory()) return result;
  } catch {
    // PowerShell unavailable or module not found
  }
  return null;
}

function findBurntToastByPath() {
  const home = process.env.USERPROFILE || process.env.HOME;
  const candidates = [
    path.join(home, 'Documents', 'PowerShell', 'Modules', 'BurntToast'),
    path.join(home, 'Documents', 'WindowsPowerShell', 'Modules', 'BurntToast'),
    ...(process.env.OneDrive
      ? [
          path.join(process.env.OneDrive, 'Documents', 'PowerShell', 'Modules', 'BurntToast'),
          path.join(process.env.OneDrive, 'Documents', 'WindowsPowerShell', 'Modules', 'BurntToast'),
        ]
      : []),
    ...(process.env.OneDriveCommercial
      ? [
          path.join(process.env.OneDriveCommercial, 'Documents', 'PowerShell', 'Modules', 'BurntToast'),
          path.join(process.env.OneDriveCommercial, 'Documents', 'WindowsPowerShell', 'Modules', 'BurntToast'),
        ]
      : []),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', 'Modules', 'BurntToast'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'WindowsPowerShell', 'Modules', 'BurntToast'),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // not found, try next
    }
  }
  return null;
}

function findBurntToastModule() {
  return findBurntToastViaPowerShell() || findBurntToastByPath();
}

function notifyWithBurntToast(title, message) {
  const t = escapeForPowerShell(title);
  const m = escapeForPowerShell(message);
  const modulePath = escapeForPowerShell(burntToastModulePath);
  const script = `Import-Module '${modulePath}'; New-BurntToastNotification -Text '${t}', '${m}'`;
  execFile('powershell', ['-NoProfile', '-Command', script], (err) => {
    if (err) {
      console.warn('[notify] BurntToast notification failed:', err.message);
    }
  });
}

function notifyWithMsg(title, message) {
  const text = `${title}: ${message}`;
  execFile('msg', ['*', text], (err) => {
    if (err) {
      console.warn('[notify] msg fallback notification failed:', err.message);
    }
  });
}

function setNotifySuppressed(val) {
  _suppressed = !!val;
}

function notify(title, message, { category = null } = {}) {
  if (_suppressed) return;

  // Category-based debounce: suppress duplicate category within the debounce window
  if (category) {
    const now = Date.now();
    const lastFired = _recentCategories.get(category);
    const debounceMs = _getDebounceMs();
    if (lastFired && (now - lastFired) < debounceMs) {
      console.log(`[notify] Suppressed (category '${category}' debounced): ${message}`);
      return;
    }
    _recentCategories.set(category, now);
  }

  // First call — detect BurntToast module path
  if (burntToastModulePath === null) {
    const found = findBurntToastModule();
    if (found) {
      burntToastModulePath = found;
      console.log(`[notify] BurntToast found at ${found}`);
    } else {
      burntToastModulePath = false;
      console.warn('[notify] BurntToast not found, using msg fallback');
    }
  }

  if (burntToastModulePath) {
    notifyWithBurntToast(title, message);
  } else {
    notifyWithMsg(title, message);
  }
}

function _getDebounceMs() {
  try {
    return require('./config.json').notifyDebounceMs || 3000;
  } catch {
    return 3000;
  }
}

function clearNotifyHistory() {
  _recentCategories.clear();
}

module.exports = { notify, setNotifySuppressed, clearNotifyHistory };
