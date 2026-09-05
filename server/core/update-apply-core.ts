import type {
  UpdateChannel,
  UpdateJournal,
  UpdateJournalStep,
  UpdateRunState,
  UpdateStepId,
} from '../../shared/contracts/update-journal.ts';
import { parseRemoteFromUpstream } from './branch-sync-core.ts';
import { normalizeSha } from './update-core.ts';

const OUTPUT_TAIL_LINE_CAP = 200;
const PREVIOUS_DIST_BACKUP_NAME = 'prev-dist';
const PREVIOUS_DEPENDENCIES_BACKUP_NAME = 'prev-node_modules';
const QUARANTINED_DIST_NAME = 'broken-dist';
const QUARANTINED_DEPENDENCIES_NAME = 'broken-node_modules';
const SUPPORTED_UPDATE_REMOTE = 'origin';

type UpdateArtifact = 'dist' | 'node_modules';

type PreflightRefusalReason =
  | 'unsupported-flavor'
  | 'unsupported-platform'
  | 'channel-mismatch'
  | 'no-update-available'
  | 'dirty-tree'
  | 'no-branch'
  | 'no-upstream'
  | 'unsupported-remote'
  | 'checkout-changed'
  | 'missing-target-sha'
  | 'nothing-to-do'
  | 'not-fast-forward'
  | 'already-running'
  | 'already-staged'
  | 'restart-requested';

interface PreflightFacts {
  flavor: string;
  platform: string;
  statusChannel: UpdateChannel;
  configuredChannel: UpdateChannel;
  updateAvailable: boolean;
  isTreeClean: boolean;
  branch: string | null;
  upstream: string | null;
  statusBranch: string | null;
  statusUpstream: string | null;
  headSha: string | null;
  targetSha: string | null;
  journalState: UpdateRunState;
  restartRequested: boolean;
}

type PreflightDecision =
  | { ok: true; lockfileCheckNeeded: true }
  | { ok: false; reason: PreflightRefusalReason; message: string };

interface RenameOperation {
  from: string;
  to: string;
  artifact: UpdateArtifact;
}

interface HandOffRenamePlan {
  renames: RenameOperation[];
  reversalsByFailureIndex: RenameOperation[][];
}

type UpdateTransitionName =
  | 'begin-run'
  | 'begin-step'
  | 'finish-step'
  | 'fail-run'
  | 'mark-staged'
  | 'mark-succeeded'
  | 'mark-discarded'
  | 'mark-interrupted';

const TRANSITIONS_ALLOWED_BY_STATE: Readonly<Record<UpdateRunState, readonly UpdateTransitionName[]>> = Object.freeze({
  idle: Object.freeze<UpdateTransitionName[]>(['begin-run']),
  running: Object.freeze<UpdateTransitionName[]>(['begin-step', 'finish-step', 'fail-run', 'mark-staged', 'mark-interrupted']),
  staged: Object.freeze<UpdateTransitionName[]>(['fail-run', 'mark-succeeded', 'mark-discarded']),
  succeeded: Object.freeze<UpdateTransitionName[]>(['begin-run']),
  failed: Object.freeze<UpdateTransitionName[]>(['begin-run']),
  discarded: Object.freeze<UpdateTransitionName[]>(['begin-run']),
  interrupted: Object.freeze<UpdateTransitionName[]>(['begin-run']),
});

interface RunStartFacts {
  stepIds: readonly UpdateStepId[];
  fromSha: string | null;
  toSha: string | null;
  toVersion: string | null;
  channel: UpdateChannel;
  now: number;
}

interface StepMoment {
  stepId: UpdateStepId;
  now: number;
}

interface EndingMoment {
  reason: string;
  now: number;
}

