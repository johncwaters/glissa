'use strict';

// Worktree isolation for team runs. The fast-forward / not-fast-forward / discard paths are exercised
// against a REAL temporary git repo (skipped if git is unavailable); a final case drives the merge
// sequence through an injected git so the command order is checked even without git.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createGitWorkspace } = require('../teamlib/team-git');

function hasGit() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const GIT = hasGit();

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-gitrepo-'));
  try { git(['init', '-b', 'main'], dir); } catch { git(['init'], dir); }
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Glissa Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'init'], dir);
  return dir;
}

test('create + integrate fast-forwards the run onto the base branch and cleans up', { skip: !GIT }, async () => {
  const repo = initRepo();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'marketing', label: '2026-06-02-tue', outputPath: 'team/marketing' });
    assert.equal(ws.isGit, true);
    assert.ok(ws.cwd && ws.cwd !== repo, 'runs in a separate worktree directory');

    const runRel = 'team/marketing/runs/2026-06-02-tue';
    fs.mkdirSync(path.join(ws.cwd, runRel), { recursive: true });
    fs.writeFileSync(path.join(ws.cwd, runRel, 'brief.md'), '## Topic\nx\n', 'utf8');

    const r = await gw.integrate({ projectPath: repo, workspace: ws, message: 'marketing run', addPaths: [runRel] });
    assert.equal(r.committed, true);
    assert.equal(r.merged, true);
    assert.equal(r.branch, null, 'branch deleted after a successful merge');

    assert.ok(fs.existsSync(path.join(repo, runRel, 'brief.md')), 'run is merged into the working tree');
    assert.equal(git(['status', '--porcelain'], repo).trim(), '', 'working tree clean after merge');
    assert.equal(git(['branch', '--list', ws.branch], repo).trim(), '', 'run branch deleted');
    assert.ok(!fs.existsSync(ws.cwd), 'worktree removed');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('integrate keeps the run on its branch when the base moved (not a fast-forward)', { skip: !GIT }, async () => {
  const repo = initRepo();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'marketing', label: 'r1', outputPath: 'team/marketing' });

    // Base advances after the worktree was created, so a fast-forward is no longer possible.
    fs.writeFileSync(path.join(repo, 'other.md'), 'changed\n', 'utf8');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'base advances'], repo);

    const runRel = 'team/marketing/runs/r1';
    fs.mkdirSync(path.join(ws.cwd, runRel), { recursive: true });
    fs.writeFileSync(path.join(ws.cwd, runRel, 'brief.md'), 'x', 'utf8');

    const r = await gw.integrate({ projectPath: repo, workspace: ws, message: 'run', addPaths: [runRel] });
    assert.equal(r.committed, true);
    assert.equal(r.merged, false);
    assert.equal(r.reason, 'not-fast-forward');
    assert.equal(r.branch, ws.branch, 'run kept on its branch for a manual merge');
    assert.ok(git(['branch', '--list', ws.branch], repo).trim(), 'branch still exists');
    assert.ok(!fs.existsSync(path.join(repo, runRel, 'brief.md')), 'unmerged run is not in the working tree');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// Regression: the pre-worktree setup gate writes an untracked log.md (and a crashed prior run can
