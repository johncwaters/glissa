import test from 'node:test';
import assert from 'node:assert/strict';

import { UpdateJournal as UpdateJournalSchema } from '../shared/contracts/update-journal.ts';
import type { UpdateJournal, UpdateStepId } from '../shared/contracts/update-journal.ts';
import {
  appendTail,
  beginRun,
  beginStep,
  decideFastForward,
  decidePreflight,
  failRun,
  finishStep,
  idleJournal,
  interruptedDisplayJournal,
  markDiscarded,
  markInterrupted,
  markStaged,
  markSucceeded,
  planHandOffRenames,
  planSteps,
  PREVIOUS_DEPENDENCIES_BACKUP_NAME,
  PREVIOUS_DIST_BACKUP_NAME,
  retireAtBoot,
} from '../server/core/update-apply-core.ts';
import type { PreflightFacts } from '../server/core/update-apply-core.ts';

const HEAD_SHA = 'a'.repeat(40);
const TARGET_SHA = 'b'.repeat(40);
const STARTED_AT = 1_700_000_000_000;
const FINISHED_AT = 1_700_000_060_000;
const READY_FACTS: PreflightFacts = {
  flavor: 'clone',
  platform: 'linux',
  statusChannel: 'release',
  configuredChannel: 'release',
  updateAvailable: true,
  isTreeClean: true,
  branch: 'main',
  upstream: 'origin/main',
  statusBranch: 'main',
  statusUpstream: 'origin/main',
  headSha: HEAD_SHA,
  targetSha: TARGET_SHA,
  journalState: 'idle',
  restartRequested: false,
};

const REFUSALS: Array<{ name: string; facts: Partial<PreflightFacts>; reason: string }> = [
  { name: 'flavor is not clone', facts: { flavor: 'npm-global' }, reason: 'unsupported-flavor' },
  { name: 'platform is win32', facts: { platform: 'win32' }, reason: 'unsupported-platform' },
  { name: 'the status is for another channel', facts: { statusChannel: 'main' }, reason: 'channel-mismatch' },
  { name: 'the status reports no update', facts: { updateAvailable: false }, reason: 'no-update-available' },
  { name: 'tree is dirty', facts: { isTreeClean: false }, reason: 'dirty-tree' },
  { name: 'branch is missing', facts: { branch: null }, reason: 'no-branch' },
  { name: 'upstream is missing', facts: { upstream: null }, reason: 'no-upstream' },
  { name: 'the upstream remote is not origin', facts: { upstream: 'fork/main', statusUpstream: 'fork/main' }, reason: 'unsupported-remote' },
  { name: 'the checked-out branch moved since the check', facts: { statusBranch: 'other' }, reason: 'checkout-changed' },
  { name: 'the upstream moved since the check', facts: { statusUpstream: 'origin/other' }, reason: 'checkout-changed' },
  { name: 'target sha is missing', facts: { targetSha: null }, reason: 'missing-target-sha' },
  { name: 'head equals target', facts: { headSha: TARGET_SHA }, reason: 'nothing-to-do' },
  { name: 'journal is running', facts: { journalState: 'running' }, reason: 'already-running' },
  { name: 'journal is staged', facts: { journalState: 'staged' }, reason: 'already-staged' },
  { name: 'restart was requested', facts: { restartRequested: true }, reason: 'restart-requested' },
];

for (const refusal of REFUSALS) {
  test(`decidePreflight refuses when ${refusal.name}`, () => {
    const decision = decidePreflight({ ...READY_FACTS, ...refusal.facts });
    assert.equal(decision.ok, false);
    if (decision.ok) throw new Error('the preflight unexpectedly passed');
    assert.equal(decision.reason, refusal.reason);
    assert.ok(decision.message.length > 0);
  });
}

test('decidePreflight requests a lockfile check when every guard passes', () => {
  assert.deepEqual(decidePreflight(READY_FACTS), { ok: true, lockfileCheckNeeded: true });
});

test('decideFastForward distinguishes a checked-out target from diverged history', () => {
  assert.deepEqual(
    decideFastForward({ canFastForward: true, isTargetAncestorOfHead: false }),
    { ok: true, lockfileCheckNeeded: true },
  );
  const alreadyCheckedOut = decideFastForward({ canFastForward: false, isTargetAncestorOfHead: true });
  assert.equal(alreadyCheckedOut.ok, false);
  if (alreadyCheckedOut.ok) throw new Error('the fast-forward check unexpectedly passed');
  assert.equal(alreadyCheckedOut.reason, 'target-already-checked-out');
  assert.match(alreadyCheckedOut.message, /Restart/);

  const refused = decideFastForward({ canFastForward: false, isTargetAncestorOfHead: false });
  assert.equal(refused.ok, false);
  if (refused.ok) throw new Error('the fast-forward check unexpectedly passed');
  assert.equal(refused.reason, 'not-fast-forward');
  assert.ok(refused.message.length > 0);
});

