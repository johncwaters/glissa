'use strict';

const { execFile, execFileSync } = require('../child-process-safe');
const path = require('path');
const fs = require('fs');

let burntToastModulePath = null; // null = unknown, false = not found, string = resolved path

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

/**
 * Create a toast channel adapter for NotificationManager.
 * Dumb delivery pipe - no debounce, no suppression logic.
 * @returns {(sessionName: string, category: string, message: string, context: object) => void}
 */
function createToastChannel() {
  return function toastChannel(_sessionName, _category, message, _context) {
    // Lazy BurntToast discovery on first call
    if (burntToastModulePath === null) {
      const found = findBurntToastModule();
      if (found) {
        burntToastModulePath = found;
        console.log(`[channel:toast] BurntToast found at ${found}`);
      } else {
        burntToastModulePath = false;
        console.warn('[channel:toast] BurntToast not found, using msg fallback');
      }
    }

    const title = 'Glissa';
    if (burntToastModulePath) {
      const t = escapeForPowerShell(title);
      const m = escapeForPowerShell(message);
      const modulePath = escapeForPowerShell(burntToastModulePath);
      const script = `Import-Module '${modulePath}'; New-BurntToastNotification -Text '${t}', '${m}'`;
      execFile('powershell', ['-NoProfile', '-Command', script], (err) => {
        if (err) {
          console.warn('[channel:toast] BurntToast notification failed:', err.message);
        }
      });
    } else {
      const text = `${title}: ${message}`;
      execFile('msg', ['*', text], (err) => {
        if (err) {
          console.warn('[channel:toast] msg fallback notification failed:', err.message);
        }
      });
    }
  };
}

module.exports = { createToastChannel };
