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
    // PowerShell unavailable or module not found
  }
  return null;
}

// Both PowerShell editions keep user modules under <root>\<edition>\Modules; the search order is
// per-user first (redirected to OneDrive on a synced Documents folder), machine-wide last.
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
      // not found, try next
    }
  }
  return null;
}

function findBurntToastModule(): string | null {
  return findBurntToastViaPowerShell() || findBurntToastByPath();
}

// Resolve and log the BurntToast module path once, or log the msg-fallback decision.
// Guard-clause form of the found/not-found branch so the caller stays else-free.
function resolveBurntToastModulePath(): string | false {
  const found = findBurntToastModule();
  if (found) {
    console.log(`[channel:toast] BurntToast found at ${found}`);
    return found;
  }
  console.warn('[channel:toast] BurntToast not found, using msg fallback');
  return false;
}

/**
 * Create a toast channel adapter for NotificationManager.
 * Dumb delivery pipe - no debounce, no suppression logic.
 *
 * Windows-only by construction (BurntToast, with `msg` as the fallback). Elsewhere it degrades to a
 * no-op after ONE warning: config.osToast is a plain boolean an operator can carry to a Linux box, and
 * shelling powershell per notification there costs a spawn and a warning line for every delivery.
 * `platform` is injectable so a test can exercise both halves on either host.
 */
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
    // Lazy BurntToast discovery on first call
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
