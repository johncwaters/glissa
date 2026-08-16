'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The one spelling of a path that every producer agrees on. Windows names a single directory several
// ways (an 8.3 short form like C:\Users\RUNNER~1\..., a subst drive, a junction) and only the NATIVE
// realpath collapses them: it goes through GetFinalPathNameByHandle, while the JS fs.realpathSync
// leaves a short path short. Returns the input untouched when the path is not on disk, so callers may
// pass a path that does not exist yet.
// Every path handed to fs.watch MUST go through this first: libuv expands each reported event
// filename to its long form and asserts it still starts with the watched dir, so watching an
// unresolved short path aborts the whole process from native code, past every try/catch.
function canonicalizePath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

function equalsIgnoringCaseOnWindows(a, b) {
  if (a === b) return true;
  return process.platform === 'win32' && a.toLowerCase() === b.toLowerCase();
}

// Same physical directory despite spelling differences: Windows paths are case-insensitive, and the
// two spellings being compared can come from different producers (a config hand-edit, git porcelain
// with forward slashes, a trailing separator, an 8.3 short path inherited from %TEMP%). Misclassifying
// two spellings of one directory as different repos skips worktree adoption and reproduces the
// branch-in-use in-place fallback.
function isSameDirectoryPath(a, b) {
  const resolvedA = path.resolve(String(a || ''));
  const resolvedB = path.resolve(String(b || ''));
  if (equalsIgnoringCaseOnWindows(resolvedA, resolvedB)) return true;
  // The alias problem (8.3 short names, subst drives) is Windows-only; elsewhere the literal compare
  // is the whole contract, and canonicalizing would silently equate symlinked directories too.
  if (process.platform !== 'win32') return false;
  // Only reached once the literal spellings disagree, so the disk hit stays off the common path.
  return equalsIgnoringCaseOnWindows(canonicalizePath(resolvedA), canonicalizePath(resolvedB));
}

module.exports = { canonicalizePath, equalsIgnoringCaseOnWindows, isSameDirectoryPath };
