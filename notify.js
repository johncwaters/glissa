'use strict';

const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

let burntToastModulePath = null; // null = unknown, false = not found, string = resolved path

function escapeForPowerShell(str) {
  return String(str).replace(/'/g, "''");
}

function findBurntToastModule() {
  // Workaround for BurntToast module path resolution:
  // PSResourceGet installs to WindowsPowerShell\Modules under Documents,
  // but PS7 PSModulePath only includes Documents\PowerShell\Modules.
  // OneDrive can redirect Documents further. Standard Import-Module cannot
  // reliably find BurntToast across all these scenarios, so we walk the
  // candidate paths explicitly.
  const home = process.env.USERPROFILE || process.env.HOME;
  const candidates = [
    // PS7 standard path
    path.join(home, 'Documents', 'PowerShell', 'Modules', 'BurntToast'),
    // WindowsPowerShell path (where PSResourceGet often installs)
    path.join(home, 'Documents', 'WindowsPowerShell', 'Modules', 'BurntToast'),
    // OneDrive-redirected Documents variants
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
    // System-wide
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', 'Modules', 'BurntToast'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'WindowsPowerShell', 'Modules', 'BurntToast'),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch (_) {
      // not found, try next
    }
  }
  return null;
}

function notifyWithBurntToast(title, message) {
  const t = escapeForPowerShell(title);
  const m = escapeForPowerShell(message);
  const modulePath = escapeForPowerShell(burntToastModulePath);
  const cmd = `powershell -NoProfile -Command "Import-Module '${modulePath}'; New-BurntToastNotification -Text '${t}', '${m}'"`;
  exec(cmd, (err) => {
    if (err) {
      console.warn('[notify] BurntToast notification failed:', err.message);
    }
  });
}

function notifyWithMsg(title, message) {
  const text = `${title}: ${message}`;
  exec(`msg * "${text}"`, (err) => {
    if (err) {
      console.warn('[notify] msg fallback notification failed:', err.message);
    }
  });
}

function notify(title, message) {
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

module.exports = { notify };
