import path from 'node:path';
import fs from 'node:fs';

import { execFile, execFileSync } from '../../server/child-process-safe.ts';

let burntToastModulePath: string | false | null = null;

function escapeForPowerShell(str: string): string {
  return String(str).replace(/'/g, "''");
}

function findBurntToastViaPowerShell(): string | null {
  try {
    const result = execFileSync('powershell', [
      '-NoProfile', '-Command',
      '(Get-Module -ListAvailable BurntToast | Select-Object -First 1).ModuleBase'
    ], { encoding: 'utf8', timeout: 5000 }).trim();
    if (result && fs.statSync(result).isDirectory()) return result;
  } catch {
  }
  return null;
}

const POWERSHELL_EDITIONS = ['PowerShell', 'WindowsPowerShell'];

function burntToastModuleRoots(): string[] {
  const home = process.env.USERPROFILE || process.env.HOME;
  return [
    home && path.join(home, 'Documents'),
    process.env.OneDrive && path.join(process.env.OneDrive, 'Documents'),
    process.env.OneDriveCommercial && path.join(process.env.OneDriveCommercial, 'Documents'),
    process.env.ProgramFiles || 'C:\\Program Files',
  ].filter((root) => typeof root === 'string');
}

function findBurntToastByPath(): string | null {
  const candidates = burntToastModuleRoots().flatMap((root) =>
    POWERSHELL_EDITIONS.map((edition) => path.join(root, edition, 'Modules', 'BurntToast')));

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
    }
  }
  return null;
}

function findBurntToastModule(): string | null {
  return findBurntToastViaPowerShell() || findBurntToastByPath();
}

function resolveBurntToastModulePath(): string | false {
  const found = findBurntToastModule();
  if (found) {
    console.log(`[channel:toast] BurntToast found at ${found}`);
    return found;
  }
  console.warn('[channel:toast] BurntToast not found, using msg fallback');
  return false;
}

function createToastChannel(
  { platform = process.platform }: { platform?: string } = {},
): (sessionName: string, category: string, message: string, context: object) => void {
  let warnedUnsupported = false;
  return function toastChannel(_sessionName, _category, message, _context) {
    if (platform !== 'win32') {
      if (warnedUnsupported) return;
      warnedUnsupported = true;
      console.warn(`[channel:toast] osToast is Windows-only; OS toasts are skipped on ${platform}`);
      return;
    }

    if (burntToastModulePath === null) {
      burntToastModulePath = resolveBurntToastModulePath();
    }

    const title = 'Glissa';
    if (!burntToastModulePath) {
      const text = `${title}: ${message}`;
      execFile('msg', ['*', text], (err: Error | null) => {
        if (err) {
          console.warn('[channel:toast] msg fallback notification failed:', err.message);
        }
      });
      return;
    }
    const t = escapeForPowerShell(title);
    const m = escapeForPowerShell(message);
    const modulePath = escapeForPowerShell(burntToastModulePath);
    const script = `Import-Module '${modulePath}'; New-BurntToastNotification -Text '${t}', '${m}'`;
    execFile('powershell', ['-NoProfile', '-Command', script], (err: Error | null) => {
      if (err) {
        console.warn('[channel:toast] BurntToast notification failed:', err.message);
      }
    });
  };
}

export { createToastChannel };
