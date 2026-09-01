import { execFileSync } from 'node:child_process';

// Shared git-availability probe and command runner for tests that spin up throwaway repos.
// Several suites (session worktree, boot reconcile, git-workspace-session) skip their
// real-git tests when git is unavailable on the host; this is the one place that decides that.

function hasGit(): boolean {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export { hasGit, git };
