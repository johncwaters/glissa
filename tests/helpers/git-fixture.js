'use strict';

// Shared git-availability probe and command runner for tests that spin up throwaway repos.
// Several suites (session worktree, boot reconcile, git-workspace-session) skip their
// real-git tests when git is unavailable on the host; this is the one place that decides that.

const { execFileSync } = require('node:child_process');

function hasGit() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

module.exports = { hasGit, git };