function decidePreflight(facts: PreflightFacts): PreflightDecision {
  if (facts.flavor !== 'clone') {
    return { ok: false, reason: 'unsupported-flavor', message: 'Use the install command because dashboard updates require a clone.' };
  }
  if (facts.platform === 'win32') {
    return { ok: false, reason: 'unsupported-platform', message: 'Use the install command because dashboard updates are unavailable on Windows.' };
  }
  if (facts.statusChannel !== facts.configuredChannel) {
    return { ok: false, reason: 'channel-mismatch', message: 'The update status is for another channel. Check for updates again.' };
  }
  if (!facts.updateAvailable) {
    return { ok: false, reason: 'no-update-available', message: 'No update is available.' };
  }
  if (!facts.isTreeClean) {
    return { ok: false, reason: 'dirty-tree', message: 'Commit or discard the checkout changes before updating. Check for updates again.' };
  }
  if (!facts.branch) {
    return { ok: false, reason: 'no-branch', message: 'Check out a branch before updating. Check for updates again.' };
  }
  if (!facts.upstream) {
    return { ok: false, reason: 'no-upstream', message: 'Set an upstream for the checked-out branch before updating. Check for updates again.' };
  }
  if (parseRemoteFromUpstream(facts.upstream) !== SUPPORTED_UPDATE_REMOTE) {
    return { ok: false, reason: 'unsupported-remote', message: 'Track the branch on origin before updating. Check for updates again.' };
  }
  if (facts.statusBranch !== facts.branch || facts.statusUpstream !== facts.upstream) {
    return { ok: false, reason: 'checkout-changed', message: 'The checkout moved since the last check. Check for updates again.' };
  }
  const targetSha = normalizeSha(facts.targetSha);
  if (!targetSha) {
    return { ok: false, reason: 'missing-target-sha', message: 'The target sha is unknown. Check for updates again.' };
  }
  if (normalizeSha(facts.headSha) === targetSha) {
    return { ok: false, reason: 'nothing-to-do', message: 'The checkout is already at the target. Check for updates again.' };
  }
  if (facts.journalState === 'running') {
    return { ok: false, reason: 'already-running', message: 'Wait for the current update to finish.' };
  }
  if (facts.journalState === 'staged') {
    return { ok: false, reason: 'already-staged', message: 'Restart to apply the staged update.' };
  }
  if (facts.restartRequested) {
    return { ok: false, reason: 'restart-requested', message: 'Wait for the requested restart to finish.' };
  }
  return { ok: true, lockfileCheckNeeded: true };
}

function decideFastForward({ canFastForward }: { canFastForward: boolean }): PreflightDecision {
  if (canFastForward) return { ok: true, lockfileCheckNeeded: true };
  return { ok: false, reason: 'not-fast-forward', message: 'Update the branch manually because the target is not a fast-forward. Check for updates again.' };
}

function planSteps({ lockfileChanged }: { lockfileChanged: boolean }): UpdateStepId[] {
  if (lockfileChanged) return ['fetch', 'stage', 'install', 'build'];
  return ['fetch', 'stage', 'link-deps', 'build'];
}

function planHandOffRenames({
  root,
  stagingPath,
  lockfileChanged,
}: {
  root: string;
  stagingPath: string;
  lockfileChanged: boolean;
}): HandOffRenamePlan {
  const updatePath = `${root}/.glissa/update`;
  const renames: RenameOperation[] = [
    { from: `${root}/dist`, to: `${updatePath}/${PREVIOUS_DIST_BACKUP_NAME}`, artifact: 'dist' },
    { from: `${stagingPath}/dist`, to: `${root}/dist`, artifact: 'dist' },
  ];
  if (lockfileChanged) {
    renames.push(
      { from: `${root}/node_modules`, to: `${updatePath}/${PREVIOUS_DEPENDENCIES_BACKUP_NAME}`, artifact: 'node_modules' },
      { from: `${stagingPath}/node_modules`, to: `${root}/node_modules`, artifact: 'node_modules' },
    );
  }
  return {
    renames,
    reversalsByFailureIndex: renames.map((_, failureIndex) => renames
      .slice(0, failureIndex)
      .reverse()
      .map(({ from, to, artifact }) => ({ from: to, to: from, artifact }))),
  };
}

function appendTail(existingTail: readonly string[], output: string): string[] {
  const appendedLines = output.split(/\r?\n/);
  if (appendedLines.at(-1) === '') appendedLines.pop();
  return [...existingTail, ...appendedLines].slice(-OUTPUT_TAIL_LINE_CAP);
}

function isTransitionAllowed(state: UpdateRunState, transition: UpdateTransitionName): boolean {
  return TRANSITIONS_ALLOWED_BY_STATE[state].includes(transition);
}

function applyTransition(
  journal: UpdateJournal,
  transition: UpdateTransitionName,
  advance: (allowed: UpdateJournal) => UpdateJournal,
): UpdateJournal {
  if (!isTransitionAllowed(journal.state, transition)) return journal;
  return advance(journal);
}

