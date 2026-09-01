import fs from 'node:fs';
import path from 'node:path';

export function canonicalizePath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

export function equalsIgnoringCaseOnWindows(a: string, b: string): boolean {
  if (a === b) return true;
  return process.platform === 'win32' && a.toLowerCase() === b.toLowerCase();
}

export function isSameDirectoryPath(a: unknown, b: unknown): boolean {
  const resolvedA = path.resolve(String(a || ''));
  const resolvedB = path.resolve(String(b || ''));
  if (equalsIgnoringCaseOnWindows(resolvedA, resolvedB)) return true;

  if (process.platform !== 'win32') return false;

  return equalsIgnoringCaseOnWindows(canonicalizePath(resolvedA), canonicalizePath(resolvedB));
}

export function safePathSegment(value: unknown): string {
  return String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/, '') || '_';
}
