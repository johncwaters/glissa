'use strict';

// Unit tests for session/core/conversation-history.js: the cross-worktree Claude conversation
// discovery used by the per-card "Resume conversation" picker. Exercises the project-dir encoding,
// the worktree-set walk (injected git), title extraction, newest-first ordering, and id de-dup.
// Uses a real temp projects dir (so the bounded head-read + stat path is exercised) with an injected
// git runner that returns a porcelain worktree listing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  encodeProjectDir,
  listRepoConversations,
  cleanTitle,
} = require('../session/core/conversation-history');

test('encodeProjectDir matches Claude\'s scheme (every non-alnum -> dash, case preserved)', () => {
  assert.equal(encodeProjectDir('C:\\Users\\johnw\\Projects\\glissa'), 'C--Users-johnw-Projects-glissa');
  assert.equal(
    encodeProjectDir('C:\\Users\\johnw\\Projects\\.glissa-worktrees\\glissa-hROPKt'),
    'C--Users-johnw-Projects--glissa-worktrees-glissa-hROPKt',
  );
  // A forward-slash path (as `git worktree list` prints on Windows) encodes identically to backslash.
  assert.equal(encodeProjectDir('C:/Users/johnw/Projects/glissa'), encodeProjectDir('C:\\Users\\johnw\\Projects\\glissa'));
  // Lowercase drive letter is preserved (only non-alnum is replaced).
  assert.equal(encodeProjectDir('c:/x'), 'c--x');
});

test('cleanTitle prefers command-args and strips command wrappers', () => {
  const raw = '<command-message>oh-my-claudecode:autopilot</command-message>\n<command-name>/x</command-name>\n<command-args>add resume across worktrees</command-args>';
  assert.equal(cleanTitle(raw), 'add resume across worktrees');
  assert.equal(cleanTitle('  plain   prose\nhere  '), 'plain prose here');
  assert.ok(cleanTitle('x'.repeat(200)).length <= 100);
});

function writeTranscript(dir, id, { title, cwd, branch, mtimeMs }) {
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'attachment', cwd, gitBranch: branch, sessionId: id }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: title } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'ok' } }),
  ];
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  if (mtimeMs != null) fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

test('listRepoConversations walks the repo worktree set, newest-first, with extracted titles', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-convtest-'));
  const projectsDir = path.join(root, 'projects');

  const wtMain = 'C:/fake/repo';
  const wtFeat = 'C:/fake/repo/.wt/featureX';
  const gitFake = async (args) => {
    assert.deepEqual(args, ['worktree', 'list', '--porcelain']);
    return [
      `worktree ${wtMain}`, 'HEAD aaa', 'branch refs/heads/main', '',
      `worktree ${wtFeat}`, 'HEAD bbb', 'branch refs/heads/feature/x', '',
    ].join('\n');
  };

  const dirMain = path.join(projectsDir, encodeProjectDir(wtMain));
  const dirFeat = path.join(projectsDir, encodeProjectDir(wtFeat));
  writeTranscript(dirMain, '11111111-1111-1111-1111-111111111111', { title: 'oldest in main', cwd: wtMain, branch: 'refs/heads/main', mtimeMs: 1000 });
  writeTranscript(dirMain, '22222222-2222-2222-2222-222222222222', { title: '<command-args>middle one</command-args>', cwd: wtMain, branch: 'refs/heads/main', mtimeMs: 3000 });
  writeTranscript(dirFeat, '33333333-3333-3333-3333-333333333333', { title: 'newest in feature', cwd: wtFeat, branch: 'refs/heads/feature/x', mtimeMs: 5000 });
  // A non-jsonl sibling must be ignored.
  fs.writeFileSync(path.join(dirMain, 'notes.txt'), 'ignore me');

  const convs = await listRepoConversations({ repoPath: wtMain, projectsDir, git: gitFake, fsMod: fs });

  assert.equal(convs.length, 3, 'all three transcripts discovered');
  assert.deepEqual(convs.map((c) => c.id), [
    '33333333-3333-3333-3333-333333333333',
    '22222222-2222-2222-2222-222222222222',
    '11111111-1111-1111-1111-111111111111',
  ], 'sorted newest-first by mtime');
  assert.equal(convs[1].title, 'middle one', 'command-args title extracted');
  assert.equal(convs[0].worktreeName, 'featureX', 'worktree basename surfaced');
  assert.equal(convs[0].gitBranch, 'refs/heads/feature/x');

  fs.rmSync(root, { recursive: true, force: true });
});

test('listRepoConversations de-dups a session id across worktrees, keeping the newest', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-convdedup-'));
  const projectsDir = path.join(root, 'projects');
  const wtA = 'C:/repo';
  const wtB = 'C:/repo/.wt/b';
  const gitFake = async () => [`worktree ${wtA}`, '', `worktree ${wtB}`, ''].join('\n');

  const id = 'abcdabcd-0000-0000-0000-abcdabcdabcd';
  writeTranscript(path.join(projectsDir, encodeProjectDir(wtA)), id, { title: 'older copy', cwd: wtA, mtimeMs: 1000 });
  writeTranscript(path.join(projectsDir, encodeProjectDir(wtB)), id, { title: 'newer copy', cwd: wtB, mtimeMs: 9000 });

  const convs = await listRepoConversations({ repoPath: wtA, projectsDir, git: gitFake, fsMod: fs });
  assert.equal(convs.length, 1, 'duplicate id collapsed to one entry');
  assert.equal(convs[0].title, 'newer copy', 'kept the newest of the duplicates');

  fs.rmSync(root, { recursive: true, force: true });
});

test('listRepoConversations returns [] when no project dirs exist for the repo', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-convnone-'));
  const projectsDir = path.join(root, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  const convs = await listRepoConversations({
    repoPath: 'C:/nope',
    projectsDir,
    git: async () => 'worktree C:/nope\n',
    fsMod: fs,
  });
  assert.deepEqual(convs, []);
  fs.rmSync(root, { recursive: true, force: true });
});
