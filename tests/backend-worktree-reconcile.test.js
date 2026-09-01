'use strict';

// reconcileSessionWorktrees: the boot pass over the on-disk glissa/session/* worktrees a prior run left
// behind. Its whole job is deciding, per worktree, between adopt / keep / remove without ever destroying
// work or stranding a resumable session - including the survive-shutdown case, where a CLEAN worktree
// whose session is still tracked must be handed back to that session (auto-resume then re-enters the same
// tree) instead of removed. Driven directly with fakes (module-level export, same pattern as
// carryWorktreeAcrossRecreate / decideWasActiveFlip): booting createBackend to reach the real pass would
// delete the checkout's own session worktrees.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { reconcileSessionWorktrees, createBackend } = require('../server/backend.ts');
const { createGitWorkspace } = require('../server/git-workspace.ts');
const { hasGit, git } = require('./helpers/git-fixture');

const GIT = hasGit();

// A throwaway repo checked out on the integration branch, the shape the boot reconcile expects.
function initRepoOnDevelop() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-reconcile-repo-'));
  try { git(['init', '-b', 'main'], dir); } catch { git(['init'], dir); }
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Glissa Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n', 'utf8');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'init'], dir);
  git(['branch', 'develop'], dir);
  git(['checkout', 'develop'], dir);
  return dir;
}

function fakeSession(name, sessionProjectPath = 'C:/proj') {
  const adopted = [];
  return { name, path: sessionProjectPath, adopted, adoptWorktree(args) { adopted.push(args); } };
}

// Mirrors the shape gitWorkspaceSync.listSessionWorktrees yields per worktree (server/git-workspace.js).
function worktreeEntry({ id, hasWork = false, integrationBranch }) {
  return {
    id,
    cwd: `C:/wts/proj-${id}`,
    branch: `glissa/session/${id}`,
    hasWork,
    ...(integrationBranch ? { integrationBranch } : {}),
  };
}

function fakeEngine(byProjectPath) {
  const removed = [];
  const listed = [];
  return {
    removed,
    listed,
    listSessionWorktrees({ projectPath, integrationBranch }) {
      listed.push({ projectPath, integrationBranch });
      return byProjectPath[projectPath] || [];
    },
    removeWorktreeByPath(args) { removed.push(args); },
  };
}

function run({ projects, sessions, engine, integrationBranch = 'develop', onAdopt, worktreeDirExists = () => true }) {
  reconcileSessionWorktrees({
    projects, sessions, gitWorkspaceSync: engine, integrationBranch, onAdopt, worktreeDirExists,
    log: () => {}, warn: () => {},
  });
}

test('CLEAN + claimed: adopted ungated (no review banner) and NOT removed - the survive-shutdown case', () => {
  const sess = fakeSession('alpha');
  const engine = fakeEngine({ 'C:/proj': [worktreeEntry({ id: 'sess-1', hasWork: false })] });
  const adoptedSessions = [];
  run({
    projects: [{ id: 'sess-1', path: 'C:/proj' }],
    sessions: new Map([['sess-1', sess]]),
    engine,
    onAdopt: (s) => adoptedSessions.push(s.name),
  });
  assert.equal(sess.adopted.length, 1, 'the clean tree is handed back to its session');
  assert.deepEqual(sess.adopted[0], {
    worktreeDir: 'C:/wts/proj-sess-1',
    branch: 'glissa/session/sess-1',
    base: 'develop',
    hasUnmergedWork: false,
  });
  assert.deepEqual(engine.removed, [], 'a claimed worktree is never removed');
  assert.deepEqual(adoptedSessions, ['alpha'], 'onAdopt fires so the integration-ref watcher is armed');
});

