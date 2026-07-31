'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('../server/child-process-safe');
const { promisify } = require('node:util');
const { SHARED_PACK_DIRNAME } = require('./team-output');

const execFileP = promisify(execFile);
const fsp = fs.promises;

// Shared {ok,out}/{ok:false,out,err} result shaping for the sync and async `run()` git helpers below.
function okResult(out) {
  return { ok: true, out: String(out || '').trim() };
}
function errResult(err) {
  return { ok: false, out: String(err.stdout || '').trim(), err: String(err.stderr || err.message || '') };
}

// Pure parse of `git worktree list --porcelain`: returns { cwd, branch } for every worktree block that
// carries a `branch refs/heads/...` line (a detached or bare worktree has none and is skipped). Shared
// by findWorktreeForBranch and both listSessionWorktrees engines below.
function parseWorktreeBranches(porcelain) {
  const result = [];
  let curWt = null;
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) { curWt = line.slice('worktree '.length).trim(); continue; }
    if (line === '') { curWt = null; continue; }
    if (!line.startsWith('branch ')) continue;
    const branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    const cwd = curWt;
    curWt = null;
    if (cwd) result.push({ cwd, branch });
  }
  return result;
}

// The worktree path already holding `branch` checked out, or null.
function findWorktreeForBranch(porcelain, branch) {
  const hit = parseWorktreeBranches(porcelain).find((w) => w.branch === branch);
  return hit ? hit.cwd : null;
}

// Run each team run inside a throwaway git worktree on a dedicated branch, so the team's writes never
// touch the user's working tree or current branch during the (multi-minute) run. On a terminal
// outcome the run is committed on that branch and fast-forwarded back into the base branch when that
// is safe; if the base moved meanwhile, the branch is kept for a manual merge. A non-git project, a
// repo with no commits, or a detached HEAD falls back to running in place (no isolation, no merge).
//
// The git runner is injected so the branch/worktree/merge sequence is unit-testable without a repo;
// backend.js wires the real `git` via execFileSync.

