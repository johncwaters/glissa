import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { createGitWorkspace } from '../server/git-workspace.ts';
import type { WorkspaceHandle } from '../server/git-workspace.ts';
import { hasGit, git } from './helpers/git-fixture.ts';

const GIT = hasGit();

type GitWorkspace = ReturnType<typeof createGitWorkspace>;

function initRepoOnDevelop(seedFile?: string, seedContent?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-rebase-'));
  try { git(['init', '-b', 'main'], dir); } catch { git(['init'], dir); }
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Glissa Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n', 'utf8');
  if (seedFile && seedContent) fs.writeFileSync(path.join(dir, seedFile), seedContent, 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'init'], dir);
  git(['branch', 'develop'], dir);
  git(['checkout', 'develop'], dir);
  return dir;
}

function commitFile(cwd: string, file: string, content: string, message: string): void {
  fs.writeFileSync(path.join(cwd, file), content, 'utf8');
  git(['add', '-A'], cwd);
  git(['commit', '-m', message], cwd);
}

function continueRebase(cwd: string): void {
  execFileSync('git', ['rebase', '--continue'], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_EDITOR: 'true' },
  });
}

function rebaseInProgress(wt: string): boolean {
  const gitPath = (name: string) => {
    const resolved = git(['rev-parse', '--git-path', name], wt).trim();
    return path.isAbsolute(resolved) ? resolved : path.resolve(wt, resolved);
  };
  return fs.existsSync(gitPath('rebase-merge')) || fs.existsSync(gitPath('rebase-apply'));
}

const read = (dir: string, file: string): string => fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n');

test('rebaseOnly (real git): replays the worktree onto a moved develop and leaves develop untouched', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'eager', baseBranch: 'develop' });
    commitFile(repo, 'other.js', 'other\n', 'develop advances');
    const developSha = git(['rev-parse', 'develop'], repo).trim();
    commitFile(ws.cwd, 'session.js', 'session\n', 'session work');
    const before = git(['rev-parse', 'HEAD'], ws.cwd).trim();

    const r = await gw.rebaseOnly({ projectPath: repo, workspace: ws, targetBranch: 'develop' });
    assert.equal(r.ok, true);
    assert.equal(r.rebased, true);
    assert.equal(r.rerereReplayed, false, 'no conflict, so nothing was replayed');
    assert.notEqual(r.headSha, before, 'the session commit was rewritten onto the new base');
    assert.equal(git(['rev-parse', 'HEAD'], ws.cwd).trim(), r.headSha, 'headSha is the worktree tip');
    assert.equal(git(['rev-parse', 'develop'], repo).trim(), developSha, 'develop is NOT advanced by a rebase-only');
    assert.ok(fs.existsSync(path.join(ws.cwd, 'other.js')), 'the worktree now carries the develop commit');
    assert.ok(fs.existsSync(path.join(ws.cwd, 'session.js')), 'and still carries its own work');
    assert.equal(git(['status', '--porcelain'], ws.cwd).trim(), '', 'worktree clean afterwards');
    assert.equal(git(['rev-list', '--count', 'HEAD..develop'], ws.cwd).trim(), '0', 'no longer behind');

    await gw.discard({ projectPath: repo, workspace: ws });
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('rebaseOnly (real git): a worktree already on top of develop is upToDate and rewrites nothing', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'current', baseBranch: 'develop' });
    commitFile(ws.cwd, 'session.js', 'session\n', 'session work');
    const before = git(['rev-parse', 'HEAD'], ws.cwd).trim();

    const r = await gw.rebaseOnly({ projectPath: repo, workspace: ws, targetBranch: 'develop' });
    assert.deepEqual(r, { ok: true, upToDate: true });
    assert.equal(git(['rev-parse', 'HEAD'], ws.cwd).trim(), before, 'HEAD untouched: no ref churn for a no-op');

    await gw.discard({ projectPath: repo, workspace: ws });
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('rebaseOnly (real git): a DIRTY worktree is refused and left exactly as it was', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'dirty', baseBranch: 'develop' });
    commitFile(repo, 'other.js', 'other\n', 'develop advances');
    commitFile(ws.cwd, 'session.js', 'session\n', 'session work');
    const before = git(['rev-parse', 'HEAD'], ws.cwd).trim();
    fs.writeFileSync(path.join(ws.cwd, 'wip.js'), 'work in progress\n', 'utf8');

    const r = await gw.rebaseOnly({ projectPath: repo, workspace: ws, targetBranch: 'develop' });
    assert.deepEqual(r, { ok: false, reason: 'dirty' });
    assert.equal(git(['rev-parse', 'HEAD'], ws.cwd).trim(), before, 'HEAD untouched');
    assert.equal(read(ws.cwd, 'wip.js'), 'work in progress\n', 'the uncommitted work is untouched');
    assert.ok(!fs.existsSync(path.join(ws.cwd, 'other.js')), 'nothing from develop was pulled in');

    await gw.discard({ projectPath: repo, workspace: ws });
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('rebaseOnly (real git): an unreplayable conflict aborts cleanly, reports the paths, and changes nothing', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop('conflict.txt', 'base\n');
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'cflt', baseBranch: 'develop' });
    commitFile(repo, 'conflict.txt', 'develop-side\n', 'develop edits');
    commitFile(ws.cwd, 'conflict.txt', 'session-side\n', 'session edits');
    const before = git(['rev-parse', 'HEAD'], ws.cwd).trim();

    const r = await gw.rebaseOnly({ projectPath: repo, workspace: ws, targetBranch: 'develop' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'rebase-conflict');
    assert.deepEqual(r.conflicts ?? [], ['conflict.txt'], 'the conflicting paths are captured before the abort');
    assert.equal(rebaseInProgress(ws.cwd), false, 'no rebase left in progress');
    assert.equal(git(['rev-parse', 'HEAD'], ws.cwd).trim(), before, 'HEAD untouched');
    assert.equal(read(ws.cwd, 'conflict.txt'), 'session-side\n', 'the worktree still holds its own version');
    assert.equal(git(['status', '--porcelain'], ws.cwd).trim(), '', 'and is clean, with no markers left behind');

    await gw.discard({ projectPath: repo, workspace: ws });
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('rebaseOnly (real git): a missing target branch is refused, no rebase attempted', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'notarget', baseBranch: 'develop' });
    const r = await gw.rebaseOnly({
      projectPath: repo,
      workspace: { ...ws, base: null },
      targetBranch: 'nope',
    });
    assert.deepEqual(r, { ok: false, reason: 'no-target-branch' });
    await gw.discard({ projectPath: repo, workspace: ws });
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('rebaseOnly: a non-git workspace is refused without touching git', async () => {
  const cmds: string[] = [];
  const gw = createGitWorkspace({ git: (args) => { cmds.push(args.join(' ')); return ''; } });
  assert.deepEqual(
    await gw.rebaseOnly({ projectPath: '/repo', workspace: { cwd: '/wt', isGit: false }, targetBranch: 'develop' }),
    { ok: false, reason: 'not-git' },
  );
  assert.deepEqual(cmds, [], 'no git ran');
});