test('DIRTY + claimed: adopted as pending-review (unchanged behavior)', () => {
  const sess = fakeSession('alpha');
  const engine = fakeEngine({ 'C:/proj': [worktreeEntry({ id: 'sess-1', hasWork: true })] });
  run({ projects: [{ id: 'sess-1', path: 'C:/proj' }], sessions: new Map([['sess-1', sess]]), engine });
  assert.equal(sess.adopted.length, 1);
  assert.equal(sess.adopted[0].hasUnmergedWork, true, 'unmerged work still raises the review gate');
  assert.deepEqual(engine.removed, []);
});

test('CLEAN + unclaimed: removed junction-safe (a true leftover orphan)', () => {
  const engine = fakeEngine({ 'C:/proj': [worktreeEntry({ id: 'gone-1', hasWork: false })] });
  run({ projects: [{ id: 'sess-1', path: 'C:/proj' }], sessions: new Map(), engine });
  assert.deepEqual(engine.removed, [{
    projectPath: 'C:/proj', cwd: 'C:/wts/proj-gone-1', branch: 'glissa/session/gone-1',
  }]);
});

test('DIRTY + unclaimed: kept - neither adopted nor removed (no data loss without an owner)', () => {
  const engine = fakeEngine({ 'C:/proj': [worktreeEntry({ id: 'gone-1', hasWork: true })] });
  run({ projects: [{ id: 'sess-1', path: 'C:/proj' }], sessions: new Map(), engine });
  assert.deepEqual(engine.removed, [], 'unclaimed uncommitted work is left for manual review');
});

test('CLEAN + claimed but the directory vanished: pruned, not adopted onto a dead path', () => {
  const sess = fakeSession('alpha');
  const engine = fakeEngine({ 'C:/proj': [worktreeEntry({ id: 'sess-1', hasWork: false })] });
  run({
    projects: [{ id: 'sess-1', path: 'C:/proj' }],
    sessions: new Map([['sess-1', sess]]),
    engine,
    worktreeDirExists: () => false,
  });
  assert.equal(sess.adopted.length, 0, 'a nonexistent tree is never handed to a session');
  assert.deepEqual(engine.removed.map((r) => r.branch), ['glissa/session/sess-1'], 'the stale registration is pruned');
});

test('claimed but the session now lives in a DIFFERENT repo: dirty kept, clean removed, never adopted', () => {
  const movedDirty = fakeSession('moved-dirty', 'C:/other-repo');
  const movedClean = fakeSession('moved-clean', 'C:/other-repo');
  const engine = fakeEngine({
    'C:/proj': [
      worktreeEntry({ id: 'sess-1', hasWork: true }),
      worktreeEntry({ id: 'sess-2', hasWork: false }),
    ],
  });
  run({
    projects: [{ id: 'sess-1', path: 'C:/proj' }],
    sessions: new Map([['sess-1', movedDirty], ['sess-2', movedClean]]),
    engine,
  });
  assert.equal(movedDirty.adopted.length, 0, 'a wrong-repo tree must not be adopted');
  assert.equal(movedClean.adopted.length, 0);
  assert.deepEqual(engine.removed.map((r) => r.branch), ['glissa/session/sess-2'], 'clean wrong-repo tree treated as orphan');
});

test('base comes from the worktree marker when present, else the configured integration branch', () => {
  const marked = fakeSession('marked');
  const plain = fakeSession('plain');
  const engine = fakeEngine({
    'C:/proj': [
      worktreeEntry({ id: 'sess-1', hasWork: true, integrationBranch: 'release/2.0' }),
      worktreeEntry({ id: 'sess-2', hasWork: true }),
    ],
  });
  run({
    projects: [{ id: 'sess-1', path: 'C:/proj' }],
    sessions: new Map([['sess-1', marked], ['sess-2', plain]]),
    engine,
  });
  assert.equal(marked.adopted[0].base, 'release/2.0');
  assert.equal(plain.adopted[0].base, 'develop');
});

