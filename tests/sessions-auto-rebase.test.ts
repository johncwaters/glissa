// Session wiring for the eager auto-rebase: checkWorktreeChange is the funnel every change trigger
// converges on (the integration-ref watcher's fan-out above all), so the rebase decision hangs off it.
// The engine is faked here - it is exercised for real in git-workspace-rebase.test.js - and the
// signature is injected, so these tests are about WHEN Glissa asks the engine to rebase and what it
// records afterwards, on any platform and with no repo.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../session/sessions.ts';
import { STATES } from '../shared/states.ts';
import type { SessionState } from '../shared/states.ts';
import type { GitWorkspace, RebaseResult, WorkspaceArgs, WorktreeSignature } from '../session/session-worktree-lifecycle.ts';
import type { MergeStatus } from '../session/core/worktree-state.ts';
import type { Workspace } from '../session/session-worktree-lifecycle.ts';

// The lifecycle only reaches rebaseOnly on these paths, so the rest of the seam stays inert.
const INERT_ENGINE = {
  create() { return { cwd: '/wt', isGit: true }; },
  populate() {},
  hasUnmergedWork() { return false; },
  discard() {},
  mergeBack() { return { merged: true }; },
  mergeKeep() { return { merged: true }; },
  async rebaseOnly() { return { ok: true, upToDate: true }; },
} satisfies GitWorkspace;
// A worktree that is clean, quiescent, and two commits behind a develop that just moved.
function signature(extra: Partial<WorktreeSignature> = {}): WorktreeSignature {
  return {
    sig: 'sig-1',
    dirty: false,
    ahead: '1',
    behind: '2',
    rebaseInProgress: false,
    headSha: 'headsha',
    targetSha: 'targetsha',
    ...extra,
  };
}

// Only the rebase verb is exercised here; the rest of the seam is inert so the fake still satisfies it.
function fakeEngine(results: RebaseResult[] = []) {
  const calls: WorkspaceArgs[] = [];
  const queue = [...results];
  return {
    ...INERT_ENGINE,
    calls,
    async rebaseOnly(args: WorkspaceArgs): Promise<RebaseResult> {
      calls.push(args);
      return queue.length > 1 ? (queue.shift() as RebaseResult) : (queue[0] || { ok: true, rebased: true, headSha: 'newhead' });
    },
  } satisfies GitWorkspace & { calls: WorkspaceArgs[] };
}

// A Session with a worktree already provisioned (start() is not involved: the funnel under test runs on
// watcher nudges long after the spawn). The signature is stubbed so no git runs.
function makeSession({ engine, sig = signature(), state = STATES.IDLE, autoRebase }: {
  engine?: GitWorkspace | null;
  sig?: WorktreeSignature | null;
  state?: SessionState;
  autoRebase?: boolean;
} = {}) {
  const s = new Session({
    id: 'ar-sess',
    name: 'ar-sess',
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    gitWorkspace: engine,
    integrationBranch: 'develop',
    ...(autoRebase === undefined ? {} : { autoRebase }),
  });
  s.worktreeLifecycle.adoptWorktree({
    worktreeDir: '/wt',
    branch: 'glissa/session/ar-sess',
    base: 'develop',
    hasUnmergedWork: false,
    watch: false,
    emit: false,
  });
  s.state = state;
  s.worktreeLifecycle.computeWorktreeSignature = async () => sig;
  return s;
}

const rebaseEntries = (s: Session) => s.getDebugState().decisions.filter((d) => d.kind === 'rebase');

test('fires on a clean, idle worktree that fell behind the integration branch', async () => {
  const engine = fakeEngine([{ ok: true, rebased: true, headSha: 'newhead', baseSha: 'newbase', rerereReplayed: true }]);
  const s = makeSession({ engine });
  try {
    await s.checkWorktreeChange();
    assert.equal(engine.calls.length, 1, 'the engine was asked to rebase');
    assert.deepEqual(engine.calls[0], {
      projectPath: s.path,
      workspace: engine.calls[0].workspace,
      targetBranch: 'develop',
    });
    const entries = rebaseEntries(s);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].decision, 'auto-rebased');
    assert.equal(entries[0].from, 'headsha');
    assert.equal(entries[0].to, 'newhead');
    assert.equal(entries[0].rerereReplayed, true, 'the trace records that rerere carried the rebase');
    assert.equal(s.baseSha, 'newbase', 'the session tracks the tip it now sits on');
    assert.equal((engine.calls[0].workspace as Workspace).baseSha, 'newbase', 'and so does the workspace handed to the merge engine');
  } finally { s.destroy(); }
});

test('a successful rebase schedules a recheck so the signature and broadcast refresh', async () => {
  const engine = fakeEngine([{ ok: true, rebased: true, headSha: 'newhead' }]);
  const s = makeSession({ engine });
  try {
    await s.checkWorktreeChange();
    assert.equal(s.worktreeLifecycle.snapshot().hasPendingCheck, true, 'a follow-up worktree check is armed');
  } finally { s.destroy(); }
});

