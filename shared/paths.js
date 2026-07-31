'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The one spelling of a path that every producer agrees on. Windows names a single directory several
// ways (an 8.3 short form like C:\Users\RUNNER~1\..., a subst drive, a junction) and only the NATIVE
// realpath collapses them: it goes through GetFinalPathNameByHandle, while the JS fs.realpathSync
// leaves a short path short. Returns the input untouched when the path is not on disk, so callers may
// pass a path that does not exist yet.
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
  // Only reached once the literal spellings disagree, so the disk hit stays off the common path.
  return equalsIgnoringCaseOnWindows(canonicalizePath(resolvedA), canonicalizePath(resolvedB));
}

module.exports = { canonicalizePath, isSameDirectoryPath };
