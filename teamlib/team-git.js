'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { SHARED_PACK_DIRNAME } = require('./team-output');

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

  // A fast-forward refuses to overwrite UNTRACKED working-tree files (git aborts to avoid clobbering
  // content it does not know about). The team writes its run log + run folder into the project tree
  // BEFORE the worktree exists (the pre-worktree setup/skip gates call ensureStructure/appendLog on
  // projectPath), and a prior run that failed to merge can leave its run folder there too. Those land
  // as untracked files; the branch then tracks the same paths, so the merge-back aborts and the whole
  // run is stranded on its branch. The branch is the authority for everything it commits under the run
  // paths, so remove exactly those untracked collisions before the FF. Conservative on three axes so
  // the project-owned pack and the user's own files are never touched:
  //   (1) only paths under addPaths (the run folder + log + the team's writeScope) are considered,
  //   (2) only files the branch actually tracks are removed (the merge would bring them in regardless),
  //   (3) --exclude-standard skips ignored files (which never block a FF anyway).
  function clearFfCollisions(projectPath, branch, addPaths) {
    if (!branch || !addPaths.length) return;
    const lines = (s) => s.split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
    const tracked = run(['ls-tree', '-r', '--name-only', branch], projectPath);
    if (!tracked.ok) return;
    const trackedSet = new Set(lines(tracked.out));
    const others = run(['ls-files', '--others', '--exclude-standard', '--', ...addPaths], projectPath);
    if (!others.ok) return;
    for (const rel of lines(others.out)) {
      if (!trackedSet.has(rel)) continue; // leave an untracked file the merge would NOT touch
      try { fs.rmSync(path.join(projectPath, rel), { force: true }); } catch { /* best-effort */ }
    }
  }

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
    // addPaths are git pathspecs run verbatim (no shell). A matching glob stages its subtree; a NO-MATCH
    // pathspec makes 'git add' exit non-zero (e.g. 128), which run() swallows to {ok:false}. The run folder
    // + log always match and are staged first, so by 'diff --cached --quiet' there is staged content and we
    // commit. ':(glob)' is the escape hatch only if a future git config breaks '**'.
    for (const p of addPaths) run(['add', '--', p], wt);
    const committed = run(['diff', '--cached', '--quiet'], wt).ok === false
      ? run(['commit', '-m', message || 'glissa team run'], wt).ok
      : false;

    let merged = false;
    let reason = null;
    if (committed && workspace.branch && workspace.base && workspace.base !== 'HEAD') {
      clearFfCollisions(projectPath, workspace.branch, addPaths);
      merged = run(['merge', '--ff-only', workspace.branch], projectPath).ok;
      if (!merged) reason = 'not-fast-forward';
    } else if (!committed) {
      reason = 'nothing-to-commit';
    } else {
      reason = 'detached-head';
    }

    removeNodeModulesJunction(wt);
    run(['worktree', 'remove', '--force', wt], projectPath);
    run(['worktree', 'prune'], projectPath);
    if (merged && workspace.branch) run(['branch', '-D', workspace.branch], projectPath);

    return { branch: merged ? null : (workspace.branch || null), base: workspace.base || null, merged, committed, reason };
  }

  // Session worktree merge-back into the integration branch (e.g. `develop`). Rebases the session
  // branch onto the target so a moved target still lands, then fast-forwards the target to it, then
  // tears the worktree down JUNCTION-SAFELY (the node_modules junction is removed BEFORE
  // `worktree remove` so git can never follow it into the operator's real node_modules). Synchronous,
  // so two merge-backs in one process never interleave (the first advances the target before the
  // second reads it) — that is the whole serialization; no async mutex is needed and a cross-session
  // FF race cannot occur. A rebase conflict ABORTS and PARKS the branch (worktree + branch preserved)
  // for a manual merge; nothing is ever auto-resolved. Returns { merged, committed, branch, base,
  // reason, parked? }; `branch` is null once merged (deleted) or discarded, else the parked branch.
  function mergeBack({ projectPath, workspace, targetBranch, addPaths = [], message }) {
    if (!workspace || !workspace.isGit) return { merged: false, committed: false, branch: null, reason: 'not-git' };
    const wt = workspace.cwd;
    const branch = workspace.branch;
    if (!branch) return { merged: false, committed: false, branch: null, reason: 'no-branch' };
    const target = targetBranch || workspace.base;
    if (!target || target === 'HEAD') return { merged: false, committed: false, branch, reason: 'no-target', parked: true };
    // The integration branch must already exist — Glissa never creates it (AC-16).
    if (!run(['rev-parse', '--verify', '--quiet', `refs/heads/${target}`], projectPath).ok) {
      return { merged: false, committed: false, branch, base: target, reason: 'no-target-branch', parked: true };
    }

    // Stage the WHOLE session diff (a session edits arbitrary files) and commit if anything is staged.
    run(['add', '-A'], wt);
    const committed = run(['diff', '--cached', '--quiet'], wt).ok === false
      ? run(['commit', '-m', message || 'glissa session'], wt).ok
      : false;
    if (!committed) {
      // Nothing to merge — discard the worktree (junction-safe) and branch.
      removeNodeModulesJunction(wt);
      run(['worktree', 'remove', '--force', wt], projectPath);
      run(['worktree', 'prune'], projectPath);
      run(['branch', '-D', branch], projectPath);
      return { merged: false, committed: false, branch: null, base: target, reason: 'nothing-to-commit' };
    }

    // Rebase onto the integration branch; a conflict aborts and PARKS (keep worktree + branch).
    if (!run(['rebase', target], wt).ok) {
      run(['rebase', '--abort'], wt);
      return { merged: false, committed: true, branch, base: target, reason: 'rebase-conflict', parked: true };
    }

    // Fast-forward the integration branch to the rebased session branch. If it is checked out in
    // projectPath, an ff-only merge advances it + its working tree; otherwise update the ref directly
    // via an ff-only `fetch . <branch>:<target>` (no checkout of the target required).
    const head = run(['rev-parse', '--abbrev-ref', 'HEAD'], projectPath).out;
    let merged;
    if (head === target) {
      clearFfCollisions(projectPath, branch, addPaths);
      merged = run(['merge', '--ff-only', branch], projectPath).ok;
    } else {
      merged = run(['fetch', '.', `refs/heads/${branch}:refs/heads/${target}`], projectPath).ok;
    }
    if (!merged) return { merged: false, committed: true, branch, base: target, reason: 'not-fast-forward', parked: true };

    removeNodeModulesJunction(wt);
    run(['worktree', 'remove', '--force', wt], projectPath);
    run(['worktree', 'prune'], projectPath);
    run(['branch', '-D', branch], projectPath);
    return { merged: true, committed: true, branch: null, base: target, reason: null };
  }

  // Throw away a worktree and its branch (cancelled runs): nothing is committed or merged.
  function discard({ projectPath, workspace }) {
    if (!workspace || !workspace.isGit) return;
    if (workspace.cwd) {
      removeNodeModulesJunction(workspace.cwd);
      run(['worktree', 'remove', '--force', workspace.cwd], projectPath);
    }
    if (workspace.branch) run(['branch', '-D', workspace.branch], projectPath);
    run(['worktree', 'prune'], projectPath);
  }

  // Restore the oracle (tests) in the worktree to the run's base SHA before an audit, so the auditor
  // grades the SOURCE against the unedited tests: any test the fixer edited/deleted is reverted, and any
  // untracked NEW test the fixer added is removed. Combined with tests being EXCLUDED from writeScope
  // (a test edit can never merge), the oracle is protected at both the audit and the merge.
  //
  // Issued through the SAME swallowing run() as everything else, ONE call per glob. Per-glob is
  // load-bearing: a SINGLE `git checkout <sha> -- <glob...>` is ATOMIC and ABORTS the whole restore if
  // ANY pathspec matches nothing (verified on git 2.44.0.windows.1: exit 1, nothing restored), which is
  // the common case (a repo with *.test.* files but no tests/ dir). Per-glob isolates each no-match
  // (swallowed) so the matching globs still restore.
  //   - checkout reverts TRACKED tests; a no-match glob exits non-zero, harmlessly swallowed.
  //   - clean removes UNTRACKED NEW tests; testGlob-SCOPED so the run folder under .glissa/ and any new
  //     in-scope SOURCE survive. `-f` (no `-d`) is sufficient: a scoped pathspec like '**/__tests__/**'
  //     removes files inside a new untracked test dir and the now-empty dir (verified, same git); an
  //     unscoped clean would delete the run folder + new source, so the scope is mandatory.
  // No-op unless the project is a git repo with a captured baseSha and a non-empty testGlobs.
  function restoreTests({ workspace, testGlobs = [] }) {
    if (!workspace || !workspace.isGit || !testGlobs.length || !workspace.baseSha) return;
    const wt = workspace.cwd;
    for (const glob of testGlobs) run(['checkout', workspace.baseSha, '--', glob], wt);
    for (const glob of testGlobs) run(['clean', '-f', '--', glob], wt);
  }

  return {
    create, integrate, discard, restoreTests, mergeBack,
  };
}