test('an upToDate engine result is not recorded as a rebase', async () => {
  const engine = fakeEngine([{ ok: true, upToDate: true }]);
  const s = makeSession({ engine });
  try {
    await s.checkWorktreeChange();
    assert.equal(engine.calls.length, 1);
    assert.deepEqual(rebaseEntries(s), [], 'nothing happened, so nothing is traced');
  } finally { s.destroy(); }
});

test('never fires while the session is working, waiting, dirty, parked, merging, or switched off', async () => {
  const cases = [
    { label: 'RUNNING', opts: { state: STATES.RUNNING } },
    { label: 'WAITING', opts: { state: STATES.WAITING } },
    { label: 'STARTING', opts: { state: STATES.STARTING } },
    { label: 'dirty', opts: { sig: signature({ dirty: true }) } },
    { label: 'up to date', opts: { sig: signature({ behind: '0' }) } },
    { label: 'mid-rebase', opts: { sig: signature({ rebaseInProgress: true }) } },
    { label: 'disabled', opts: { autoRebase: false } },
  ];
  for (const { label, opts } of cases) {
    const engine = fakeEngine();
    const s = makeSession({ engine, ...opts });
    try {
      await s.checkWorktreeChange();
      assert.equal(engine.calls.length, 0, `${label}: the engine is never called`);
    } finally { s.destroy(); }
  }

  for (const mergeStatus of ['parked', 'merging'] as MergeStatus[]) {
    const engine = fakeEngine();
    const s = makeSession({ engine });
    try {
      s.worktreeLifecycle.setMergeStatus(mergeStatus, {}, { emit: false });
      await s.checkWorktreeChange();
      assert.equal(engine.calls.length, 0, `${mergeStatus}: the engine is never called`);
    } finally { s.destroy(); }
  }
});

// The cooldown is what keeps a doomed rebase from being retried on every watcher nudge. It is keyed on
// the two shas the conflict is a function of, so it expires by itself the moment either side moves.
test('a conflict stores a cooldown that stops an identical recheck from retrying', async () => {
  const engine = fakeEngine([{ ok: false, reason: 'rebase-conflict', conflicts: ['src/a.js'] }]);
  const s = makeSession({ engine });
  try {
    await s.checkWorktreeChange();
    assert.equal(engine.calls.length, 1);
    const entries = rebaseEntries(s);
    assert.equal(entries[0].decision, 'conflict');
    assert.deepEqual(entries[0].conflicts, ['src/a.js']);
    assert.equal(s.mergeStatus, 'none', 'a conflict does NOT park: the operator Merge click still owns that');

    await s.checkWorktreeChange();
    assert.equal(engine.calls.length, 1, 'the identical head/target pair is not retried');
  } finally { s.destroy(); }
});

test('a moved integration branch clears the cooldown and the rebase is attempted again', async () => {
  const engine = fakeEngine([
    { ok: false, reason: 'rebase-conflict', conflicts: ['src/a.js'] },
    { ok: true, rebased: true, headSha: 'newhead' },
  ]);
  const s = makeSession({ engine });
  try {
    await s.checkWorktreeChange();
    assert.equal(engine.calls.length, 1);
    s.worktreeLifecycle.computeWorktreeSignature = async () => signature({ targetSha: 'moved' });
    await s.checkWorktreeChange();
    assert.equal(engine.calls.length, 2, 'a new target sha is worth another attempt');
    assert.equal(s.worktreeLifecycle.snapshot().hasConflictCooldown, false, 'and a success clears the cooldown');
  } finally { s.destroy(); }
});

test('a session with no worktree engine never rebases, and an engine failure never breaks the funnel', async () => {
  const s = makeSession({ engine: undefined });
  const changes: unknown[] = [];
  s.on('worktree-changed', (e) => changes.push(e));
  try {
    await assert.doesNotReject(() => s.checkWorktreeChange());
    assert.equal(changes.length, 1, 'the change broadcast still fires');
  } finally { s.destroy(); }

  const throwing = { ...INERT_ENGINE, rebaseOnly(): never { throw new Error('engine exploded'); } };
  const s2 = makeSession({ engine: throwing });
  const changes2: unknown[] = [];
  s2.on('worktree-changed', (e) => changes2.push(e));
  try {
    await assert.doesNotReject(() => s2.checkWorktreeChange());
    assert.equal(changes2.length, 1, 'the change broadcast survives an engine throw');
  } finally { s2.destroy(); }
});