async function seedRecordedResolution(gw: GitWorkspace, repo: string): Promise<{ first: WorkspaceHandle; second: WorkspaceHandle }> {
  const first = await gw.create({ projectPath: repo, teamId: 'session', label: 'first', baseBranch: 'develop' });
  const second = await gw.create({ projectPath: repo, teamId: 'session', label: 'second', baseBranch: 'develop' });
  commitFile(repo, 'conflict.txt', 'develop-side\n', 'develop edits');
  commitFile(first.cwd, 'conflict.txt', 'session-side\n', 'first session edits');
  commitFile(second.cwd, 'conflict.txt', 'session-side\n', 'second session edits');

  assert.throws(() => git(['rebase', 'develop'], first.cwd), 'the first rebase conflicts');
  fs.writeFileSync(path.join(first.cwd, 'conflict.txt'), 'both-sides\n', 'utf8');
  git(['add', 'conflict.txt'], first.cwd);
  continueRebase(first.cwd);
  return { first, second };
}

test('rerere (real git): rebaseOnly replays a resolution recorded in a sibling worktree', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop('conflict.txt', 'base\n');
  try {
    const gw = createGitWorkspace();
    const { first, second } = await seedRecordedResolution(gw, repo);
    assert.equal(git(['config', '--get', 'rerere.enabled'], repo).trim(), 'true', 'create enabled rerere for the repo');
    assert.throws(() => git(['config', '--get', 'rerere.autoUpdate'], repo), 'autoUpdate is deliberately left unset');

    const r = await gw.rebaseOnly({ projectPath: repo, workspace: second, targetBranch: 'develop' });
    assert.equal(r.ok, true);
    assert.equal(r.rebased, true);
    assert.equal(r.rerereReplayed, true, 'the success is reported as a rerere replay, not a plain rebase');
    assert.equal(read(second.cwd, 'conflict.txt'), 'both-sides\n', 'the recorded resolution was applied');
    assert.equal(rebaseInProgress(second.cwd), false, 'the rebase completed, nothing left in progress');
    assert.equal(git(['status', '--porcelain'], second.cwd).trim(), '', 'worktree clean');

    await gw.discard({ projectPath: repo, workspace: first });
    await gw.discard({ projectPath: repo, workspace: second });
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('rerere (real git): mergeBack completes instead of parking when the resolution is already recorded', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop('conflict.txt', 'base\n');
  try {
    const gw = createGitWorkspace();
    const { first, second } = await seedRecordedResolution(gw, repo);

    const r = await gw.mergeBack({ projectPath: repo, workspace: second, targetBranch: 'develop' });
    assert.equal(r.merged, true, 'the conflict was replayed, so the merge went through');
    assert.equal(r.parked, undefined);
    assert.equal(r.rerereReplayed, true);
    assert.equal(read(repo, 'conflict.txt'), 'both-sides\n', 'the resolution landed on develop');
    assert.ok(!fs.existsSync(second.cwd), 'a merged worktree is still torn down');

    await gw.discard({ projectPath: repo, workspace: first });
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('rerere: a rerere:false engine never enables it and never replays a recorded resolution', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop('conflict.txt', 'base\n');
  try {
    const gw = createGitWorkspace();
    const { first, second } = await seedRecordedResolution(gw, repo);
    const gwOff = createGitWorkspace({ rerere: false });

    const off = await gwOff.rebaseOnly({ projectPath: repo, workspace: second, targetBranch: 'develop' });
    assert.equal(off.ok, false);
    assert.equal(off.reason, 'rebase-conflict');
    assert.deepEqual(off.conflicts ?? [], ['conflict.txt']);
    assert.equal(rebaseInProgress(second.cwd), false, 'the refused rebase was aborted cleanly');

    const on = await gw.rebaseOnly({ projectPath: repo, workspace: second, targetBranch: 'develop' });
    assert.equal(on.ok, true);
    assert.equal(on.rebased, true);
    assert.equal(on.rerereReplayed, true);
    assert.equal(read(second.cwd, 'conflict.txt'), 'both-sides\n', 'the same call with the flag on replays');

    await gw.discard({ projectPath: repo, workspace: first });
    await gw.discard({ projectPath: repo, workspace: second });
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('rerere (real git): a BINARY conflict aborts and never reports success, even beside a replayable one', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop('conflict.txt', 'base\n');
  fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 4, 5, 6]));
  git(['add', '-A'], repo);
  git(['commit', '-m', 'seed binary'], repo);
  try {
    const gw = createGitWorkspace();
    const first = await gw.create({ projectPath: repo, teamId: 'session', label: 'first', baseBranch: 'develop' });
    const second = await gw.create({ projectPath: repo, teamId: 'session', label: 'second', baseBranch: 'develop' });

    fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0, 9, 9, 9, 0, 9, 9, 9]));
    commitFile(repo, 'conflict.txt', 'develop-side\n', 'develop edits');
    for (const ws of [first, second]) {
      fs.writeFileSync(path.join(ws.cwd, 'blob.bin'), Buffer.from([0, 7, 7, 7, 0, 7, 7, 7]));
      commitFile(ws.cwd, 'conflict.txt', 'session-side\n', 'session edits');
    }

    assert.throws(() => git(['rebase', 'develop'], first.cwd), 'the first rebase conflicts');
    fs.writeFileSync(path.join(first.cwd, 'conflict.txt'), 'both-sides\n', 'utf8');
    fs.writeFileSync(path.join(first.cwd, 'blob.bin'), Buffer.from([0, 7, 7, 7, 0, 7, 7, 7]));
    git(['add', '-A'], first.cwd);
    continueRebase(first.cwd);

    const headBefore = git(['rev-parse', 'HEAD'], second.cwd).trim();
    const r = await gw.rebaseOnly({ projectPath: repo, workspace: second, targetBranch: 'develop' });
    assert.equal(r.ok, false, 'a step rerere cannot fully resolve must never report success');
    assert.equal(r.reason, 'rebase-conflict');
    assert.deepEqual(r.conflicts ?? [], ['blob.bin'], 'the binary path is what still needs a carbon unit');
    assert.equal(rebaseInProgress(second.cwd), false, 'no rebase left in progress');
    assert.equal(git(['rev-parse', 'HEAD'], second.cwd).trim(), headBefore, 'the session commit survived');
    assert.equal(read(second.cwd, 'conflict.txt'), 'session-side\n', 'and its work is untouched');
    assert.deepEqual(
      [...fs.readFileSync(path.join(second.cwd, 'blob.bin'))], [0, 7, 7, 7, 0, 7, 7, 7],
      'the binary file is still the session version, not develops',
    );

    await gw.discard({ projectPath: repo, workspace: first });
    await gw.discard({ projectPath: repo, workspace: second });
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('rerere (real git): one recorded conflict beside one NEW conflict aborts, replaying neither', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop('conflict.txt', 'base\n');
  fs.writeFileSync(path.join(repo, 'other.txt'), 'base\n', 'utf8');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'seed second file'], repo);
  try {
    const gw = createGitWorkspace();
    const { first, second } = await seedRecordedResolution(gw, repo);

    commitFile(repo, 'other.txt', 'develop-other\n', 'develop edits the other file');
    commitFile(second.cwd, 'other.txt', 'session-other\n', 'session edits the other file');

    const headBefore = git(['rev-parse', 'HEAD'], second.cwd).trim();
    const r = await gw.rebaseOnly({ projectPath: repo, workspace: second, targetBranch: 'develop' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'rebase-conflict');
    assert.equal(r.rerereReplayed, undefined, 'a failed rebase reports no replay at all');
    assert.ok((r.conflicts ?? []).includes('other.txt'), 'the unrecorded conflict is what remains');
    assert.equal(git(['rev-parse', 'HEAD'], second.cwd).trim(), headBefore, 'nothing was committed');
    assert.equal(rebaseInProgress(second.cwd), false);

    await gw.discard({ projectPath: repo, workspace: first });
    await gw.discard({ projectPath: repo, workspace: second });
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('rerere (real git): a replay that empties the patch skips that commit and still completes', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop('conflict.txt', 'base\n');
  try {
    const gw = createGitWorkspace();
    const first = await gw.create({ projectPath: repo, teamId: 'session', label: 'first', baseBranch: 'develop' });
    const second = await gw.create({ projectPath: repo, teamId: 'session', label: 'second', baseBranch: 'develop' });
    commitFile(repo, 'conflict.txt', 'develop-side\n', 'develop edits');

    fs.writeFileSync(path.join(first.cwd, 'extra.txt'), 'extra\n', 'utf8');
    commitFile(first.cwd, 'conflict.txt', 'session-side\n', 'first session edits');
    commitFile(second.cwd, 'conflict.txt', 'session-side\n', 'second session edits');

    assert.throws(() => git(['rebase', 'develop'], first.cwd), 'the first rebase conflicts');
    fs.writeFileSync(path.join(first.cwd, 'conflict.txt'), 'develop-side\n', 'utf8');
    git(['add', 'conflict.txt'], first.cwd);
    continueRebase(first.cwd);

    const developSha = git(['rev-parse', 'develop'], repo).trim();
    const r = await gw.rebaseOnly({ projectPath: repo, workspace: second, targetBranch: 'develop' });
    assert.equal(r.ok, true);
    assert.equal(r.rebased, true);
    assert.equal(r.rerereReplayed, true);
    assert.equal(rebaseInProgress(second.cwd), false, 'the rebase completed rather than stranding');
    assert.equal(git(['rev-parse', 'HEAD'], second.cwd).trim(), developSha, 'the emptied commit was skipped');
    assert.equal(read(second.cwd, 'conflict.txt'), 'develop-side\n');
    assert.equal(git(['status', '--porcelain'], second.cwd).trim(), '', 'worktree clean');

    await gw.discard({ projectPath: repo, workspace: first });
    await gw.discard({ projectPath: repo, workspace: second });
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('rerere: a rerere:false engine writes no rerere config when it creates a worktree', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gwOff = createGitWorkspace({ rerere: false });
    const ws = await gwOff.create({ projectPath: repo, teamId: 'session', label: 'off', baseBranch: 'develop' });
    assert.equal(ws.isGit, true);
    assert.throws(() => git(['config', '--local', '--get', 'rerere.enabled'], repo), 'the key was never written');
    await gwOff.discard({ projectPath: repo, workspace: ws });
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('rerere: an explicit rerere.enabled=false in the repo is respected, not overwritten', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  git(['config', 'rerere.enabled', 'false'], repo);
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ projectPath: repo, teamId: 'session', label: 'opted-out', baseBranch: 'develop' });
    assert.equal(git(['config', '--get', 'rerere.enabled'], repo).trim(), 'false', 'left as the operator set it');
    assert.throws(() => git(['config', '--get', 'rerere.autoUpdate'], repo), 'autoUpdate is never written');
    await gw.discard({ projectPath: repo, workspace: ws });
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
