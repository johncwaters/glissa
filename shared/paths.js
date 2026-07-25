'use strict';

const path = require('node:path');

// Same physical directory despite spelling differences: Windows paths are case-insensitive, and the
// two spellings being compared can come from different producers (a config hand-edit, git porcelain
// with forward slashes, a trailing separator). Misclassifying two spellings of one directory as
// different repos skips worktree adoption and reproduces the branch-in-use in-place fallback.
function isSameDirectoryPath(a, b) {
  const resolvedA = path.resolve(String(a || ''));
  const resolvedB = path.resolve(String(b || ''));
  if (resolvedA === resolvedB) return true;
  return process.platform === 'win32' && resolvedA.toLowerCase() === resolvedB.toLowerCase();
}

module.exports = { isSameDirectoryPath };