// A rebase rewrites the worktree, and mid-rebase it reads clean and detached with ahead 0 - exactly the
// shape decideSignatureDemotion self-heals a review gate to 'none' on. So the whole funnel is suppressed
// for the duration, the same way a live merge suppresses it, and the window always ends in one recheck.
test('the funnel is suppressed while a rebase runs, and one recheck always closes the window', async () => {
  let releaseRebase: () => void = () => {};
  const engine = {
    ...INERT_ENGINE,
    calls: [] as WorkspaceArgs[],
    rebaseOnly(args: WorkspaceArgs): Promise<RebaseResult> {
      engine.calls.push(args);
      return new Promise((resolve) => { releaseRebase = () => resolve({ ok: true, rebased: true, headSha: 'newhead' }); });
    },
  };
  const s = makeSession({ engine });
  try {
    s.worktreeLifecycle.setMergeStatus('pending-review', {}, { emit: false });
    const inFlight = s.checkWorktreeChange();
    await new Promise((r) => setImmediate(r));
    assert.equal(engine.calls.length, 1, 'the rebase is in flight');

    // A concurrent nudge (the reflog fan-out re-checking every sibling) lands mid-rebase.
    s.worktreeLifecycle.computeWorktreeSignature = async () => signature({ ahead: '0', behind: '0', headSha: 'detached' });
    await s.checkWorktreeChange();
    assert.equal(engine.calls.length, 1, 'the concurrent check did not start a second rebase');
    assert.equal(s.mergeStatus, 'pending-review', 'and never demoted the review gate off a mid-rebase read');

    releaseRebase();
    await inFlight;
    assert.equal(s.worktreeLifecycle.snapshot().isAutoRebasing, false, 'the mutex is released');
    assert.equal(s.worktreeLifecycle.snapshot().hasPendingCheck, true, 'the suppressed window ends in a recheck');
  } finally { s.destroy(); }
});

test('a conflict and an engine throw each still close the suppressed window with a recheck', async () => {
  const conflict: RebaseResult = { ok: false, reason: 'rebase-conflict', conflicts: ['a.js'] };
  for (const result of [conflict, 'throw'] as (RebaseResult | 'throw')[]) {
    const engine = result === 'throw'
      ? { ...INERT_ENGINE, calls: [] as WorkspaceArgs[], rebaseOnly(args: WorkspaceArgs): never { engine.calls.push(args); throw new Error('boom'); } }
      : fakeEngine([result]);
    const s = makeSession({ engine });
    try {
      await s.checkWorktreeChange();
      assert.equal(s.worktreeLifecycle.snapshot().isAutoRebasing, false);
      assert.equal(s.worktreeLifecycle.snapshot().hasPendingCheck, true, `${result === 'throw' ? 'a throw' : 'a conflict'} still schedules a recheck`);
    } finally { s.destroy(); }
  }
});

// A rebase that never started is transient (an index lock, a hook), not something an operator resolves,
// so it must not burn the cooldown that exists to stop a DOOMED rebase from retrying forever.
test('a rebase that never started is retried, not cooled down', async () => {
  const engine = fakeEngine([{ ok: false, reason: 'rebase-failed' }]);
  const s = makeSession({ engine });
  try {
    await s.checkWorktreeChange();
    assert.equal(engine.calls.length, 1);
    assert.equal(s.worktreeLifecycle.snapshot().hasConflictCooldown, false, 'no cooldown armed');
    assert.deepEqual(rebaseEntries(s), [], 'and nothing traced: it is not a decision, it is a hiccup');
    await s.checkWorktreeChange();
    assert.equal(engine.calls.length, 2, 'the same signature is tried again');
  } finally { s.destroy(); }
});

test('a rebase that completed under a state change is recorded for forensics', async () => {
  const engine = {
    ...INERT_ENGINE,
    calls: [] as WorkspaceArgs[],
    async rebaseOnly(args: WorkspaceArgs): Promise<RebaseResult> {
      engine.calls.push(args);
      s.state = STATES.RUNNING; // a turn started while the rebase was rewriting the worktree
      return { ok: true, rebased: true, headSha: 'newhead' };
    },
  };
  const s = makeSession({ engine });
  try {
    await s.checkWorktreeChange();
    const decisions = rebaseEntries(s).map((d) => d.decision);
    assert.deepEqual(decisions, ['state-moved', 'auto-rebased']);
    assert.equal(rebaseEntries(s)[0].state, STATES.RUNNING, 'the state it landed in is named');
  } finally { s.destroy(); }
});

// The trigger this feature exists for: a sibling session merged into develop, so THIS worktree fell
// behind without a single byte of it changing. The signature hash is deliberately unchanged, which is
// exactly why the rebase decision has to sit ahead of the dedup early-return.
test('fires on an unchanged signature, the case an integration-branch move actually produces', async () => {
  const engine = fakeEngine([{ ok: true, upToDate: true }]);
  const s = makeSession({ engine });
  try {
    await s.checkWorktreeChange();          // establishes the signature baseline
    assert.equal(engine.calls.length, 1);
    await s.checkWorktreeChange();          // same sig hash: the emit dedups, the rebase must not
    assert.equal(engine.calls.length, 2, 'the dedup does not gate the rebase decision');
  } finally { s.destroy(); }
});