// Remove a node_modules JUNCTION/symlink reparse point from a worktree WITHOUT touching its target.
// Critical safety step before `git worktree remove --force`: if a junction is left in place, git can
// follow it and delete the operator's REAL node_modules. A real (non-symlink) node_modules directory
// — the in-place fallback case — is never removed here. Best-effort and idempotent.
function removeNodeModulesJunction(wtDir) {
  if (!wtDir) return;
  const nm = path.join(wtDir, 'node_modules');
  let st;
  try { st = fs.lstatSync(nm); } catch { return; }   // absent — nothing to do
  if (!st.isSymbolicLink()) return;                   // a REAL dir (in-place fallback) — never delete it
  try { fs.rmSync(nm, { recursive: false, force: true }); }
  catch { try { fs.rmdirSync(nm); } catch { /* best-effort */ } }
}

// Create a Windows directory junction <wtDir>/node_modules -> <projectPath>/node_modules so a session
// worktree can run the project's tooling (build/lint/test) without a reinstall. A junction (mklink /J)
// needs no admin rights, unlike a symlink. Best-effort: the session simply runs without node_modules
// on any failure (absent target, link already present, non-Windows). Returns true only when it linked.
function linkNodeModules(projectPath, wtDir) {
  if (!projectPath || !wtDir) return false;
  const target = path.join(projectPath, 'node_modules');
  const link = path.join(wtDir, 'node_modules');
  try {
    if (!fs.existsSync(target)) return false;
    if (fs.existsSync(link)) return false;
    execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function copyDirInto(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

function defaultCopyPack(projectPath, wtDir, outputPath) {
  // The project-level shared pack (.glissa/pack/) holds cross-team files (voice/avoid/brand) used by any
  // team that declares them shared. It lives OUTSIDE outputPath, so copy it in independently of the
  // team-local pack. Both copies stay UNSTAGED (integrate adds only the run folder + log + SHIP writeScope),
  // so neither is committed back and both vanish with the worktree. Guarded so an absent dir is a no-op.
  copyDirInto(path.join(projectPath, SHARED_PACK_DIRNAME), path.join(wtDir, SHARED_PACK_DIRNAME));
  if (!outputPath) return;
  copyDirInto(path.join(projectPath, outputPath, 'pack'), path.join(wtDir, outputPath, 'pack'));
}

module.exports = { createGitWorkspace, linkNodeModules };
