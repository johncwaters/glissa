'use strict';

/*
 * The pure git ingest core (docs/plan-ingestion.md, M8): porcelain v2 parsing across every shape a real
 * repo produces, the working-tree signature everything downstream dedupes on, the watch-set derivation,
 * and the one-event-per-settle decision.
 *
 * The signature tests are the load-bearing ones. A signature that moved when the tree did not would make
 * every `.git` write burst and every 60s poll publish the same unchanged working tree again, and since
 * M7.5 each of those is also the navigator's movement signal, so it would spend dispatch budget on
 * nothing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  CLEAN_SIGNATURE, LOG_FIELD_SEPARATOR, createRepoState, decideGitEvents, deriveWatchDirs,
  isNoiseGitFile, parseCommitLine, parsePorcelainStatus, parseRevParse, shouldReadCommit, signatureOf,
} = require('../server/core/ingest-git-core');

const NOW = 1700000000000;
const SHA = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b';
const OTHER_SHA = '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432';

// A porcelain v2 listing carrying every entry kind at once: a worktree modification, a staged one, a
// staged rename (whose line ends `<path><tab><origPath>`), an unmerged path, and an untracked file.
const FULL_STATUS = [
  `# branch.oid ${SHA}`,
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +1 -2',
  '1 .M N... 100644 100644 100644 aaaaaaa aaaaaaa src/app.js',
  '1 M. N... 100644 100644 100644 bbbbbbb ccccccc docs/plan with spaces.md',
  `2 R. N... 100644 100644 100644 ddddddd eeeeeee R100 new/name.js${String.fromCharCode(9)}old/name.js`,
  'u UU N... 100644 100644 100644 100644 fffffff ggggggg hhhhhhh conflicted.txt',
  '? untracked.txt',
].join('\n');

function statusOf(overrides = {}) {
  return {
    branch: 'main',
    detached: false,
    unborn: false,
    oid: SHA,
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    counts: {
      staged: 0, unstaged: 0, untracked: 0, conflicted: 0, ...(overrides.counts || {}),
    },
    signature: CLEAN_SIGNATURE,
    ...overrides,
  };
}

function baselineState(overrides = {}) {
  return {
    initialized: true, branch: 'main', oid: SHA, signature: CLEAN_SIGNATURE, ...overrides,
  };
}

// --- Layout ---------------------------------------------------------------

test('rev-parse resolves a main checkout, and a relative common dir against the cwd it ran in', () => {
  const cwd = path.resolve('/projects/glissa');
  const layout = parseRevParse(['/projects/glissa', '/projects/glissa/.git', '.git', ''].join('\n'), cwd);
  assert.equal(layout.toplevel, cwd);
  assert.equal(layout.gitDir, path.join(cwd, '.git'));
  assert.equal(layout.commonDir, path.join(cwd, '.git'));
});

test('rev-parse keeps a linked worktree gitdir separate from the common dir', () => {
  const worktree = path.resolve('/worktrees/feature');
  const layout = parseRevParse([
    '/worktrees/feature',
    '/projects/glissa/.git/worktrees/feature',
    '/projects/glissa/.git',
  ].join('\n'), worktree);
  assert.equal(layout.toplevel, worktree);
  assert.equal(layout.gitDir, path.resolve('/projects/glissa/.git/worktrees/feature'));
  assert.equal(layout.commonDir, path.resolve('/projects/glissa/.git'));
});

test('rev-parse output that is short of its three lines resolves to nothing at all', () => {
  assert.equal(parseRevParse('/projects/glissa\n', '/projects/glissa'), null);
  assert.equal(parseRevParse('', '/projects/glissa'), null);
});

test('the watch set is directories, deduped, with the linked worktree gitdir beside the common one', () => {
  const commonDir = path.resolve('/projects/glissa/.git');
  const main = deriveWatchDirs({ gitDir: commonDir, commonDir });
  assert.deepEqual(main, [commonDir, path.join(commonDir, 'refs', 'heads')]);

  const worktreeGitDir = path.join(commonDir, 'worktrees', 'feature');
  const linked = deriveWatchDirs({ gitDir: worktreeGitDir, commonDir });
  assert.deepEqual(linked, [commonDir, path.join(commonDir, 'refs', 'heads'), worktreeGitDir]);
});

test('lock and temp churn is noise, and an unnamed watch event never is', () => {
  for (const name of ['index.lock', 'packed-refs.lock', 'refs/heads/main.lock', 'x.tmp', 'tmp_obj_ab12']) {
    assert.equal(isNoiseGitFile(name), true, `${name} should be filtered`);
  }
  for (const name of ['HEAD', 'index', 'packed-refs', 'MERGE_HEAD', 'COMMIT_EDITMSG', 'refs/heads/main']) {
    assert.equal(isNoiseGitFile(name), false, `${name} should wake a read`);
  }
  // Windows reports a null filename for some batched writes; there is nothing to judge, so it wakes.
  assert.equal(isNoiseGitFile(null), false);
  assert.equal(isNoiseGitFile(''), false);
});

// --- Porcelain v2 ---------------------------------------------------------

test('porcelain v2 reads the branch header, every entry kind, and paths containing spaces', () => {
  const status = parsePorcelainStatus(FULL_STATUS);
  assert.equal(status.branch, 'main');
  assert.equal(status.detached, false);
  assert.equal(status.unborn, false);
  assert.equal(status.oid, SHA);
  assert.equal(status.upstream, 'origin/main');
  assert.equal(status.ahead, 1);
  assert.equal(status.behind, 2);
  assert.deepEqual(status.counts, {
    staged: 2, unstaged: 1, untracked: 1, conflicted: 1,
  });
  assert.notEqual(status.signature, CLEAN_SIGNATURE);
});

test('a detached HEAD and an unborn branch both parse rather than reading as a branch named for them', () => {
  const detached = parsePorcelainStatus([`# branch.oid ${SHA}`, '# branch.head (detached)'].join('\n'));
  assert.equal(detached.detached, true);
  assert.equal(detached.branch, null);
  assert.equal(detached.oid, SHA);

  const unborn = parsePorcelainStatus(['# branch.oid (initial)', '# branch.head main'].join('\n'));
  assert.equal(unborn.unborn, true);
  assert.equal(unborn.oid, null);
  assert.equal(unborn.branch, 'main');
});

test('an empty working tree signs as clean, and CRLF stdout parses the same as LF', () => {
  const lf = parsePorcelainStatus([`# branch.oid ${SHA}`, '# branch.head main'].join('\n'));
  assert.equal(lf.signature, CLEAN_SIGNATURE);
  const crlf = parsePorcelainStatus(FULL_STATUS.split('\n').join('\r\n'));
  assert.equal(crlf.signature, parsePorcelainStatus(FULL_STATUS).signature);
  assert.deepEqual(crlf.counts, parsePorcelainStatus(FULL_STATUS).counts);
});

test('the signature ignores entry ORDER and the branch, and moves for a real tree change', () => {
  const lines = FULL_STATUS.split('\n');
  const headers = lines.slice(0, 4);
  const entries = lines.slice(4);
  const shuffled = parsePorcelainStatus([...headers, ...[...entries].reverse()].join('\n'));
  assert.equal(shuffled.signature, parsePorcelainStatus(FULL_STATUS).signature);

  // A checkout changes the branch header and nothing about the working tree; the signature must hold, or
  // a branch switch would publish a status-change on top of its branch-change.
  const onFeature = parsePorcelainStatus(FULL_STATUS.replace('branch.head main', 'branch.head feature/x'));
  assert.equal(onFeature.signature, parsePorcelainStatus(FULL_STATUS).signature);

  const extraFile = parsePorcelainStatus(`${FULL_STATUS}\n? second.txt`);
  assert.notEqual(extraFile.signature, parsePorcelainStatus(FULL_STATUS).signature);

  // Staging a file changes its XY without changing its path, and that is a real move.
  const staged = parsePorcelainStatus(FULL_STATUS.replace('1 .M N...', '1 M. N...'));
  assert.notEqual(staged.signature, parsePorcelainStatus(FULL_STATUS).signature);
});

test('the signature is bounded no matter how many paths a tree holds', () => {
  const many = Array.from({ length: 5000 }, (_unused, index) => `? node_modules/pkg-${index}/index.js`);
  const signature = signatureOf(many);
  assert.ok(signature.length < 40, `signature grew to ${signature.length} chars`);
  assert.ok(signature.startsWith('5000:'));
});

test('a log line parses into sha, author, time and subject, and anything else is no commit at all', () => {
  const line = [SHA, 'Glissa Test', '1699999999', 'fix the gate: keep it simple'].join(LOG_FIELD_SEPARATOR);
  const commit = parseCommitLine(`${line}\n`);
  assert.equal(commit.sha, SHA);
  assert.equal(commit.author, 'Glissa Test');
  assert.equal(commit.committedAt, 1699999999000);
  assert.equal(commit.subject, 'fix the gate: keep it simple');

  // What an unborn branch leaves behind: git exits non-zero and the shell passes the empty stdout on.
  assert.equal(parseCommitLine(''), null);
  assert.equal(parseCommitLine('fatal: your current branch does not have any commits yet\n'), null);
});

// --- Decisions ------------------------------------------------------------

test('the first read of a repo is a baseline and publishes nothing', () => {
  const status = statusOf({ signature: 'a:1' });
  const decided = decideGitEvents({ previous: createRepoState(), status, root: '/repo', now: NOW });
  assert.deepEqual(decided.events, []);
  assert.equal(decided.next.initialized, true);
  assert.equal(decided.next.signature, 'a:1');
});

test('a settle that changed nothing publishes nothing', () => {
  const status = statusOf();
  const decided = decideGitEvents({ previous: baselineState(), status, root: '/repo', now: NOW });
  assert.deepEqual(decided.events, []);
});

test('a moved HEAD on the same branch publishes one commit carrying its branch and subject', () => {
  const status = statusOf({ oid: OTHER_SHA });
  const commit = {
    sha: OTHER_SHA, author: 'Glissa Test', committedAt: NOW - 5000, subject: 'add the feature flag',
  };
  const { events } = decideGitEvents({
    previous: baselineState(), status, commit, root: '/repo', now: NOW,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'commit');
  assert.equal(events[0].source, 'git');
  assert.equal(events[0].scope.root, '/repo');
  assert.equal(events[0].summary, 'commit 9f8e7d6 on main: add the feature flag');
  // Arrival time, not the record's own, so a rebase's replayed author dates cannot age the digest line.
  assert.equal(events[0].ts, NOW);
});

test('a changed branch publishes branch-change, and wins over the commit and status moves it caused', () => {
  const status = statusOf({ branch: 'feature/x', oid: OTHER_SHA, signature: 'b:2' });
  const commit = {
    sha: OTHER_SHA, author: null, committedAt: null, subject: 'start the feature',
  };
  const { events } = decideGitEvents({
    previous: baselineState(), status, commit, root: '/repo', now: NOW,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'branch-change');
  assert.equal(events[0].summary, 'switched to feature/x at 9f8e7d6: start the feature');
});

test('a commit wins over the status move it caused, so one action never becomes two digest lines', () => {
  const status = statusOf({ oid: OTHER_SHA, signature: CLEAN_SIGNATURE });
  const previous = baselineState({ signature: 'dirty:1' });
  const { events, next } = decideGitEvents({
    previous, status, commit: { sha: OTHER_SHA, subject: 'ship it' }, root: '/repo', now: NOW,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'commit');
  // The suppressed status still advances, so the NEXT edit is measured against what the commit left.
  assert.equal(next.signature, CLEAN_SIGNATURE);
});

test('a working-tree move alone publishes status-change with its counts, and dedupes on the signature', () => {
  const status = statusOf({ signature: 'x:9', counts: { staged: 1, unstaged: 2, untracked: 3 } });
  const first = decideGitEvents({ previous: baselineState(), status, root: '/repo', now: NOW });
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].kind, 'status-change');
  assert.equal(first.events[0].summary, 'working tree on main: 1 staged, 2 modified, 3 untracked');

  const again = decideGitEvents({ previous: first.next, status, root: '/repo', now: NOW });
  assert.deepEqual(again.events, []);
});

test('a detached HEAD and an unborn branch are labelled rather than published as a branch named null', () => {
  const detached = decideGitEvents({
    previous: baselineState(),
    status: statusOf({ branch: null, detached: true, oid: OTHER_SHA }),
    commit: { sha: OTHER_SHA, subject: 'init' },
    root: '/repo',
    now: NOW,
  });
  assert.equal(detached.events[0].kind, 'branch-change');
  assert.equal(detached.events[0].summary, 'switched to detached HEAD at 9f8e7d6: init');

  const unborn = decideGitEvents({
    previous: baselineState({ branch: 'main', oid: null }),
    status: statusOf({ oid: null, unborn: true, signature: 'u:1', counts: { untracked: 1 } }),
    root: '/repo',
    now: NOW,
  });
  assert.equal(unborn.events[0].kind, 'status-change');
  assert.equal(unborn.events[0].summary, 'working tree on main (no commits yet): 1 untracked');
});

test('the second spawn is owed only when HEAD or the branch actually moved', () => {
  assert.equal(shouldReadCommit(createRepoState(), statusOf()), false, 'a baseline read needs no subject');
  assert.equal(shouldReadCommit(baselineState(), statusOf()), false, 'a no-op settle needs no subject');
  assert.equal(shouldReadCommit(baselineState(), statusOf({ signature: 'x:1' })), false, 'an edit needs no subject');
  assert.equal(shouldReadCommit(baselineState(), statusOf({ oid: OTHER_SHA })), true);
  assert.equal(shouldReadCommit(baselineState(), statusOf({ branch: 'feature/x' })), true);
  assert.equal(shouldReadCommit(baselineState(), statusOf({ oid: null, unborn: true })), false);
});
