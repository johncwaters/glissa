'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Run each team run inside a throwaway git worktree on a dedicated branch, so the team's writes never
// touch the user's working tree or current branch during the (multi-minute) run. On a terminal
// outcome the run is committed on that branch and fast-forwarded back into the base branch when that
// is safe; if the base moved meanwhile, the branch is kept for a manual merge. A non-git project, a
// repo with no commits, or a detached HEAD falls back to running in place (no isolation, no merge).
//
// The git runner is injected so the branch/worktree/merge sequence is unit-testable without a repo;
// backend.js wires the real `git` via execFileSync.

function createGitWorkspace(opts = {}) {
  const git = opts.git || ((args, cwd) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000,
  }));
  const mkdtemp = opts.mkdtemp || ((prefix) => fs.mkdtempSync(prefix));
  const copyPack = opts.copyPack || defaultCopyPack;

  function run(args, cwd) {
    try { return { ok: true, out: String(git(args, cwd) || '').trim() }; }
    catch (err) { return { ok: false, out: String(err.stdout || '').trim(), err: String(err.stderr || err.message || '') }; }
  }
  function sanitize(s) { return String(s || '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, ''); }

  // Create an isolated worktree on `glissa/<teamId>/<label>`. Returns
  // { cwd, isGit, branch, base, baseSha }; falls back to { cwd: projectPath, isGit: false }.
  function create({ projectPath, teamId, label, outputPath }) {
    const inside = run(['rev-parse', '--is-inside-work-tree'], projectPath);
    if (!inside.ok || inside.out !== 'true') return { cwd: projectPath, isGit: false };
    const head = run(['rev-parse', 'HEAD'], projectPath);
    if (!head.ok) return { cwd: projectPath, isGit: false }; // no commits yet — nothing to branch from
    const baseSha = head.out;
    const base = run(['rev-parse', '--abbrev-ref', 'HEAD'], projectPath).out || 'HEAD';
    const branch = `glissa/${sanitize(teamId)}/${sanitize(label)}`;

    run(['worktree', 'prune'], projectPath);
    run(['branch', '-D', branch], projectPath); // drop a stale branch left by a crashed prior run

    const wtDir = mkdtemp(path.join(os.tmpdir(), `glissa-wt-${sanitize(teamId)}-`));
    const add = run(['worktree', 'add', '-b', branch, wtDir, baseSha], projectPath);
    if (!add.ok) {
      try { fs.rmSync(wtDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      return { cwd: projectPath, isGit: false, error: add.err };
    }
    // Bring the project's pack (voice-guide etc.) into the worktree so the agents read it, including
    // edits not yet committed to HEAD. It is never staged (integrate adds only the run folder + log), so
    // it vanishes with the worktree.
    try { copyPack(projectPath, wtDir, outputPath); } catch { /* best-effort */ }
    return { cwd: wtDir, isGit: true, branch, base, baseSha };
  }

  // Commit the run on its branch and fast-forward it into the base branch when safe. `addPaths` are
  // repo-relative (the run folder + the log). Always removes the worktree; deletes the branch only on
  // a successful merge. Returns { branch, base, merged, committed, reason }: `branch` is null once
  // merged (deleted), else the branch the run is parked on.
  function integrate({ projectPath, workspace, message, addPaths = [] }) {
    if (!workspace || !workspace.isGit) return { branch: null, base: null, merged: false, committed: false, reason: 'not-git' };
    const wt = workspace.cwd;
    for (const p of addPaths) run(['add', '--', p], wt);
    const committed = run(['diff', '--cached', '--quiet'], wt).ok === false
      ? run(['commit', '-m', message || 'glissa team run'], wt).ok
      : false;

    let merged = false;
    let reason = null;
    if (committed && workspace.branch && workspace.base && workspace.base !== 'HEAD') {
      merged = run(['merge', '--ff-only', workspace.branch], projectPath).ok;
      if (!merged) reason = 'not-fast-forward';
    } else if (!committed) {
      reason = 'nothing-to-commit';
    } else {
      reason = 'detached-head';
    }

    run(['worktree', 'remove', '--force', wt], projectPath);
    run(['worktree', 'prune'], projectPath);
    if (merged && workspace.branch) run(['branch', '-D', workspace.branch], projectPath);

    return { branch: merged ? null : (workspace.branch || null), base: workspace.base || null, merged, committed, reason };
  }

  // Throw away a worktree and its branch (cancelled runs): nothing is committed or merged.
  function discard({ projectPath, workspace }) {
    if (!workspace || !workspace.isGit) return;
    if (workspace.cwd) run(['worktree', 'remove', '--force', workspace.cwd], projectPath);
    if (workspace.branch) run(['branch', '-D', workspace.branch], projectPath);
    run(['worktree', 'prune'], projectPath);
  }

  return { create, integrate, discard };
}

function defaultCopyPack(projectPath, wtDir, outputPath) {
  if (!outputPath) return;
  const src = path.join(projectPath, outputPath, 'pack');
  if (!fs.existsSync(src)) return;
  const dest = path.join(wtDir, outputPath, 'pack');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

module.exports = { createGitWorkspace };