test('each repo root is visited once and a project with no path is skipped', () => {
  const engine = fakeEngine({ 'C:/proj': [] });
  run({
    projects: [
      { id: 'sess-1', path: 'C:/proj' },
      { id: 'sess-2', path: 'C:/proj' },
      { id: 'sess-3' },
    ],
    sessions: new Map(),
    engine,
  });
  assert.deepEqual(engine.listed, [{ projectPath: 'C:/proj', integrationBranch: 'develop' }]);
});

test('a mixed repo resolves every worktree independently in one pass', () => {
  const dirtyOwner = fakeSession('dirty-owner');
  const cleanOwner = fakeSession('clean-owner');
  const engine = fakeEngine({
    'C:/proj': [
      worktreeEntry({ id: 'sess-1', hasWork: true }),
      worktreeEntry({ id: 'sess-2', hasWork: false }),
      worktreeEntry({ id: 'orphan-clean', hasWork: false }),
      worktreeEntry({ id: 'orphan-dirty', hasWork: true }),
    ],
  });
  run({
    projects: [{ id: 'sess-1', path: 'C:/proj' }],
    sessions: new Map([['sess-1', dirtyOwner], ['sess-2', cleanOwner]]),
    engine,
  });
  assert.equal(dirtyOwner.adopted[0].hasUnmergedWork, true);
  assert.equal(cleanOwner.adopted[0].hasUnmergedWork, false);
  assert.deepEqual(engine.removed.map((r) => r.branch), ['glissa/session/orphan-clean']);
});

// The fakes above prove the DECISIONS; this proves the pass is actually WIRED INTO BOOT (it was inline in
// createBackend before the extraction, so a broken hand-off would silently leak every worktree forever).
// Observable at boot without reaching into createBackend: an unclaimed clean worktree is removed from disk
// while an unclaimed dirty one survives.
// SAFETY: pointed at a THROWAWAY temp repo via GLISSA_CONFIG, never the real config. The boot reconcile
// deletes glissa/session/* worktrees, and this checkout is itself one (memory:
// backend-boot-reconcile-worktree-hazard). Keep the only project in this config a temp repo.
test('boot wiring: createBackend runs the reconcile (clean orphan removed, dirty orphan kept)', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  const worktreeBase = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-reconcile-wts-'));
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-reconcile-cfg-'));
  const prevEnv = process.env.GLISSA_CONFIG;
  let backend = null;
  let server = null;
  try {
    const gw = createGitWorkspace();
    const cleanWorktree = await gw.create({ projectPath: repo, teamId: 'session', label: 'orphan-clean', baseBranch: 'develop', worktreeBase });
    const dirtyWorktree = await gw.create({ projectPath: repo, teamId: 'session', label: 'orphan-dirty', baseBranch: 'develop', worktreeBase });
    fs.writeFileSync(path.join(dirtyWorktree.cwd, 'wip.js'), 'work in progress\n', 'utf8');

    const cfgPath = path.join(cfgDir, 'config.json');
    // The project id claims NEITHER worktree, so both are orphans and no Session spawns at boot.
    fs.writeFileSync(cfgPath, JSON.stringify({
      projects: [{ id: 'claims-neither-worktree', name: 'temp-repo', path: repo }],
      teams: [], repoRoots: [], integrationBranch: 'develop', checkForUpdates: false,
    }, null, 2), 'utf8');
    process.env.GLISSA_CONFIG = cfgPath;

    server = http.createServer();
    backend = createBackend(server, { staticDir: null });

    assert.ok(!fs.existsSync(cleanWorktree.cwd), 'boot removed the clean orphan worktree');
    assert.ok(fs.existsSync(path.join(dirtyWorktree.cwd, 'wip.js')), 'boot kept the orphan holding unmerged work');
  } finally {
    if (backend) backend.shutdown();
    if (prevEnv == null) delete process.env.GLISSA_CONFIG;
    if (prevEnv != null) process.env.GLISSA_CONFIG = prevEnv;
    fs.rmSync(worktreeBase, { recursive: true, force: true });
    fs.rmSync(cfgDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