function replaceStep(
  journal: UpdateJournal,
  stepId: UpdateStepId,
  replace: (step: UpdateJournalStep) => UpdateJournalStep,
): UpdateJournalStep[] {
  return journal.steps.map((step) => step.id === stepId ? replace(step) : step);
}

function isPlannedStep(journal: UpdateJournal, stepId: UpdateStepId): boolean {
  return journal.steps.some((step) => step.id === stepId);
}

function failActiveStep(journal: UpdateJournal, now: number): UpdateJournalStep[] {
  const activeStep = journal.activeStep;
  if (!activeStep) return journal.steps;
  return replaceStep(journal, activeStep, (step) => ({ ...step, status: 'failed', finishedAt: step.finishedAt ?? now }));
}

function beginRun(journal: UpdateJournal, { stepIds, fromSha, toSha, toVersion, channel, now }: RunStartFacts): UpdateJournal {
  return applyTransition(journal, 'begin-run', () => ({
    state: 'running',
    fromSha,
    toSha,
    toVersion,
    channel,
    steps: stepIds.map((id) => ({ id, status: 'pending', startedAt: null, finishedAt: null, outputTail: [] })),
    activeStep: null,
    reason: null,
    startedAt: now,
    finishedAt: null,
  }));
}

function beginStep(journal: UpdateJournal, { stepId, now }: StepMoment): UpdateJournal {
  if (!isPlannedStep(journal, stepId)) return journal;
  return applyTransition(journal, 'begin-step', (running) => ({
    ...running,
    steps: replaceStep(running, stepId, (step) => ({ ...step, status: 'running', startedAt: step.startedAt ?? now })),
    activeStep: stepId,
  }));
}

function finishStep(journal: UpdateJournal, { stepId, now }: StepMoment): UpdateJournal {
  if (!isPlannedStep(journal, stepId)) return journal;
  return applyTransition(journal, 'finish-step', (running) => ({
    ...running,
    steps: replaceStep(running, stepId, (step) => ({ ...step, status: 'succeeded', finishedAt: now })),
    activeStep: running.activeStep === stepId ? null : running.activeStep,
  }));
}

function failRun(journal: UpdateJournal, { reason, now }: EndingMoment): UpdateJournal {
  return applyTransition(journal, 'fail-run', (current) => ({
    ...current,
    state: 'failed',
    steps: failActiveStep(current, now),
    activeStep: null,
    reason,
    finishedAt: now,
  }));
}

function markStaged(journal: UpdateJournal, { now }: { now: number }): UpdateJournal {
  return applyTransition(journal, 'mark-staged', (current) => ({
    ...current,
    state: 'staged',
    activeStep: null,
    reason: null,
    finishedAt: now,
  }));
}

function markSucceeded(journal: UpdateJournal, { now }: { now: number }): UpdateJournal {
  return applyTransition(journal, 'mark-succeeded', (current) => ({
    ...current,
    state: 'succeeded',
    activeStep: null,
    reason: null,
    finishedAt: now,
  }));
}

function markDiscarded(journal: UpdateJournal, { reason, now }: EndingMoment): UpdateJournal {
  return applyTransition(journal, 'mark-discarded', (current) => ({
    ...current,
    state: 'discarded',
    activeStep: null,
    reason,
    finishedAt: now,
  }));
}

function markInterrupted(journal: UpdateJournal, { reason, now }: EndingMoment): UpdateJournal {
  return applyTransition(journal, 'mark-interrupted', (current) => ({
    ...current,
    state: 'interrupted',
    steps: failActiveStep(current, now),
    activeStep: null,
    reason,
    finishedAt: now,
  }));
}

export {
  appendTail,
  beginRun,
  beginStep,
  decideFastForward,
  decidePreflight,
  failRun,
  finishStep,
  markDiscarded,
  markInterrupted,
  markStaged,
  markSucceeded,
  planHandOffRenames,
  planSteps,
  PREVIOUS_DEPENDENCIES_BACKUP_NAME,
  PREVIOUS_DIST_BACKUP_NAME,
  QUARANTINED_DEPENDENCIES_NAME,
  QUARANTINED_DIST_NAME,
};
export type {
  EndingMoment,
  HandOffRenamePlan,
  PreflightDecision,
  PreflightFacts,
  PreflightRefusalReason,
  RenameOperation,
  RunStartFacts,
  StepMoment,
  UpdateArtifact,
};