function createGitWorkspace(opts = {}) {
  // The default runner is the promisified execFile: it rejects on a non-zero exit with err.stdout/
  // err.stderr attached, which run()'s catch reads exactly as the sync execFileSync error did. A test
  // may inject a sync fake (returns a string or throws); `await` resolves the string and a sync throw
  // rejects the awaited expression into the same catch, so sync fakes stay valid unchanged.
  const git = opts.git || (async (args, cwd) => {
    const { stdout } = await execFileP('git', args, {
      cwd, encoding: 'utf8', timeout: 20000,
    });
    return stdout;
  });
  const mkdtemp = opts.mkdtemp || ((prefix) => fs.mkdtempSync(prefix));
  const copyPack = opts.copyPack || defaultCopyPack;

  // Engine-level serialization queue. ALL sessions share ONE gitWorkspace instance, and the old
  // synchronous engine was a de-facto global lock (two merges in one process never interleaved). Making
  // the engine async dissolves that implicit lock, so two different sessions merging into the SAME
  // integration branch could interleave their rev-list/stash/rebase/merge sequences across await gaps.
  // serialize() chains the ref/worktree-MUTATING method bodies so they run strictly one at a time. The
  // .catch on the tail keeps the queue from wedging on a rejection; the returned promise still carries
  // the real result/rejection to the caller.
  let tail = Promise.resolve();
  const serialize = (fn) => {
    const r = tail.then(fn);
    tail = r.catch(() => {});
    return r;
  };

  async function run(args, cwd) {
    try { return okResult(await git(args, cwd)); }
    catch (err) { return errResult(err); }
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
  async function clearFfCollisions(projectPath, branch, addPaths) {
    if (!branch || !addPaths.length) return;
    const lines = (s) => s.split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
    const tracked = await run(['ls-tree', '-r', '--name-only', branch], projectPath);
    if (!tracked.ok) return;
    const trackedSet = new Set(lines(tracked.out));
    const others = await run(['ls-files', '--others', '--exclude-standard', '--', ...addPaths], projectPath);
    if (!others.ok) return;
    for (const rel of lines(others.out)) {
      if (!trackedSet.has(rel)) continue; // leave an untracked file the merge would NOT touch
      try { fs.rmSync(path.join(projectPath, rel), { force: true }); } catch { /* best-effort */ }
    }
  }

  // Seed refs tried in order to auto-create a missing integration branch: the remote-tracking branch of
  // the same name first (it just is not checked out locally yet), then the repo's likely default
  // branches, then HEAD as a final catch-all (createBody already verified HEAD resolves earlier, so a
  // seed is effectively always found in a repo with commits). Passing the REF NAME (not the sha) to
  // `git branch` means creating from a remote-tracking ref also sets upstream tracking automatically.
  async function ensureLocalBranch(projectPath, baseBranch) {
    const seedCandidates = [
      `refs/remotes/origin/${baseBranch}`,
      'refs/heads/main',
      'refs/heads/master',
      'refs/remotes/origin/main',
      'refs/remotes/origin/master',
      'HEAD',
    ];
    let seedRef = null;
    for (const candidate of seedCandidates) {
      const verify = await run(['rev-parse', '--verify', '--quiet', candidate], projectPath);
      if (!verify.ok) continue;
      seedRef = candidate;
      break;
    }
    if (!seedRef) return false;
    const created = await run(['branch', baseBranch, seedRef], projectPath);
    return created.ok;
  }

  // Create an isolated worktree on `glissa/<teamId>/<label>`. Returns
  // { cwd, isGit, branch, base, baseSha }; falls back to { cwd: projectPath, isGit: false }.
  function create(args) {
    return serialize(() => createBody(args));
  }
  async function createBody({ projectPath, teamId, label, outputPath, baseBranch, worktreeBase, shareList }) {
    const inside = await run(['rev-parse', '--is-inside-work-tree'], projectPath);
    if (!inside.ok || inside.out !== 'true') return { cwd: projectPath, isGit: false };
    const head = await run(['rev-parse', 'HEAD'], projectPath);
    if (!head.ok) return { cwd: projectPath, isGit: false }; // no commits yet - nothing to branch from
    let baseSha = head.out;
    let base = (await run(['rev-parse', '--abbrev-ref', 'HEAD'], projectPath)).out || 'HEAD';
    if (baseBranch) {
      // Fork off a SPECIFIC branch (the session integration branch, e.g. develop) regardless of what
      // the operator's main checkout currently has checked out. A missing local branch is auto-created
      // from origin/<baseBranch>, then main/master, then HEAD (ensureLocalBranch below); reason:
      // 'no-base-branch' remains only as the fallback when that creation itself fails.
      let ref = await run(['rev-parse', '--verify', '--quiet', `refs/heads/${baseBranch}`], projectPath);
      if (!ref.ok) {
        const created = await ensureLocalBranch(projectPath, baseBranch);
        if (!created) return { cwd: projectPath, isGit: false, reason: 'no-base-branch' };
        ref = await run(['rev-parse', '--verify', '--quiet', `refs/heads/${baseBranch}`], projectPath);
        if (!ref.ok) return { cwd: projectPath, isGit: false, reason: 'no-base-branch' };
      }
      baseSha = ref.out;
      base = baseBranch;
    }
    const branch = `glissa/${sanitize(teamId)}/${sanitize(label)}`;

    // Prune BEFORE the branch-in-use check: a stale registration whose directory is gone must be
    // reclaimed (the pre-existing crash-recovery behavior), not misreported as a live conflict.
    await run(['worktree', 'prune'], projectPath);

    // Pre-empt both the branch -D failure below and git's raw "already checked out" error: a domain
    // reason the caller can act on (another worktree already holds this exact branch checked out).
    const listed = await run(['worktree', 'list', '--porcelain'], projectPath);
    if (listed.ok) {
      const conflictPath = findWorktreeForBranch(listed.out, branch);
      // `branch` rides along so a session caller can recognize the conflict as its OWN surviving
      // worktree (the session branch embeds the session id) and re-adopt it instead of degrading.
      if (conflictPath) return { cwd: projectPath, isGit: false, reason: 'branch-in-use', conflictPath, branch };
    }

    await run(['branch', '-D', branch], projectPath); // drop a stale branch left by a crashed prior run

    // A SESSION worktree lives under a stable, project-associated root (worktreeBase, e.g. a
    // `.glissa-worktrees` sibling of the repo) rather than system-temp, so its path is recognizable and
    // persistent. It stays
    // OUTSIDE the repo working tree (no nested biome/eslint config; the main checkout's git status stays
    // clean). Teams pass no worktreeBase and keep the temp-dir default.
    let wtParent = os.tmpdir();
    let prefix = `glissa-wt-${sanitize(teamId)}-`;
    if (worktreeBase) {
      try { fs.mkdirSync(worktreeBase, { recursive: true }); } catch { /* best-effort */ }
      wtParent = worktreeBase;
      prefix = `${sanitize(path.basename(projectPath)) || 'repo'}-`;
    }
    const wtDir = mkdtemp(path.join(wtParent, prefix));
    const add = await run(['worktree', 'add', '-b', branch, wtDir, baseSha], projectPath);
    if (!add.ok) {
      try { fs.rmSync(wtDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      return { cwd: projectPath, isGit: false, error: add.err };
    }
    // Stamp the fork-base target on the branch itself, so later reads (listSessionWorktrees, boot
    // reconcile) resolve the correct integration branch even if the live config changes afterward.
    // Non-fatal: git drops branch.<name>.* config on branch delete, so no cleanup path is needed either.
    await run(['config', `branch.${branch}.glissa-integration`, base], projectPath);
    // Bring the project's pack (voice-guide etc.) into the worktree so the agents read it, including
    // edits not yet committed to HEAD. It is never staged (integrate adds only the run folder + log), so
    // it vanishes with the worktree.
    try { await copyPack(projectPath, wtDir, outputPath); } catch { /* best-effort */ }
    // Bring the gitignored local working context (node_modules, .env, .claude, .omc, ...) into the
    // worktree so the spawned agent sees a COMPLETE, recognizable project, not a bare checkout. Dirs are
    // junctioned (shared with the real repo, never copied or merged, gitignored so `git add -A` skips
    // them); files are copied. Entries already committed or absent are skipped.
    await populateShare({ projectPath, wtDir, shareList });
    return { cwd: wtDir, isGit: true, branch, base, baseSha };
  }

  // Bring the gitignored share entries into a worktree. Only entries git IGNORES are brought in, so a
  // shared file/junction can NEVER be staged by mergeBack's `git add -A` and accidentally committed to
  // the integration branch (e.g. leaking a .env). Checked sequentially so the check-ignore probes never
  // interleave with another serialized mutation. Idempotent (entries already present are skipped), so
  // it is also safe on an ADOPTED survivor worktree whose junctions were stripped by a failed removal
  // (removeWorktreeLinks runs before the `worktree remove` that then fails on a locked dir).
  async function populateShare({ projectPath, wtDir, shareList }) {
    if (!shareList || !shareList.length) return;
    const ignored = [];
    for (const rel of shareList) {
      if (rel && !String(rel).includes('..') && (await run(['check-ignore', '-q', '--', rel], projectPath)).ok) {
        ignored.push(rel);
      }
    }
    if (!ignored.length) return;
    try { await populateWorktree(projectPath, wtDir, ignored); } catch { /* best-effort */ }
  }

  // Public re-share entry for a caller that adopts an existing worktree outside create() (the
  // branch-in-use self-adopt in sessions.js). Serialized like every other engine method that touches
  // a worktree, so it never interleaves with a live merge/remove. createBody must keep calling the
  // inner populateShare directly: calling this serialized wrapper from inside the serialize chain
  // would deadlock (the inner call would chain onto a tail that includes the in-flight create).
  function populate(args) {
    return serialize(() => populateShare(args));
  }

  // Commit the run on its branch and fast-forward it into the base branch when safe. `addPaths` are
  // repo-relative (the run folder + the log). Always removes the worktree; deletes the branch only on
  // a successful merge. Returns { branch, base, merged, committed, reason }: `branch` is null once
  // merged (deleted), else the branch the run is parked on.
  function integrate(args) {
    return serialize(() => integrateBody(args));
  }
  async function integrateBody({ projectPath, workspace, message, addPaths = [] }) {
    if (!workspace || !workspace.isGit) return { branch: null, base: null, merged: false, committed: false, reason: 'not-git' };
    const wt = workspace.cwd;
    // addPaths are git pathspecs run verbatim (no shell). A matching glob stages its subtree; a NO-MATCH
    // pathspec makes 'git add' exit non-zero (e.g. 128), which run() swallows to {ok:false}. The run folder
    // + log always match and are staged first, so by 'diff --cached --quiet' there is staged content and we
    // commit. ':(glob)' is the escape hatch only if a future git config breaks '**'. Staged sequentially:
    // the per-path adds must complete in order before the diff-cached check reads the index.
    for (const p of addPaths) await run(['add', '--', p], wt);
    const committed = (await run(['diff', '--cached', '--quiet'], wt)).ok === false
      ? (await run(['commit', '-m', message || 'glissa team run'], wt)).ok
      : false;

    let merged = false;
    let reason = null;
    if (committed && workspace.branch && workspace.base && workspace.base !== 'HEAD') {
      await clearFfCollisions(projectPath, workspace.branch, addPaths);
      merged = (await run(['merge', '--ff-only', workspace.branch], projectPath)).ok;
      if (!merged) reason = 'not-fast-forward';
    } else if (!committed) {
      reason = 'nothing-to-commit';
    } else {
      reason = 'detached-head';
    }

    removeWorktreeLinks(wt);
    await run(['worktree', 'remove', '--force', wt], projectPath);
    await run(['worktree', 'prune'], projectPath);
    if (merged && workspace.branch) await run(['branch', '-D', workspace.branch], projectPath);

    return { branch: merged ? null : (workspace.branch || null), base: workspace.base || null, merged, committed, reason };
  }

  // Junction-safe teardown of a worktree (+ its branch): the node_modules junction is removed BEFORE
  // `worktree remove` so git can never follow it into the operator's real node_modules.
  async function tearDownWorktree(projectPath, wt, branch) {
    removeWorktreeLinks(wt);
    await run(['worktree', 'remove', '--force', wt], projectPath);
    await run(['worktree', 'prune'], projectPath);
    if (branch) await run(['branch', '-D', branch], projectPath);
  }

  // The shared merge core (COMMITTED-ONLY): merge the commits already on `branch` into `target` via
  // rebase-then-FF, leaving UNCOMMITTED working-tree changes out of the merge. Uncommitted edits are never
  // swept in (the operator's "commit it first" boundary, and what the review sidebar draws its committed/
  // uncommitted line on) and never destroyed: they are stashed around the rebase (which needs a clean
  // tree) and ALWAYS restored afterward. Callers that want to tear the worktree down (mergeBack) must do
  // so only on a clean tree, so this function never has to drop a stash. Does NOT tear anything down - the
  // caller decides. Serialized by the engine-level `serialize` queue (its callers mergeBack/mergeKeep are
  // wrapped), so two merges into the same target never interleave: the first advances the target before
  // the second reads it. A rebase conflict ABORTS and reports parked; nothing is ever auto-resolved.
  // `committed` means "there were commits to merge", not that this function made one.
  // Returns { committed, merged, reason, parked?, restoreConflict? }.
  async function rebaseFfBranch({ projectPath, wt, branch, target, addPaths = [] }) {
    // Commits on the branch but not yet on the target = exactly what merging would bring in. None means
    // there is nothing committed to merge (uncommitted-only work is left for the operator to commit).
    const ahead = await run(['rev-list', '--count', `${target}..${branch}`], projectPath);
    if (!ahead.ok || ahead.out === '' || ahead.out === '0') {
      return { committed: false, merged: false, reason: 'nothing-to-commit' };
    }

    // Stash uncommitted work (incl. untracked) so the rebase runs on a clean tree. Track whether the stash
    // actually took: only pop when it did, so a failed push can never make a later pop grab an unrelated,
    // pre-existing stash (which would corrupt the worktree).
    const dirty = (await run(['status', '--porcelain'], wt)).out !== '';
    const stashed = dirty && (await run(['stash', 'push', '--include-untracked', '-m', 'glissa-merge'], wt)).ok;

    // Rebase onto the integration branch; a conflict aborts and reports parked (caller keeps the branch).
    if (!(await run(['rebase', target], wt)).ok) {
      // Capture the conflicting files BEFORE aborting (the abort restores a clean tree and loses them).
      // They are reported up so the parked-merge handoff prompt can name exactly what overlaps.
      const conflicts = (await run(['diff', '--name-only', '--diff-filter=U'], wt)).out
        .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      await run(['rebase', '--abort'], wt);
      if (stashed) await run(['stash', 'pop'], wt); // hand the operator their uncommitted work back, un-rebased
      return { committed: true, merged: false, reason: 'rebase-conflict', parked: true, conflicts };
    }

    // Fast-forward the integration branch to the rebased session branch. If it is checked out in
    // projectPath, an ff-only merge advances it + its working tree; otherwise update the ref directly
    // via an ff-only `fetch . <branch>:<target>` (no checkout of the target required).
    const head = (await run(['rev-parse', '--abbrev-ref', 'HEAD'], projectPath)).out;
    let merged;
    if (head === target) {
      await clearFfCollisions(projectPath, branch, addPaths);
      merged = (await run(['merge', '--ff-only', branch], projectPath)).ok;
    } else {
      merged = (await run(['fetch', '.', `refs/heads/${branch}:refs/heads/${target}`], projectPath)).ok;
    }
    if (!merged) {
      if (stashed) await run(['stash', 'pop'], wt);
      return { committed: true, merged: false, reason: 'not-fast-forward', parked: true };
    }

    // Merged. Restore the uncommitted work onto the rebased worktree. A `stash pop` that conflicts leaves
    // markers for the operator and is reported (restoreConflict), never auto-resolved.
    const restoreConflict = stashed ? !(await run(['stash', 'pop'], wt)).ok : false;
    return { committed: true, merged: true, reason: null, restoreConflict };
  }

  // Shared guard preamble for the merge-back paths (mergeBack/mergeKeep): validate the workspace and
  // resolve the integration target. Returns { wt, branch, target } on success, or { error } carrying the
  // caller's standard failure result. The integration branch must already exist - Glissa never creates it
  // (AC-16) - so a missing target reports parked.
  async function resolveMergeBack({ projectPath, workspace, targetBranch }) {
    if (!workspace || !workspace.isGit) return { error: { merged: false, committed: false, branch: null, reason: 'not-git' } };
    const branch = workspace.branch;
    if (!branch) return { error: { merged: false, committed: false, branch: null, reason: 'no-branch' } };
    const target = targetBranch || workspace.base;
    if (!target || target === 'HEAD') return { error: { merged: false, committed: false, branch, reason: 'no-target', parked: true } };
    if (!(await run(['rev-parse', '--verify', '--quiet', `refs/heads/${target}`], projectPath)).ok) {
      return { error: { merged: false, committed: false, branch, base: target, reason: 'no-target-branch', parked: true } };
    }
    return { wt: workspace.cwd, branch, target };
  }

  // Session worktree merge-back into the integration branch (e.g. `develop`) that ENDS the session:
  // committed-only rebase-then-FF via rebaseFfBranch, then tear the worktree down junction-safely. A
  // rebase conflict / lost FF PARKS the branch (worktree + branch preserved) for a manual merge. Returns
  // { merged, committed, branch, base, reason, parked? }; `branch` is null once merged (deleted) or
  // discarded, else the parked branch.
  function mergeBack(args) {
    return serialize(() => mergeBackBody(args));
  }
  async function mergeBackBody({ projectPath, workspace, targetBranch, addPaths = [] }) {
    const g = await resolveMergeBack({ projectPath, workspace, targetBranch });
    if (g.error) return g.error;
    const { wt, branch, target } = g;

    // Finishing tears the worktree down, which would DESTROY any uncommitted work. Never do that
    // silently: if the worktree is dirty, refuse and PARK (worktree + branch preserved) so the operator
    // commits or discards the uncommitted work first, then finishes. (committed-only never sweeps
    // uncommitted work into the merge, so there is nothing to gain by merging here while dirty either.)
    if ((await run(['status', '--porcelain'], wt)).out !== '') {
      return { merged: false, committed: false, branch, base: target, reason: 'uncommitted-changes', parked: true };
    }

    const r = await rebaseFfBranch({ projectPath, wt, branch, target, addPaths });
    if (!r.committed) {
      // Clean worktree with nothing committed = a throwaway chat/research session: discard it (junction-safe).
      await tearDownWorktree(projectPath, wt, branch);
      return { merged: false, committed: false, branch: null, base: target, reason: 'nothing-to-commit' };
    }
    if (!r.merged) {
      // Rebase conflict / lost FF: PARK (keep worktree + branch for manual resolution).
      return { merged: false, committed: true, branch, base: target, reason: r.reason, parked: true, conflicts: r.conflicts || [] };
    }
    await tearDownWorktree(projectPath, wt, branch);
    return { merged: true, committed: true, branch: null, base: target, reason: null };
  }

  // Like mergeBack, but KEEPS the worktree alive on success: after the rebase-then-FF, the worktree
  // STAYS checked out on its branch (now sitting on top of the freshly advanced target). This is the
  // "merge/commit as you go" path: the operator's LIVE session keeps running in the same worktree and
  // can produce + merge more changes later. A rebase conflict / lost FF still PARKS (worktree + branch
  // preserved); nothing-to-commit is a harmless no-op that keeps the worktree. Returns { merged,
  // committed, branch, base, baseSha?, kept, reason, parked? }; `branch` is retained (non-null) whenever
  // the worktree is kept, and baseSha is the new integration tip the worktree was rebased onto.
  function mergeKeep(args) {
    return serialize(() => mergeKeepBody(args));
  }
  async function mergeKeepBody({ projectPath, workspace, targetBranch, addPaths = [] }) {
    const g = await resolveMergeBack({ projectPath, workspace, targetBranch });
    if (g.error) return g.error;
    const { wt, branch, target } = g;

    const r = await rebaseFfBranch({ projectPath, wt, branch, target, addPaths });
    if (!r.committed) {
      // Nothing committed to merge yet - keep the worktree; the live session commits more then merges.
      return { merged: false, committed: false, branch, base: target, reason: 'nothing-to-commit', kept: true };
    }
    if (!r.merged) {
      return { merged: false, committed: true, branch, base: target, reason: r.reason, parked: true, conflicts: r.conflicts || [] };
    }
    // Merged AND kept: record the new integration tip the worktree now sits on top of. restoreConflict
    // flags that the stashed uncommitted work reapplied with conflict markers for the operator to resolve.
    const baseSha = (await run(['rev-parse', target], projectPath)).out || workspace.baseSha || null;
    return { merged: true, committed: true, branch, base: target, baseSha, kept: true, reason: null, restoreConflict: r.restoreConflict || false };
  }

  // Throw away a worktree and its branch (cancelled runs): nothing is committed or merged.
  function discard(args) {
    return serialize(() => discardBody(args));
  }
  async function discardBody({ projectPath, workspace }) {
    if (!workspace || !workspace.isGit) return;
    if (workspace.cwd) {
      removeWorktreeLinks(workspace.cwd);
      await run(['worktree', 'remove', '--force', workspace.cwd], projectPath);
    }
    if (workspace.branch) await run(['branch', '-D', workspace.branch], projectPath);
    await run(['worktree', 'prune'], projectPath);
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
  function restoreTests(args) {
    return serialize(() => restoreTestsBody(args));
  }
  async function restoreTestsBody({ workspace, testGlobs = [] }) {
    if (!workspace || !workspace.isGit || !testGlobs.length || !workspace.baseSha) return;
    const wt = workspace.cwd;
    // Per-glob, sequential: a single multi-glob checkout is atomic and aborts on any no-match, so each
    // glob is isolated; sequential awaits preserve that one-call-per-glob atomicity contract.
    for (const glob of testGlobs) await run(['checkout', workspace.baseSha, '--', glob], wt);
    for (const glob of testGlobs) await run(['clean', '-f', '--', glob], wt);
  }

  // True when a session worktree holds UNMERGED work that must NOT be destroyed on a restart: uncommitted
  // changes in the worktree, or commits on its branch not yet on the integration branch (a parked/
  // conflicted merge). Gitignored junctions/files never show in `status --porcelain`.
  async function worktreeHasWork(cwd, branch, projectPath, integrationBranch) {
    const dirty = await run(['status', '--porcelain'], cwd);
    if (dirty.ok && dirty.out !== '') return true;
    if (integrationBranch && branch) {
      const ahead = await run(['rev-list', '--count', `${integrationBranch}..${branch}`], projectPath);
      if (ahead.ok && ahead.out && ahead.out !== '0') return true;
    }
    return false;
  }

  // Read the fork-base target stamped on `branch` at create time (see createBody), so a worktree's
  // integration branch is resolved from its own git config instead of assuming the caller's live config
  // never changed. Returns null when unset (older worktree, or the stamp failed).
  async function readIntegrationMarker(projectPath, branch) {
    const r = await run(['config', '--get', `branch.${branch}.glissa-integration`], projectPath);
    return r.ok && r.out ? r.out : null;
  }

  // List the SESSION worktrees (branch `glissa/session/<id>`) of a repo, each with its extracted session
  // id and whether it holds unmerged work. Team worktrees (`glissa/<teamId>/*`) are excluded by namespace.
  async function listSessionWorktrees({ projectPath, integrationBranch }) {
    const out = [];
    const inside = await run(['rev-parse', '--is-inside-work-tree'], projectPath);
    if (!inside.ok || inside.out !== 'true') return out;
    const listed = await run(['worktree', 'list', '--porcelain'], projectPath);
    if (!listed.ok) return out;
    for (const { cwd: wt, branch: name } of parseWorktreeBranches(listed.out)) {
      if (!name.startsWith('glissa/session/')) continue;
      // The marker is the authority for THIS worktree's integration branch; the passed integrationBranch
      // is only the fallback for a worktree created before the marker existed.
      const resolvedIntegrationBranch = (await readIntegrationMarker(projectPath, name)) || integrationBranch;
      out.push({
        cwd: wt, branch: name, id: name.slice('glissa/session/'.length),
        hasWork: await worktreeHasWork(wt, name, projectPath, resolvedIntegrationBranch),
        integrationBranch: resolvedIntegrationBranch,
      });
    }
    return out;
  }

  // Junction-safe removal of a single worktree by path (+ its branch), then prune. A mutator, so it is
  // serialized too (the async engine never races it against a live merge into the same target).
  function removeWorktreeByPath(args) {
    return serialize(() => removeWorktreeByPathBody(args));
  }
  async function removeWorktreeByPathBody({ projectPath, cwd, branch }) {
    if (cwd) {
      removeWorktreeLinks(cwd);
      await run(['worktree', 'remove', '--force', cwd], projectPath);
    }
    if (branch) await run(['branch', '-D', branch], projectPath);
    await run(['worktree', 'prune'], projectPath);
  }

  // Remove orphaned SESSION worktrees, PRESERVING any that hold unmerged work, so a restart can never
  // destroy a pending-review/parked session's changes. Scoped to `glissa/session/*` (team worktrees are
  // never touched). Returns the removed branch names.
  async function sweepSessionWorktrees({ projectPath, integrationBranch }) {
    const removed = [];
    for (const wt of await listSessionWorktrees({ projectPath, integrationBranch })) {
      if (wt.hasWork) continue; // preserve unmerged work
      await removeWorktreeByPath({ projectPath, cwd: wt.cwd, branch: wt.branch });
      removed.push(wt.branch);
    }
    return removed;
  }

  // Generic worktree enumeration for callers that need to know which branches are checked out
  // anywhere in a repo (e.g. the PR-review poller's branch-in-use precheck and its orphan prune).
  // Returns every worktree carrying a branch as { cwd, branch }; goes through this module so the
  // `git worktree` guard stays satisfied. A read-only listing (not serialized): a stale entry only
  // makes a precheck slightly stale, which the caller's failing `gh pr checkout` then handles.
  async function listWorktreeBranches({ projectPath }) {
    const inside = await run(['rev-parse', '--is-inside-work-tree'], projectPath);
    if (!inside.ok || inside.out !== 'true') return [];
    const listed = await run(['worktree', 'list', '--porcelain'], projectPath);
    if (!listed.ok) return [];
    return parseWorktreeBranches(listed.out);
  }

  return {
    create, integrate, discard, restoreTests, mergeBack, mergeKeep, populate,
    sweepSessionWorktrees, listSessionWorktrees, listWorktreeBranches, removeWorktreeByPath,
  };
}

// Synchronous sibling for the ONE-SHOT cold boot reconcile (backend.js), which runs once at server start
// before any live session streams, so a blocking git call there steals no PTY time (MEMORY
// single-event-loop-no-sync-git: one-shot cold paths may stay sync). It exposes ONLY the two methods that
// path needs - listSessionWorktrees (read) + removeWorktreeByPath (junction-safe remove) - so the live
// async engine is never reached from boot and the cold path never awaits. Logic mirrors the async engine
// with execFileSync; no serialize queue is needed (single caller, single pass, no concurrency).
function createGitWorkspaceSync(opts = {}) {
  const git = opts.git || ((args, cwd) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000,
  }));
  function run(args, cwd) {
    try { return okResult(git(args, cwd)); }
    catch (err) { return errResult(err); }
  }

  function worktreeHasWork(cwd, branch, projectPath, integrationBranch) {
    const dirty = run(['status', '--porcelain'], cwd);
    if (dirty.ok && dirty.out !== '') return true;
    if (integrationBranch && branch) {
      const ahead = run(['rev-list', '--count', `${integrationBranch}..${branch}`], projectPath);
      if (ahead.ok && ahead.out && ahead.out !== '0') return true;
    }
    return false;
  }

  // Mirrors the async engine's readIntegrationMarker (see createGitWorkspace) for the sync boot path.
  function readIntegrationMarker(projectPath, branch) {
    const r = run(['config', '--get', `branch.${branch}.glissa-integration`], projectPath);
    return r.ok && r.out ? r.out : null;
  }

  function listSessionWorktrees({ projectPath, integrationBranch }) {
    const out = [];
    const inside = run(['rev-parse', '--is-inside-work-tree'], projectPath);
    if (!inside.ok || inside.out !== 'true') return out;
    const listed = run(['worktree', 'list', '--porcelain'], projectPath);
    if (!listed.ok) return out;
    for (const { cwd: wt, branch: name } of parseWorktreeBranches(listed.out)) {
      if (!name.startsWith('glissa/session/')) continue;
      const resolvedIntegrationBranch = readIntegrationMarker(projectPath, name) || integrationBranch;
      out.push({
        cwd: wt, branch: name, id: name.slice('glissa/session/'.length),
        hasWork: worktreeHasWork(wt, name, projectPath, resolvedIntegrationBranch),
        integrationBranch: resolvedIntegrationBranch,
      });
    }
    return out;
  }

  function removeWorktreeByPath({ projectPath, cwd, branch }) {
    if (cwd) {
      removeWorktreeLinks(cwd);
      run(['worktree', 'remove', '--force', cwd], projectPath);
    }
    if (branch) run(['branch', '-D', branch], projectPath);
    run(['worktree', 'prune'], projectPath);
  }

  return { listSessionWorktrees, removeWorktreeByPath };
}

// Remove every JUNCTION/symlink reparse point at the top level of a worktree WITHOUT touching its
// target. Critical before `git worktree remove --force`: a left-in-place junction (node_modules, .claude,
// .omc, ...) can be followed by git and delete the operator's REAL directory. Real (non-symlink) dirs and
// files are left for worktree-remove to delete. Best-effort and idempotent.
function removeWorktreeLinks(wtDir) {
  if (!wtDir) return;
  let entries;
  try { entries = fs.readdirSync(wtDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isSymbolicLink()) continue; // junctions report as symbolic links via the dirent lstat
    const p = path.join(wtDir, e.name);
    try { fs.rmSync(p, { recursive: false, force: true }); }
    catch { try { fs.rmdirSync(p); } catch { /* best-effort */ } }
  }
}

// Bring gitignored local working context into a worktree. Each share entry: a DIR is junctioned
// (mklink /J - shared with the real repo, never copied or merged, gitignored so `git add -A` skips it);
// a FILE is copied. Entries already present in the worktree (committed) or absent in the project are
// skipped. Best-effort per entry so one failure never aborts the spawn. Windows junctions need no admin.
// Async on purpose: this runs on EVERY isolated session/team spawn, and a sync cmd.exe spawn or copy
// here stalls every other session's PTY streaming on the shared event loop.
async function populateWorktree(projectPath, wtDir, shareList) {
  for (const rel of shareList) {
    if (!rel || String(rel).includes('..')) continue; // no path traversal
    const src = path.join(projectPath, rel);
    const dst = path.join(wtDir, rel);
    try {
      const srcStat = await fsp.stat(src).catch(() => null);
      if (!srcStat) continue;  // nothing to share
      const dstExists = await fsp.access(dst).then(() => true, () => false);
      if (dstExists) continue; // already in the worktree (committed) - leave it
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      if (srcStat.isDirectory()) {
        await execFileP('cmd', ['/c', 'mklink', '/J', dst, src]);
        continue;
      }
      await fsp.copyFile(src, dst);
    } catch { /* best-effort: the session runs without that piece */ }
  }
}

async function copyDirInto(src, dest) {
  const exists = await fsp.access(src).then(() => true, () => false);
  if (!exists) return;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.cp(src, dest, { recursive: true });
}

async function defaultCopyPack(projectPath, wtDir, outputPath) {
  // The project-level shared pack (.glissa/pack/) holds cross-team files (voice/avoid/brand) used by any
  // team that declares them shared. It lives OUTSIDE outputPath, so copy it in independently of the
  // team-local pack. Both copies stay UNSTAGED (integrate adds only the run folder + log + SHIP writeScope),
  // so neither is committed back and both vanish with the worktree. Guarded so an absent dir is a no-op.
  await copyDirInto(path.join(projectPath, SHARED_PACK_DIRNAME), path.join(wtDir, SHARED_PACK_DIRNAME));
  if (!outputPath) return;
  await copyDirInto(path.join(projectPath, outputPath, 'pack'), path.join(wtDir, outputPath, 'pack'));
}

module.exports = { createGitWorkspace, createGitWorkspaceSync };