test('planSteps installs when the lockfile changed', () => {
  assert.deepEqual(planSteps({ lockfileChanged: true }), ['fetch', 'stage', 'install', 'build']);
});

test('planSteps links dependencies when the lockfile did not change', () => {
  assert.deepEqual(planSteps({ lockfileChanged: false }), ['fetch', 'stage', 'link-deps', 'build']);
});

test('planHandOffRenames orders dist before dependency replacement', () => {
  assert.deepEqual(planHandOffRenames({ root: '/root', stagingPath: '/root/.glimmervoid/update/next', lockfileChanged: true }).renames, [
    { from: '/root/dist', to: `/root/.glimmervoid/update/${PREVIOUS_DIST_BACKUP_NAME}`, artifact: 'dist' },
    { from: '/root/.glimmervoid/update/next/dist', to: '/root/dist', artifact: 'dist' },
    { from: '/root/node_modules', to: `/root/.glimmervoid/update/${PREVIOUS_DEPENDENCIES_BACKUP_NAME}`, artifact: 'node_modules' },
    { from: '/root/.glimmervoid/update/next/node_modules', to: '/root/node_modules', artifact: 'node_modules' },
  ]);
});

test('planHandOffRenames omits dependency replacement when the lockfile is unchanged', () => {
  const plan = planHandOffRenames({ root: '/root', stagingPath: '/stage', lockfileChanged: false });
  assert.equal(plan.renames.length, 2);
  assert.deepEqual(plan.renames.map((rename) => rename.artifact), ['dist', 'dist']);
});

test('planHandOffRenames reverses every completed rename before each failure index', () => {
  const plan = planHandOffRenames({ root: '/root', stagingPath: '/stage', lockfileChanged: true });
  for (let failureIndex = 0; failureIndex < plan.renames.length; failureIndex += 1) {
    const expected = plan.renames
      .slice(0, failureIndex)
      .reverse()
      .map(({ from, to, artifact }) => ({ from: to, to: from, artifact }));
    assert.deepEqual(plan.reversalsByFailureIndex[failureIndex], expected);
  }
});

function startedRun(stepIds: UpdateStepId[]): UpdateJournal {
  return beginRun(idleJournal('release'), {
    stepIds,
    fromSha: HEAD_SHA,
    toSha: TARGET_SHA,
    toVersion: '9.9.9',
    channel: 'release',
    now: STARTED_AT,
  });
}

function stagedRunWithEveryStepSucceeded(): UpdateJournal {
  const fetched = finishStep(beginStep(startedRun(['fetch']), { stepId: 'fetch', now: STARTED_AT }), {
    stepId: 'fetch',
    now: FINISHED_AT,
  });
  return markStaged(fetched, { now: FINISHED_AT });
}

function journalForBootRetirement(state: UpdateJournal['state']): UpdateJournal {
  if (state === 'idle') return idleJournal('main');
  return {
    ...startedRun(['fetch']),
    state,
    channel: 'main',
    reason: state === 'failed' || state === 'interrupted' || state === 'discarded' ? 'previous result' : null,
  };
}

for (const [state, shouldRetire] of [
  ['failed', true],
  ['interrupted', true],
  ['discarded', true],
  ['idle', false],
  ['running', false],
  ['staged', false],
  ['succeeded', false],
] as const) {
  test(`retireAtBoot ${shouldRetire ? 'retires' : 'keeps'} a ${state} journal`, () => {
    const journal = journalForBootRetirement(state);
    const retiredJournal = retireAtBoot(journal, { wasPersisted: true });
    if (shouldRetire) {
      assert.deepEqual(retiredJournal, idleJournal('main'));
      return;
    }
    assert.deepEqual(retiredJournal, journal);
  });
}

test('retireAtBoot keeps a failed journal flagged as a handoff failure', () => {
  const handOffFailure = failRun(stagedRunWithEveryStepSucceeded(), {
    reason: 'handoff-rename-failed: EACCES',
    now: FINISHED_AT,
    atHandOff: true,
  });
  assert.equal(handOffFailure.failedAtHandOff, true);
  assert.deepEqual(handOffFailure.steps.map((step) => step.status), ['succeeded']);
  assert.deepEqual(retireAtBoot(handOffFailure, { wasPersisted: true }), handOffFailure);
});

