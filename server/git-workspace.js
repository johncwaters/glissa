'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('../server/child-process-safe');
const { promisify } = require('node:util');

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

// Run each isolated lane (a session, a PR review) inside a throwaway git worktree on a dedicated
// branch, so its writes never touch the user's working tree or current branch during the
// (multi-minute) run. On a terminal outcome the work is fast-forwarded back into the base branch when
// that is safe; if the base moved meanwhile, the branch is kept for a manual merge. A non-git project,
// a repo with no commits, or a detached HEAD falls back to running in place (no isolation, no merge).
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

  // Seed refs tried in order to auto-create a missing integration branch: the remote-tracking branch of
  // the same name first (it just is not checked out locally yet), then the repo's likely default
  // branches, then HEAD as a final catch-all (createBody already verified HEAD resolves earlier, so a
  // seed is effectively always found in a repo with commits). Passing the REF NAME (not the sha) to
  // `git branch` means creating from a remote-tracking ref also sets upstream tracking automatically;
  // `--` keeps a config-sourced branch name from ever parsing as a flag. Returns the new branch tip
  // sha (the seed's own sha, so no re-verify is needed), or null when creation fails.
  async function ensureLocalBranch(projectPath, baseBranch) {
    const seedCandidates = [
      `refs/remotes/origin/${baseBranch}`,
      'refs/heads/main',
      'refs/heads/master',
      'refs/remotes/origin/main',
      'refs/remotes/origin/master',
      'HEAD',
    ];
    for (const candidate of seedCandidates) {
      const verify = await run(['rev-parse', '--verify', '--quiet', candidate], projectPath);
      if (!verify.ok) continue;
      const created = await run(['branch', '--', baseBranch, candidate], projectPath);
      if (!created.ok) return null;
      return verify.out;
    }
    return null;
  }

  // Create an isolated worktree on `glissa/<teamId>/<label>`. `teamId` names the LANE ("session",
  // "pr-review"); the segment name is on-disk branch shape that boot reconciliation matches, so it
  // stays. Returns { cwd, isGit, branch, base, baseSha }; falls back to { cwd: projectPath, isGit: false }.
  function create(args) {
    return serialize(() => createBody(args));
  }
  async function createBody({ projectPath, teamId, label, baseBranch, worktreeBase, shareList }) {
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
      const ref = await run(['rev-parse', '--verify', '--quiet', `refs/heads/${baseBranch}`], projectPath);
      baseSha = ref.ok ? ref.out : await ensureLocalBranch(projectPath, baseBranch);
      if (!baseSha) return { cwd: projectPath, isGit: false, reason: 'no-base-branch' };
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
    // clean). A caller that passes no worktreeBase keeps the temp-dir default.
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

  // Junction-safe teardown of a worktree (+ its branch): the node_modules junction is removed BEFORE
  // `worktree remove` so git can never follow it into the operator's real node_modules.
  async function tearDownWorktree(projectPath, wt, branch) {
    removeWorktreeLinks(wt);
    await run(['worktree', 'remove', '--force', wt], projectPath);
    await run(['worktree', 'prune'], projectPath);
    if (branch) await run(['branch', '-D', branch], projectPath);
  }

  // Advance `target` to `branch`'s tip: an ff-only merge when `target` is the checked-out HEAD in
  // projectPath (advances the working tree too), else a direct ref update via `fetch` (no checkout of
  // the target required).
  async function fastForwardTarget(projectPath, branch, target, targetIsHead) {
    if (!targetIsHead) {
      return (await run(['fetch', '.', `refs/heads/${branch}:refs/heads/${target}`], projectPath)).ok;
    }
    return (await run(['merge', '--ff-only', branch], projectPath)).ok;
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
  async function rebaseFfBranch({ projectPath, wt, branch, target }) {
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

    // Fast-forward the integration branch to the rebased session branch.
    const head = (await run(['rev-parse', '--abbrev-ref', 'HEAD'], projectPath)).out;
    const merged = await fastForwardTarget(projectPath, branch, target, head === target);
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
  async function mergeBackBody({ projectPath, workspace, targetBranch }) {
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

    const r = await rebaseFfBranch({ projectPath, wt, branch, target });
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
  async function mergeKeepBody({ projectPath, workspace, targetBranch }) {
    const g = await resolveMergeBack({ projectPath, workspace, targetBranch });
    if (g.error) return g.error;
    const { wt, branch, target } = g;

    const r = await rebaseFfBranch({ projectPath, wt, branch, target });
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
  // id and whether it holds unmerged work. Other lanes (`glissa/pr-review/*`) are excluded by namespace.
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
    create, discard, mergeBack, mergeKeep, populate,
    listSessionWorktrees, listWorktreeBranches, removeWorktreeByPath,
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
// Async on purpose: this runs on EVERY isolated lane spawn, and a sync cmd.exe spawn or copy
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
        if (process.platform === 'win32') {
          await execFileP('cmd', ['/c', 'mklink', '/J', dst, src]);
          continue;
        }
        await fsp.symlink(src, dst, 'dir');
        continue;
      }
      await fsp.copyFile(src, dst);
    } catch { /* best-effort: the session runs without that piece */ }
  }
}

module.exports = { createGitWorkspace, createGitWorkspaceSync };