// leave an untracked run folder) into the PROJECT tree. The branch tracks those same paths, so a naive
// `merge --ff-only` aborts ("untracked working tree files would be overwritten") and strands the whole
// run on its branch. integrate must clear those scoped untracked collisions and complete the merge.
test('integrate clears an untracked log.md collision in the project tree and still fast-forwards', { skip: !GIT }, async () => {
  const repo = initRepo();
  try {
    const gw = createGitWorkspace();
    const outputPath = '.glissa/teams/release-notes';
    const ws = await gw.create({ projectPath: repo, teamId: 'release-notes', label: '2026-06-04-thursday', outputPath });

    // Simulate the pre-worktree gate: a header-only log.md is left UNTRACKED in the project tree.
    const logRel = `${outputPath}/log.md`;
    fs.mkdirSync(path.join(repo, outputPath), { recursive: true });
    fs.writeFileSync(path.join(repo, logRel), '# Team run log\n', 'utf8');
    // A user file that also sits untracked under the output path must NOT be removed (not on the branch).
    const packRel = `${outputPath}/pack/voice-guide.md`;
    fs.mkdirSync(path.join(repo, outputPath, 'pack'), { recursive: true });
    fs.writeFileSync(path.join(repo, packRel), 'voice\n', 'utf8');

    // The run, built in the worktree: a fuller log.md (header + run line) + the dated run folder.
    const runRel = `${outputPath}/runs/2026-06-04-thursday`;
    fs.mkdirSync(path.join(ws.cwd, runRel), { recursive: true });
    fs.writeFileSync(path.join(ws.cwd, runRel, 'notes.md'), '## Release\nx\n', 'utf8');
    fs.writeFileSync(path.join(ws.cwd, logRel), '# Team run log\n2026-06-04 | v0.14.0 | - | SHIP\n', 'utf8');

    const r = await gw.integrate({ projectPath: repo, workspace: ws, message: 'release-notes run', addPaths: [runRel, logRel] });
    assert.equal(r.committed, true);
    assert.equal(r.merged, true, 'the untracked log.md no longer blocks the fast-forward');
    assert.equal(r.branch, null, 'branch deleted after a successful merge');

    assert.ok(fs.existsSync(path.join(repo, runRel, 'notes.md')), 'run folder merged into the working tree');
    assert.equal(
      fs.readFileSync(path.join(repo, logRel), 'utf8').replace(/\r\n/g, '\n'),
      '# Team run log\n2026-06-04 | v0.14.0 | - | SHIP\n',
      'log.md is now the branch (tracked) version',
    );
    assert.ok(fs.existsSync(path.join(repo, packRel)), 'the untracked pack file (not on the branch) is left untouched');
    assert.equal(git(['status', '--porcelain', '--', outputPath], repo).trim(), '?? .glissa/teams/release-notes/pack/', 'only the pack stays untracked; the run + log are committed');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('discard removes the worktree and the branch', { skip: !GIT }, async () => {
  const repo = initRepo();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'marketing', label: 'r2', outputPath: 'team/marketing' });
    assert.ok(fs.existsSync(ws.cwd));
    await gw.discard({ projectPath: repo, workspace: ws });
    assert.ok(!fs.existsSync(ws.cwd), 'worktree removed');
    assert.equal(git(['branch', '--list', ws.branch], repo).trim(), '', 'branch deleted');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// G1: create() copies BOTH the team-local pack and the project-level shared pack (.glissa/pack/) into the
// worktree so stages can read shared-scope files (voice/brand). Both are untracked in the project and are
// never staged by integrate, so they vanish with the worktree.
test('G1: create copies the team-local pack AND the shared .glissa/pack into the worktree', { skip: !GIT }, async () => {
  const repo = initRepo();
  try {
    const outputPath = '.glissa/teams/marketing';
    fs.mkdirSync(path.join(repo, outputPath, 'pack'), { recursive: true });
    fs.writeFileSync(path.join(repo, outputPath, 'pack', 'content-calendar.md'), 'cal\n', 'utf8');
    fs.mkdirSync(path.join(repo, '.glissa', 'pack'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.glissa', 'pack', 'voice-guide.md'), 'shared voice\n', 'utf8');

    const gw = createGitWorkspace();
    const ws = await gw.create({
      projectPath: repo, teamId: 'marketing', label: 'r', outputPath,
    });
    assert.equal(ws.isGit, true);
    assert.ok(fs.existsSync(path.join(ws.cwd, outputPath, 'pack', 'content-calendar.md')), 'team-local pack copied in');
    assert.ok(fs.existsSync(path.join(ws.cwd, '.glissa', 'pack', 'voice-guide.md')), 'shared pack copied in');
    await gw.discard({ projectPath: repo, workspace: ws });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// G1b: an absent shared pack is a no-op (no throw); the team-local pack still copies.
test('G1b: create does not throw when .glissa/pack is absent', { skip: !GIT }, async () => {
  const repo = initRepo();
  try {
    const outputPath = '.glissa/teams/qa';
    fs.mkdirSync(path.join(repo, outputPath, 'pack'), { recursive: true });
    fs.writeFileSync(path.join(repo, outputPath, 'pack', 'how-to-run.md'), 'run\n', 'utf8');
    const gw = createGitWorkspace();
    const ws = await gw.create({
      projectPath: repo, teamId: 'qa', label: 'r', outputPath,
    });
    assert.equal(ws.isGit, true);
    assert.ok(!fs.existsSync(path.join(ws.cwd, '.glissa', 'pack')), 'no shared pack created when absent');
    assert.ok(fs.existsSync(path.join(ws.cwd, outputPath, 'pack', 'how-to-run.md')), 'team-local pack still copied');
    await gw.discard({ projectPath: repo, workspace: ws });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('create falls back to in-place for a non-git directory', { skip: !GIT }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-nongit-'));
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: dir, teamId: 'marketing', label: 'r', outputPath: 'team/marketing' });
    assert.equal(ws.isGit, false);
    assert.equal(ws.cwd, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('integrate (injected git) commits, ff-merges, removes the worktree, deletes the branch', async () => {
  const cmds = [];
  const fakeGit = (args) => {
    cmds.push(args.join(' '));
    // `git diff --cached --quiet` exits non-zero when there are staged changes.
    if (args[0] === 'diff' && args.includes('--cached')) { const e = new Error('staged'); e.status = 1; throw e; }
    return '';
  };
  const gw = createGitWorkspace({ git: fakeGit });
  const ws = { cwd: '/wt', isGit: true, branch: 'glissa/marketing/r', base: 'main' };
  const r = await gw.integrate({ projectPath: '/repo', workspace: ws, message: 'm', addPaths: ['team/marketing/runs/r'] });

  assert.equal(r.committed, true);
  assert.equal(r.merged, true);
  assert.equal(r.branch, null);
  assert.ok(cmds.includes('add -- team/marketing/runs/r'));
  assert.ok(cmds.some((c) => c.startsWith('commit -m')));
  assert.ok(cmds.includes('merge --ff-only glissa/marketing/r'));
  assert.ok(cmds.includes('worktree remove --force /wt'));
  assert.ok(cmds.includes('branch -D glissa/marketing/r'));
});

// --- serialize queue: cross-session merges into the same target never interleave (REQUIRED) ----------

// The async engine dissolved the old synchronous de-facto global lock; the explicit serialize queue must
// replace it. Two concurrent mutating calls on ONE engine instance must run STRICTLY sequentially: the
// second method's FIRST git command must not fire until the first method has fully resolved. The first
// runner invocation is held on a deferred promise so the ordering is observable.
test('serialize: two concurrent mutating calls on one engine run strictly sequentially', async () => {
  const cmds = [];
  let releaseFirst;
  const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
  let firstCall = true;
  const git = async (args) => {
    cmds.push(args.join(' '));
    if (firstCall) { firstCall = false; await firstHeld; } // hold the very first git call open
    if (args[0] === 'diff' && args.includes('--cached')) { const e = new Error('staged'); e.status = 1; throw e; }
    return '';
  };
  const gw = createGitWorkspace({ git });
  const wsA = { cwd: '/wtA', isGit: true, branch: 'glissa/session/a', base: 'develop' };
  const wsB = { cwd: '/wtB', isGit: true, branch: 'glissa/session/b', base: 'develop' };

  // Fire both integrates without awaiting; the first is wedged on firstHeld inside its first git call.
  const pA = gw.integrate({ projectPath: '/repo', workspace: wsA, message: 'a', addPaths: ['runs/a'] });
  const pB = gw.integrate({ projectPath: '/repo', workspace: wsB, message: 'b', addPaths: ['runs/b'] });

  // Let microtasks settle: only the FIRST method's first git call has fired; the second is queued behind it.
  await new Promise((r) => setImmediate(r));
  assert.equal(cmds.length, 1, 'only the first serialized body has started while it is held');
  assert.ok(cmds[0].startsWith('add -- runs/a'), 'the first call belongs to method A');
  assert.ok(!cmds.some((c) => c.includes('runs/b')), 'method B has not issued any git command yet');

  releaseFirst(); // unwedge A; it runs to completion, then B is dequeued
  await Promise.all([pA, pB]);
  assert.ok(cmds.some((c) => c.includes('runs/b')), 'method B ran only after A fully resolved');
  // A's full command sequence precedes B's first command (strict serialization, no interleave).
  const firstBIdx = cmds.findIndex((c) => c.includes('runs/b'));
  const lastAIdx = cmds.map((c) => c.includes('runs/a') || c.includes('/wtA') || c.includes('glissa/session/a')).lastIndexOf(true);
  assert.ok(lastAIdx < firstBIdx, 'every command of A precedes the first command of B');
});

// --- writeScope staging via integrate (the SHIP-gated auto-merge boundary), falsifiable injected git ---

// A recording fake git that mirrors real git's two relevant exit behaviors: `diff --cached --quiet`
// throws when there ARE staged changes, and a DESIGNATED no-match `add -- <noMatchGlob>` throws
// {status:128} (a glob that matches nothing). Everything else returns ''.
function recordingGit(cmds, { noMatchGlob = null } = {}) {
  return (args) => {
    cmds.push(args.join(' '));
    if (args[0] === 'diff' && args.includes('--cached')) { const e = new Error('staged'); e.status = 1; throw e; }
    if (noMatchGlob && args[0] === 'add' && args[args.length - 1] === noMatchGlob) {
      const e = new Error(`pathspec '${noMatchGlob}' did not match any files`); e.status = 128; throw e;
    }
    return '';
  };
}

test('integrate stages a matching writeScope glob and the commit fires', async () => {
  const cmds = [];
  const gw = createGitWorkspace({ git: recordingGit(cmds) });
  const ws = { cwd: '/wt', isGit: true, branch: 'glissa/qa/r', base: 'main' };
  const r = await gw.integrate({
    projectPath: '/repo', workspace: ws, message: 'qa: r (SHIP)',
    addPaths: ['.glissa/teams/qa/runs/r', '.glissa/teams/qa/log.md', 'src/**'],
  });
  assert.ok(cmds.includes('add -- src/**'), 'the writeScope glob is passed verbatim to git add');
  assert.equal(r.committed, true);
  assert.ok(cmds.some((c) => c.startsWith('commit -m')), 'a commit was issued');
  assert.equal(r.merged, true);
  assert.ok(cmds.includes('merge --ff-only glissa/qa/r'));
});

test('integrate: a no-match writeScope add throws {status:128} but the commit STILL fires from run folder + log', async () => {
  const cmds = [];
  const gw = createGitWorkspace({ git: recordingGit(cmds, { noMatchGlob: 'src/**' }) });
  const ws = { cwd: '/wt', isGit: true, branch: 'glissa/qa/r', base: 'main' };
  const r = await gw.integrate({
    projectPath: '/repo', workspace: ws, message: 'qa: r (SHIP)',
    addPaths: ['.glissa/teams/qa/runs/r', '.glissa/teams/qa/log.md', 'src/**'],
  });
  assert.ok(cmds.includes('add -- src/**'), 'the no-match glob was still attempted');
  assert.equal(r.committed, true, 'run folder + log carried staged content despite the throw');
  assert.ok(cmds.some((c) => c.startsWith('commit -m')));
  assert.equal(r.merged, true);
});

test('integrate: order-independence, a no-match glob FIRST still commits', async () => {
  const cmds = [];
  const gw = createGitWorkspace({ git: recordingGit(cmds, { noMatchGlob: 'src/**' }) });
  const ws = { cwd: '/wt', isGit: true, branch: 'glissa/qa/r', base: 'main' };
  const r = await gw.integrate({
    projectPath: '/repo', workspace: ws, message: 'qa: r (SHIP)',
    addPaths: ['src/**', '.glissa/teams/qa/runs/r', '.glissa/teams/qa/log.md'],
  });
  assert.equal(r.committed, true, 'a leading no-match glob does not abort the commit');
  assert.equal(r.merged, true);
});

// --- restoreTests: the restore-before-audit oracle reset (command shape via injected git) ---

test('restoreTests issues a per-glob checkout <baseSha> then a per-glob clean -f (testGlob-scoped, in order)', async () => {
  const cmds = [];
  const gw = createGitWorkspace({ git: (args) => { cmds.push(args.join(' ')); return ''; } });
  const testGlobs = ['**/*.test.*', '**/test/**'];
  await gw.restoreTests({ workspace: { cwd: '/wt', isGit: true, baseSha: 'base123' }, testGlobs });

  // Every glob is checked out at baseSha, then every glob is cleaned; checkout precedes clean.
  for (const g of testGlobs) {
    assert.ok(cmds.includes(`checkout base123 -- ${g}`), `checkout for ${g}`);
    assert.ok(cmds.includes(`clean -f -- ${g}`), `clean for ${g}`);
  }
  const firstClean = cmds.findIndex((c) => c.startsWith('clean'));
  const lastCheckout = cmds.map((c) => c.startsWith('checkout')).lastIndexOf(true);
  assert.ok(lastCheckout < firstClean, 'all checkouts precede the first clean');
  // No combined call: each pathspec is its own argv (per-glob, so a no-match cannot abort the batch).
  assert.ok(!cmds.some((c) => c.includes('**/*.test.* **/test/**')), 'globs are not batched into one call');
});

test('restoreTests is a no-op when not git, no baseSha, or empty testGlobs', async () => {
  const cmds = [];
  const gw = createGitWorkspace({ git: (args) => { cmds.push(args.join(' ')); return ''; } });
  await gw.restoreTests({ workspace: { cwd: '/wt', isGit: false, baseSha: 'b' }, testGlobs: ['**/*.test.*'] });
  await gw.restoreTests({ workspace: { cwd: '/wt', isGit: true }, testGlobs: ['**/*.test.*'] }); // no baseSha
  await gw.restoreTests({ workspace: { cwd: '/wt', isGit: true, baseSha: 'b' }, testGlobs: [] });
  assert.equal(cmds.length, 0, 'no git command issued in any no-op case');
});

test('restoreTests swallows a no-match checkout (no throw propagates)', async () => {
  const gw = createGitWorkspace({
    git: (args) => {
      if (args[0] === 'checkout') { const e = new Error('did not match'); e.status = 128; throw e; }
      return '';
    },
  });
  // Must not reject even though every checkout throws 128 (no-match), mirroring real git. The sync throw
  // inside `await git(...)` rejects into run()'s catch, so the engine method still resolves cleanly.
  await assert.doesNotReject(gw.restoreTests({
    workspace: { cwd: '/wt', isGit: true, baseSha: 'b' }, testGlobs: ['nope/**'],
  }));
});

// Real-git restore-before-audit end to end: a fixer that edits a tracked test, adds an untracked NEW test
// under a new dir, AND writes a source file + a run folder. After restoreTests the tracked test is back to
// base, the untracked new test is gone, and the source file + the run folder survive (clean is scoped).
test('restoreTests (real git) restores tracked tests, removes untracked new tests, keeps source + run folder', { skip: !GIT }, async () => {
  const repo = initRepo();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'qa', label: 'r', outputPath: '.glissa/teams/qa' });
    assert.equal(ws.isGit, true);

    // Seed a tracked test in the worktree and commit it so it is part of the base the run branched from.
    const trackedTest = path.join(ws.cwd, 'tests', 'keep.test.js');
    fs.mkdirSync(path.dirname(trackedTest), { recursive: true });
    fs.writeFileSync(trackedTest, 'ORIGINAL\n', 'utf8');
    git(['add', '-A'], ws.cwd);
    git(['commit', '-m', 'tracked test'], ws.cwd);
    const baseSha = git(['rev-parse', 'HEAD'], ws.cwd).trim();
    const workspace = { ...ws, baseSha };

    // Fixer tampers: edit the tracked test, add an untracked NEW test in a new dir, write source, write a run folder.
    fs.writeFileSync(trackedTest, 'TAMPERED\n', 'utf8');
    const newTest = path.join(ws.cwd, 'tests', '__tests__', 'fresh.test.js');
    fs.mkdirSync(path.dirname(newTest), { recursive: true });
    fs.writeFileSync(newTest, 'trivially passes\n', 'utf8');
    const srcFile = path.join(ws.cwd, 'src', 'app.js');
    fs.mkdirSync(path.dirname(srcFile), { recursive: true });
    fs.writeFileSync(srcFile, 'real source fix\n', 'utf8');
    const runArtifact = path.join(ws.cwd, '.glissa', 'teams', 'qa', 'runs', 'r0', 'review.md');
    fs.mkdirSync(path.dirname(runArtifact), { recursive: true });
    fs.writeFileSync(runArtifact, 'run artifact\n', 'utf8');

    const testGlobs = ['**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**', '**/__tests__/**'];
    await gw.restoreTests({ workspace, testGlobs });

    // Normalize CRLF: git autocrlf may rewrite line endings on checkout (Windows); the restore reverting
    // the TAMPERED content to base is what matters here, not the platform line ending.
    const norm = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    assert.equal(norm(trackedTest), 'ORIGINAL\n', 'tracked test restored to base');
    assert.ok(!fs.existsSync(newTest), 'untracked new test removed by the scoped clean');
    assert.ok(fs.existsSync(srcFile), 'out-of-scope source survives');
    assert.equal(norm(srcFile), 'real source fix\n', 'source content untouched');
    assert.ok(fs.existsSync(runArtifact), 'run folder under .glissa/ survives the scoped clean');

    await gw.discard({ projectPath: repo, workspace: ws });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// Real-git writeScope e2e: a source file under src/ merges into the base working tree on integrate; and a
// companion where src/** matches nothing yet the run folder still merges (no-match add is harmless).
test('integrate (real git) lands a src/** file in the base working tree and merges cleanly', { skip: !GIT }, async () => {
  const repo = initRepo();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'qa', label: 'r', outputPath: '.glissa/teams/qa' });

    const runRel = '.glissa/teams/qa/runs/r';
    fs.mkdirSync(path.join(ws.cwd, runRel), { recursive: true });
    fs.writeFileSync(path.join(ws.cwd, runRel, 'review.md'), '## Summary\nx\n', 'utf8');
    const srcRel = path.join('src', 'fix.js');
    fs.mkdirSync(path.join(ws.cwd, 'src'), { recursive: true });
    fs.writeFileSync(path.join(ws.cwd, srcRel), 'module.exports = 1;\n', 'utf8');

    const r = await gw.integrate({
      projectPath: repo, workspace: ws, message: 'qa: r (SHIP)', addPaths: [runRel, 'src/**'],
    });
    assert.equal(r.committed, true);
    assert.equal(r.merged, true);
    assert.ok(fs.existsSync(path.join(repo, srcRel)), 'the src fix landed in the base working tree');
    assert.equal(git(['status', '--porcelain'], repo).trim(), '', 'working tree clean after merge');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('integrate (real git) with a no-match src/** still merges the run folder', { skip: !GIT }, async () => {
  const repo = initRepo();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'qa', label: 'r2', outputPath: '.glissa/teams/qa' });

    const runRel = '.glissa/teams/qa/runs/r2';
    fs.mkdirSync(path.join(ws.cwd, runRel), { recursive: true });
    fs.writeFileSync(path.join(ws.cwd, runRel, 'review.md'), '## Summary\nx\n', 'utf8');

    // No file under src/, so 'add -- src/**' matches nothing (throws 128, swallowed).
    const r = await gw.integrate({
      projectPath: repo, workspace: ws, message: 'qa: r2 (BLOCK)', addPaths: [runRel, 'src/**'],
    });
    assert.equal(r.committed, true, 'run folder carried the commit despite the no-match glob');
    assert.equal(r.merged, true);
    assert.ok(fs.existsSync(path.join(repo, runRel, 'review.md')), 'run folder merged into the base tree');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