test('retireAtBoot retires a failed journal whose steps all succeeded without the handoff flag', () => {
  const failedAfterEveryStep: UpdateJournal = {
    ...stagedRunWithEveryStepSucceeded(),
    state: 'failed',
    reason: 'lockfile-check-failed: git exploded',
    channel: 'main',
  };
  assert.equal(failedAfterEveryStep.failedAtHandOff, undefined);
  assert.deepEqual(retireAtBoot(failedAfterEveryStep, { wasPersisted: true }), idleJournal('main'));
});

test('retireAtBoot retires a failed journal that never planned a step', () => {
  const failedBeforeStaging: UpdateJournal = { ...idleJournal('main'), state: 'failed', reason: 'not-fast-forward' };
  assert.deepEqual(retireAtBoot(failedBeforeStaging, { wasPersisted: true }), idleJournal('main'));
});

test('retireAtBoot leaves a journal that was never persisted untouched', () => {
  const displayOnly = interruptedDisplayJournal('main', 'update journal is invalid');
  assert.deepEqual(retireAtBoot(displayOnly, { wasPersisted: false }), displayOnly);
  assert.deepEqual(retireAtBoot(displayOnly, { wasPersisted: true }), idleJournal('main'));
});

test('failRun flags a handoff failure only when the caller says the failure came from the handoff', () => {
  const failedAtHandOff = failRun(stagedRunWithEveryStepSucceeded(), {
    reason: 'handoff-rename-failed: EACCES',
    now: FINISHED_AT,
    atHandOff: true,
  });
  const failedWhileStaged = failRun(stagedRunWithEveryStepSucceeded(), {
    reason: 'journal-write-failed: ENOSPC',
    now: FINISHED_AT,
  });
  const failedWhileRunning = failRun(beginStep(startedRun(['fetch']), { stepId: 'fetch', now: STARTED_AT }), {
    reason: 'fetch failed',
    now: FINISHED_AT,
  });
  assert.equal(failedAtHandOff.failedAtHandOff, true);
  assert.equal(failedWhileStaged.failedAtHandOff, false);
  assert.equal(failedWhileRunning.failedAtHandOff, false);
  assert.deepEqual(retireAtBoot(failedWhileStaged, { wasPersisted: true }), idleJournal('release'));
  assert.deepEqual(UpdateJournalSchema.parse(failedAtHandOff), failedAtHandOff);
});

test('beginRun records the run identity the persisted contract requires', () => {
  const running = startedRun(['fetch', 'stage']);
  assert.deepEqual(UpdateJournalSchema.parse(running), running);
  assert.equal(running.state, 'running');
  assert.equal(running.fromSha, HEAD_SHA);
  assert.equal(running.toSha, TARGET_SHA);
  assert.equal(running.toVersion, '9.9.9');
  assert.equal(running.channel, 'release');
  assert.equal(running.startedAt, STARTED_AT);
  assert.equal(running.finishedAt, null);
  assert.deepEqual(running.steps.map((step) => step.status), ['pending', 'pending']);
});

test('journal transitions begin and finish a step without mutating the prior value', () => {
  const running = startedRun(['fetch', 'stage']);
  const fetching = beginStep(running, { stepId: 'fetch', now: STARTED_AT });
  const fetched = finishStep(fetching, { stepId: 'fetch', now: FINISHED_AT });
  assert.equal(running.steps[0]?.status, 'pending');
  assert.equal(fetching.activeStep, 'fetch');
  assert.equal(fetching.steps[0]?.status, 'running');
  assert.equal(fetching.steps[0]?.startedAt, STARTED_AT);
  assert.equal(fetched.activeStep, null);
  assert.equal(fetched.steps[0]?.status, 'succeeded');
  assert.equal(fetched.steps[0]?.finishedAt, FINISHED_AT);
  assert.deepEqual(UpdateJournalSchema.parse(fetched), fetched);
});

test('beginStep refuses a step id that is not in the plan', () => {
  const running = startedRun(['fetch', 'stage']);
  assert.deepEqual(beginStep(running, { stepId: 'install', now: STARTED_AT }), running);
});

test('failRun marks the active step failed and records the reason', () => {
  const fetching = beginStep(startedRun(['fetch']), { stepId: 'fetch', now: STARTED_AT });
  const failed = failRun(fetching, { reason: 'fetch failed', now: FINISHED_AT });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.steps[0]?.status, 'failed');
  assert.equal(failed.steps[0]?.finishedAt, FINISHED_AT);
  assert.equal(failed.reason, 'fetch failed');
  assert.equal(failed.finishedAt, FINISHED_AT);
});

