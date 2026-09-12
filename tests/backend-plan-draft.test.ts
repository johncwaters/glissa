import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PLAN_BODY_CAP_BYTES } from '../shared/contracts/plan-review.ts';
import { createPlanReviewWiring } from '../server/plan-review-wiring.ts';
import type { PlanDraftNotice, PlanFileWatcherFactory, PlanReviewWiringOptions } from '../server/plan-review-wiring.ts';
import { manualTimers } from './helpers/manual-timers.ts';
import type { ManualTimers } from './helpers/manual-timers.ts';

type PlanLane = ReturnType<typeof createPlanReviewWiring>;

const DRAFT_DEBOUNCE_MS = 250;

const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-plan-draft-claude-'));
process.env.CLAUDE_CONFIG_DIR = claudeHome;
const plansRoot = path.join(claudeHome, 'plans');
fs.mkdirSync(plansRoot, { recursive: true });
const realPlansRoot = fs.realpathSync(plansRoot);

function planPath(fileName: string): string {
  return path.join(plansRoot, fileName);
}

const temporaryDirectories: string[] = [claudeHome];
const temporaryFiles: string[] = [];
after(() => {
  for (const file of temporaryFiles) fs.rmSync(file, { force: true });
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

interface FakeWatcher {
  directoryPath: string;
  fireChange: (fileName: string | null) => void;
  fireError: (error: unknown) => void;
  isClosed: boolean;
}

function fakeWatchers() {
  const opened: FakeWatcher[] = [];
  const factory: PlanFileWatcherFactory = (directoryPath, onChange, onError) => {
    const watcher: FakeWatcher = { directoryPath, fireChange: onChange, fireError: onError, isClosed: false };
    opened.push(watcher);
    return { close: () => { watcher.isClosed = true; } };
  };
  return { opened, factory };
}

function workspace(name: string, options: PlanReviewWiringOptions = {}) {
  const configDirectory = fs.mkdtempSync(path.join(claudeHome, `${name}-`));
  temporaryDirectories.push(configDirectory);
  const warnings: string[] = [];
  const lane = createPlanReviewWiring({
    configPath: path.join(configDirectory, 'config.json'),
    logger: { warn: (message: string) => { warnings.push(message); } },
    nowFn: () => 7,
    ...options,
  });
  return { lane, warnings, configDirectory };
}

function watchedWorkspace(name: string) {
  const timers = manualTimers();
  const watchers = fakeWatchers();
  return {
    ...workspace(name, {
      watchPlanFileFn: watchers.factory,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    }),
    timers,
    watchers,
  };
}

async function openPlan(
  lane: PlanLane,
  { sessionId = 'session-1', planFilePath = planPath('a.md'), agentId = null as string | null, plan = '# Ship it' } = {},
): Promise<void> {
  lane.onHookEvent({
    glimmervoidId: sessionId,
    event: 'permissionrequest-plan',
    payload: {
      tool_name: 'ExitPlanMode',
      tool_input: { plan, planFilePath },
      ...(agentId ? { agent_id: agentId, agent_type: 'Explore' } : {}),
    },
    accepted: true,
  });
  await lane.whenIdle();
}

function fireDebounce(timers: ManualTimers): void {
  for (const timer of timers.pending) {
    if (timer.cleared || timer.ms !== DRAFT_DEBOUNCE_MS) continue;
    timer.cleared = true;
    timer.fn();
  }
}

function draftNotices(lane: PlanLane): PlanDraftNotice[] {
  const notices: PlanDraftNotice[] = [];
  lane.on('plan-draft', (notice: PlanDraftNotice) => { notices.push(notice); });
  return notices;
}

test('an open revision watches the plan directory, filters by the file the hook named, and a burst pushes one notice', async () => {
  const { lane, timers, watchers } = watchedWorkspace('one-notice');
  const notices = draftNotices(lane);
  await openPlan(lane, { planFilePath: planPath('session.md') });

  assert.equal(watchers.opened.length, 1, 'one watcher per open review');
  assert.equal(watchers.opened[0].directoryPath, realPlansRoot, 'the parent directory is what is watched');
  assert.deepEqual(notices, [], 'a watcher on its own pushes nothing');

  watchers.opened[0].fireChange('another-session.md');
  fireDebounce(timers);
  assert.deepEqual(notices, [], 'another file in the same directory is not this review draft');

  watchers.opened[0].fireChange('session.md');
  watchers.opened[0].fireChange('session.md');
  watchers.opened[0].fireChange(null);
  assert.deepEqual(notices, [], 'nothing is pushed until the debounce elapses');

  fireDebounce(timers);
  assert.deepEqual(notices, [{ id: 'session-1', agentId: null, planFilePath: planPath('session.md'), changedAt: 7 }]);
  await lane.stop();
});

test('an atomic replace keeps notifying, since the directory watch is never rearmed on a rename', async () => {
  const { lane, timers, watchers } = watchedWorkspace('atomic-replace');
  const notices = draftNotices(lane);
  const planFilePath = planPath('atomic.md');
  fs.writeFileSync(planFilePath, '# Ship it\n');
  await openPlan(lane, { planFilePath });

  watchers.opened[0].fireChange('atomic.md');
  fireDebounce(timers);

  fs.rmSync(planFilePath);
  fs.writeFileSync(planFilePath, '# Ship it, rewritten\n');
  watchers.opened[0].fireChange('atomic.md');
  fireDebounce(timers);

  assert.equal(watchers.opened.length, 1, 'a replaced file needs no second watcher');
  assert.equal(watchers.opened[0].isClosed, false);
  assert.deepEqual(notices, [
    { id: 'session-1', agentId: null, planFilePath, changedAt: 7 },
    { id: 'session-1', agentId: null, planFilePath, changedAt: 7 },
  ], 'the write after the replacement still raises the chip');
  await lane.stop();
});

test('a second revision on the same review keeps the one watcher, and a new path replaces it', async () => {
  const { lane, timers, watchers } = watchedWorkspace('same-review');
  const notices = draftNotices(lane);
  await openPlan(lane, { planFilePath: planPath('session.md') });
  await openPlan(lane, { planFilePath: planPath('session.md'), plan: '# Ship it again' });
  assert.equal(watchers.opened.length, 1, 'the same file is never watched twice');

  await openPlan(lane, { planFilePath: planPath('renamed.md'), plan: '# Ship it once more' });
  assert.equal(watchers.opened.length, 2);
  assert.equal(watchers.opened[0].isClosed, true, 'the watcher on the old path is closed');
  assert.equal(watchers.opened[1].directoryPath, realPlansRoot);

  watchers.opened[1].fireChange('session.md');
  fireDebounce(timers);
  assert.deepEqual(notices, [], 'the replaced watcher filters on the file the newest revision named');

  watchers.opened[1].fireChange('renamed.md');
  fireDebounce(timers);
  assert.deepEqual(notices, [{ id: 'session-1', agentId: null, planFilePath: planPath('renamed.md'), changedAt: 7 }]);
  await lane.stop();
});

test('a subagent review watches its own file beside the main review', async () => {
  const { lane, timers, watchers } = watchedWorkspace('subagent');
  const notices = draftNotices(lane);
  await openPlan(lane, { planFilePath: planPath('main.md') });
  await openPlan(lane, { planFilePath: planPath('explore.md'), agentId: 'sub-1' });
  assert.equal(watchers.opened.length, 2);

  watchers.opened[1].fireChange('explore.md');
  fireDebounce(timers);
  assert.deepEqual(notices, [{ id: 'session-1', agentId: 'sub-1', planFilePath: planPath('explore.md'), changedAt: 7 }]);
  await lane.stop();
});

test('closing the review closes its watcher, and a decision leaves it open for the next draft', async () => {
  const { lane, watchers } = watchedWorkspace('close');
  await openPlan(lane, { planFilePath: planPath('session.md') });

  assert.equal(lane.decide('session-1', { id: 'session-1', agentId: null, revision: 1, decision: 'revise', feedback: 'no' }), null);
  assert.equal(watchers.opened[0].isClosed, false, 'a deny is exactly when the next draft is written');

  lane.onHookEvent({ glimmervoidId: 'session-1', event: 'Stop', payload: {}, accepted: true });
  await lane.whenIdle();
  assert.equal(watchers.opened[0].isClosed, true, 'a closed review watches nothing');
  await lane.stop();
});

test('a session end and a lane stop each close every watcher they own', async () => {
  const { lane, watchers } = watchedWorkspace('session-end');
  await openPlan(lane, { sessionId: 'session-1', planFilePath: planPath('one.md') });
  await openPlan(lane, { sessionId: 'session-2', planFilePath: planPath('two.md') });

  lane.onHookEvent({ glimmervoidId: 'session-1', event: 'SessionEnd', payload: {}, accepted: true });
  await lane.whenIdle();
  assert.equal(watchers.opened[0].isClosed, true);
  assert.equal(watchers.opened[1].isClosed, false, 'another session keeps its own watcher');

  await lane.stop();
  assert.equal(watchers.opened[1].isClosed, true, 'shutdown leaves no watcher behind');
});

test('a watch error is logged once and disables the chip for that review, never the lane', async () => {
  const { lane, warnings, timers, watchers } = watchedWorkspace('watch-error');
  const notices = draftNotices(lane);
  await openPlan(lane, { sessionId: 'session-1', planFilePath: planPath('one.md') });
  await openPlan(lane, { sessionId: 'session-2', planFilePath: planPath('two.md') });

  watchers.opened[0].fireError(new Error('ENOSPC watchers exhausted'));
  watchers.opened[0].fireError(new Error('ENOSPC watchers exhausted'));
  const draftWarnings = warnings.filter((message) => message.includes('draft watch'));
  assert.equal(draftWarnings.length, 1, 'the error is logged once, not once per event');
  assert.match(draftWarnings[0], /session-1/);
  assert.equal(watchers.opened[0].isClosed, true);

  watchers.opened[0].fireChange('one.md');
  fireDebounce(timers);
  assert.deepEqual(notices, [], 'a disabled review pushes nothing');

  await openPlan(lane, { sessionId: 'session-1', planFilePath: planPath('one.md'), plan: '# Again' });
  assert.equal(watchers.opened.length, 2, 'the disabled review never reopens a watcher');

  watchers.opened[1].fireChange('two.md');
  fireDebounce(timers);
  assert.deepEqual(
    notices,
    [{ id: 'session-2', agentId: null, planFilePath: planPath('two.md'), changedAt: 7 }],
    'one review losing its watch leaves every other review watching',
  );
  await lane.stop();
});

test('a watcher the platform refuses to open disables that review instead of failing the request', async () => {
  const { lane, warnings } = workspace('watch-throws', {
    watchPlanFileFn: () => { throw new Error('ENOENT no such file'); },
  });
  await openPlan(lane, { planFilePath: planPath('gone.md') });
  assert.equal(
    (await lane.readPlanRevision('session-1', {}))?.body?.plan,
    '# Ship it',
    'the revision is stored whatever the watcher does',
  );
  assert.equal(warnings.filter((message) => message.includes('draft watch')).length, 1);
  await lane.stop();
});

test('the draft body is read from the path the hook delivered and marked as a draft, never as a revision', async () => {
  const { lane } = workspace('draft-read');
  const planFilePath = planPath('draft-read.md');
  fs.writeFileSync(planFilePath, '# Ship it\n\nthe stored revision\n');
  await openPlan(lane, { planFilePath });
  fs.writeFileSync(planFilePath, '# Ship it\n\nthe newer draft\n');

  const draft = await lane.readPlanRevision('session-1', { agentId: null, draft: true });
  assert.equal(draft?.body?.plan, '# Ship it\n\nthe newer draft\n');
  assert.equal(draft?.body?.revision, 0, 'revision zero is what marks a body as a draft');
  assert.equal(draft?.body?.planFilePath, planFilePath);
  assert.equal(draft?.reviews.length, 1, 'a draft read carries the same review index as a revision read');

  const stored = await lane.readPlanRevision('session-1', { agentId: null });
  assert.equal(stored?.body?.plan, '# Ship it', 'the stored revision is untouched by whatever the file now holds');
  await lane.stop();
});

test('a draft over the plan cap and a draft for a session with nothing stored are both refused', async () => {
  const { lane, warnings } = workspace('draft-cap');
  const planFilePath = planPath('draft-cap.md');
  fs.writeFileSync(planFilePath, '# Ship it\n');
  await openPlan(lane, { planFilePath });

  fs.writeFileSync(planFilePath, 'y'.repeat(PLAN_BODY_CAP_BYTES + 1));
  const oversized = await lane.readPlanRevision('session-1', { agentId: null, draft: true });
  assert.equal(oversized?.body, null, 'an oversized draft is refused rather than truncated');
  assert.match(warnings.filter((message) => message.includes('over the plan cap'))[0], /session-1/);

  assert.equal(await lane.readPlanRevision('session-2', { agentId: null, draft: true }), null);
  await lane.stop();
});

test('a draft path outside the plans directory never opens a watch, so it raises no chip at all', async () => {
  const { lane, warnings, watchers } = watchedWorkspace('draft-outside-root');
  const notices = draftNotices(lane);
  const outsidePath = path.join(os.tmpdir(), `glimmervoid-plan-outside-${process.pid}.md`);
  fs.writeFileSync(outsidePath, '# Whatever the attacker wrote\n');
  temporaryFiles.push(outsidePath);
  await openPlan(lane, { planFilePath: outsidePath });

  assert.equal(watchers.opened.length, 0, 'containment runs before the watch, so no chip is ever raised');
  assert.match(warnings.filter((message) => message.includes('draft watch'))[0], /reason=outside-root/);
  assert.deepEqual(notices, []);

  const draft = await lane.readPlanRevision('session-1', { agentId: null, draft: true });
  assert.equal(draft?.body, null, 'a path the plans directory does not contain is never read');
  assert.match(warnings.filter((message) => message.includes('draft read refused'))[0], /reason=outside-root/);
  assert.equal(
    (await lane.readPlanRevision('session-1', {}))?.body?.plan,
    '# Ship it',
    'the refusal settles, so every later step on the chain still runs',
  );
  await lane.stop();
});

test('a draft path elsewhere under the Claude config home is refused, not only one outside it', async () => {
  const { lane, warnings, watchers } = watchedWorkspace('draft-config-home');
  const credentialsPath = path.join(claudeHome, '.credentials.json');
  fs.writeFileSync(credentialsPath, '{"token":"secret"}\n');
  temporaryFiles.push(credentialsPath);
  await openPlan(lane, { planFilePath: credentialsPath });

  assert.equal(watchers.opened.length, 0);
  const draft = await lane.readPlanRevision('session-1', { agentId: null, draft: true });
  assert.equal(draft?.body, null, 'the config home holds credentials and transcripts, so only its plans directory is a root');
  assert.match(warnings.filter((message) => message.includes('draft read refused'))[0], /reason=outside-root/);
  await lane.stop();
});

test('a draft path that is a named pipe is refused instead of hanging the operation chain', {
  skip: process.platform === 'win32',
  timeout: 10000,
}, async () => {
  const { lane, warnings } = watchedWorkspace('draft-fifo');
  const fifoPath = planPath(`draft-fifo-${process.pid}.md`);
  execFileSync('mkfifo', [fifoPath]);
  temporaryFiles.push(fifoPath);
  await openPlan(lane, { planFilePath: fifoPath });

  const draft = await lane.readPlanRevision('session-1', { agentId: null, draft: true });
  assert.equal(draft?.body, null, 'a reader-less pipe answers at once rather than blocking on open');
  assert.match(warnings.filter((message) => message.includes('draft read refused'))[0], /reason=not-a-regular-file/);
  assert.equal(
    (await lane.readPlanRevision('session-1', {}))?.body?.plan,
    '# Ship it',
    'the next exclusive step runs, so no hold, lifecycle event or shutdown is wedged',
  );
  await lane.stop();
});

test('a draft file that is not there yet keeps its watch, since the next write is what a rewrite looks like', async () => {
  const { lane, warnings, timers, watchers } = watchedWorkspace('draft-missing-keeps-watch');
  const notices = draftNotices(lane);
  const planFilePath = planPath('draft-missing-keeps-watch.md');
  await openPlan(lane, { planFilePath });

  assert.equal((await lane.readPlanRevision('session-1', { agentId: null, draft: true }))?.body, null);
  assert.match(warnings.filter((message) => message.includes('draft read refused'))[0], /reason=missing/);
  assert.equal(watchers.opened.length, 1, 'the directory is contained even when the file is not there yet');
  assert.equal(watchers.opened[0].isClosed, false);

  watchers.opened[0].fireChange('draft-missing-keeps-watch.md');
  fireDebounce(timers);
  assert.deepEqual(notices, [{ id: 'session-1', agentId: null, planFilePath, changedAt: 7 }]);
  await lane.stop();
});