test('journal terminal transitions reach staged, succeeded, discarded, and interrupted', () => {
  const running = startedRun(['build']);
  const staged = markStaged(running, { now: FINISHED_AT });
  assert.equal(staged.state, 'staged');
  assert.equal(staged.finishedAt, FINISHED_AT);
  assert.equal(markSucceeded(staged, { now: FINISHED_AT }).state, 'succeeded');
  assert.equal(markDiscarded(staged, { reason: 'restarted without handoff', now: FINISHED_AT }).state, 'discarded');
  const building = beginStep(running, { stepId: 'build', now: STARTED_AT });
  const interrupted = markInterrupted(building, { reason: 'server restarted', now: FINISHED_AT });
  assert.equal(interrupted.state, 'interrupted');
  assert.equal(interrupted.steps[0]?.status, 'failed');
  assert.equal(interrupted.reason, 'server restarted');
});

test('a failed run cannot be walked back to succeeded', () => {
  const failed = failRun(beginStep(startedRun(['fetch']), { stepId: 'fetch', now: STARTED_AT }), {
    reason: 'fetch failed',
    now: FINISHED_AT,
  });
  const walkedBack = markSucceeded(finishStep(failed, { stepId: 'fetch', now: FINISHED_AT }), { now: FINISHED_AT });
  assert.deepEqual(walkedBack, failed);
  assert.equal(walkedBack.state, 'failed');
  assert.equal(walkedBack.reason, 'fetch failed');
});

test('every terminal state absorbs the transitions that do not belong to it', () => {
  const running = startedRun(['build']);
  const succeeded = markSucceeded(markStaged(running, { now: FINISHED_AT }), { now: FINISHED_AT });
  const discarded = markDiscarded(markStaged(running, { now: FINISHED_AT }), { reason: 'discarded', now: FINISHED_AT });
  const interrupted = markInterrupted(running, { reason: 'interrupted', now: FINISHED_AT });
  for (const terminal of [succeeded, discarded, interrupted]) {
    assert.deepEqual(beginStep(terminal, { stepId: 'build', now: FINISHED_AT }), terminal);
    assert.deepEqual(finishStep(terminal, { stepId: 'build', now: FINISHED_AT }), terminal);
    assert.deepEqual(failRun(terminal, { reason: 'too late', now: FINISHED_AT }), terminal);
    assert.deepEqual(markStaged(terminal, { now: FINISHED_AT }), terminal);
  }
});

test('an idle journal refuses every transition except beginning a run', () => {
  const idle = idleJournal('release');
  assert.deepEqual(beginStep(idle, { stepId: 'fetch', now: STARTED_AT }), idle);
  assert.deepEqual(failRun(idle, { reason: 'nothing ran', now: STARTED_AT }), idle);
  assert.deepEqual(markStaged(idle, { now: STARTED_AT }), idle);
  assert.equal(startedRun(['fetch']).state, 'running');
});

test('a terminal journal can begin the next run', () => {
  const failed = failRun(startedRun(['fetch']), { reason: 'fetch failed', now: FINISHED_AT });
  const restarted = beginRun(failed, {
    stepIds: ['fetch', 'stage'],
    fromSha: HEAD_SHA,
    toSha: TARGET_SHA,
    toVersion: '9.9.9',
    channel: 'main',
    now: FINISHED_AT,
  });
  assert.equal(restarted.state, 'running');
  assert.equal(restarted.reason, null);
  assert.equal(restarted.channel, 'main');
  assert.equal(restarted.finishedAt, null);
});

test('a running journal refuses a second beginRun', () => {
  const running = startedRun(['fetch']);
  const restarted = beginRun(running, {
    stepIds: ['fetch', 'stage'],
    fromSha: HEAD_SHA,
    toSha: TARGET_SHA,
    toVersion: '9.9.9',
    channel: 'release',
    now: FINISHED_AT,
  });
  assert.deepEqual(restarted, running);
});

test('appendTail retains only the last 200 lines', () => {
  const existing = Array.from({ length: 150 }, (_, index) => `old-${index}`);
  const appended = Array.from({ length: 100 }, (_, index) => `new-${index}`).join('\r\n');
  const tail = appendTail(existing, `${appended}\r\n`);
  assert.equal(tail.length, 200);
  assert.equal(tail[0], 'old-50');
  assert.equal(tail.at(-1), 'new-99');
  assert.deepEqual(existing.length, 150);
});
