import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Session } from '../session/sessions.ts';
import { PLAN_BODY_CAP_BYTES } from '../shared/contracts/plan-review.ts';
import { composePlanFeedback } from '../server/core/plan-feedback-core.ts';
import { createPlanReviewWiring } from '../server/plan-review-wiring.ts';
import type { PlanReadResult } from '../server/plan-review-wiring.ts';
import { plainSession } from './helpers/fake-session.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';

const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-control-plan-claude-'));
process.env.CLAUDE_CONFIG_DIR = claudeHome;

const temporaryDirectories: string[] = [claudeHome];
after(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

interface PlanFrameReview {
  agentId: string | null;
  agentType: string | null;
  revisions: { revision: number }[];
  state: string;
  approvedRevision: number | null;
}

interface PlanFrame {
  type: string;
  id?: string;
  scope?: string;
  reviews?: PlanFrameReview[];
  body?: { agentId: string | null; revision: number; plan: string; planFilePath: string; receivedAt: number } | null;
  message?: string;
}

type PlanReader = (
  sessionId: string,
  request: { agentId?: string | null; revision?: number | null },
) => Promise<PlanReadResult | null>;

function reviewOf(source: { reviews?: PlanFrameReview[] } | null | undefined, agentId: string | null = null) {
  return source?.reviews?.find((review) => review.agentId === agentId) ?? null;
}

type PlanLane = ReturnType<typeof createPlanReviewWiring>;

async function openPlan(lane: PlanLane, event: Parameters<PlanLane['onHookEvent']>[0]): Promise<void> {
  const held = lane.onHookEvent(event);
  heldReplies.push(held);
  await lane.whenIdle();
}

const heldReplies: (Promise<Record<string, unknown> | null> | null)[] = [];

function planWorkspace(name: string) {
  const configDirectory = fs.mkdtempSync(path.join(claudeHome, `${name}-`));
  temporaryDirectories.push(configDirectory);
  return createPlanReviewWiring({
    configPath: path.join(configDirectory, 'config.json'),
    logger: { warn: () => {} },
    nowFn: () => 7,
  });
}

function planRequest(plan: string, agentId: string | null = null, agentType: string | null = null) {
  return {
    tool_name: 'ExitPlanMode',
    tool_input: { plan, planFilePath: '/plans/a.md' },
    ...(agentId ? { agent_id: agentId } : {}),
    ...(agentType ? { agent_type: agentType } : {}),
  };
}

function planHarness(readPlanRevision: PlanReader | null, decidePlanReview: PlanLane['decide'] | null = null) {
  const session = plainSession('session-1');
  const sessions = new Map<string, Session>([[session.id, session]]);
  const server = createControlServer(controlDeps({ projects: [] }, { sessions, readPlanRevision, decidePlanReview }));
  const connection = connectControl<PlanFrame>(server, { trust: 'local' });
  connection.sent.length = 0;
  return connection;
}

test('a plan body crosses the control socket only on request, never as a push', async () => {
  const lane = planWorkspace('body-on-request');
  const pushed: Record<string, unknown>[] = [];
  lane.on('plan-changed', (summary: Record<string, unknown>) => { pushed.push(summary); });
  await openPlan(lane, {
    glissaId: 'session-1',
    event: 'permissionrequest-plan',
    payload: planRequest('# Ship it\n\nthe body'),
    accepted: true,
  });
  assert.equal(pushed.length, 1);
  assert.deepEqual(
    Object.keys(pushed[0]).sort(),
    ['agentId', 'agentType', 'approvedRevision', 'chars', 'hasPlan', 'id', 'lastDecision', 'receivedAt', 'revision', 'state', 'title'],
  );
  assert.equal(pushed[0].title, 'Ship it');
  assert.equal(pushed[0].hasPlan, true);
  assert.equal(pushed[0].receivedAt, 7);
  assert.equal(pushed[0].agentType, null);

  const connection = planHarness(lane.readPlanRevision);
  await connection.send({ type: 'session-plan', id: 'session-1', agentId: null });
  const response = connection.sent.find((frame) => frame.type === 'session-plan-response');
  assert.ok(response, 'the body came back on request');
  assert.equal(response.body?.plan, '# Ship it\n\nthe body');
  assert.equal(response.body?.revision, 1);
  assert.equal(reviewOf(response)?.state, 'open', 'the reply is held until the operator decides');
  await lane.stop();
});

test('a named revision is served by its own offset, not the newest', async () => {
  const lane = planWorkspace('by-revision');
  for (const plan of ['# First plan', '# Second plan']) {
    await openPlan(lane, {
      glissaId: 'session-1', event: 'permissionrequest-plan', payload: planRequest(plan), accepted: true,
    });
  }
  const connection = planHarness(lane.readPlanRevision);
  await connection.send({ type: 'session-plan', id: 'session-1', agentId: null, revision: 1 });
  await connection.send({ type: 'session-plan', id: 'session-1', agentId: null });
  const responses = connection.sent.filter((frame) => frame.type === 'session-plan-response');
  assert.equal(responses.length, 2);
  assert.equal(responses[0].body?.plan, '# First plan');
  assert.equal(responses[1].body?.plan, '# Second plan');
  assert.deepEqual(reviewOf(responses[1])?.revisions.map((entry) => entry.revision), [1, 2]);
  await lane.stop();
});

test('two subagent reviews in one session keep their own revision numbering and bodies', async () => {
  const lane = planWorkspace('subagents');
  await openPlan(lane, {
    glissaId: 'session-1', event: 'permissionrequest-plan', payload: planRequest('# Main plan'), accepted: true,
  });
  await openPlan(lane, {
    glissaId: 'session-1',
    event: 'permissionrequest-plan',
    payload: planRequest('# Explore plan', 'sub-1', 'Explore'),
    accepted: true,
  });
  const connection = planHarness(lane.readPlanRevision);
  await connection.send({ type: 'session-plan', id: 'session-1', agentId: 'sub-1' });
  const response = connection.sent.find((frame) => frame.type === 'session-plan-response');
  assert.equal(response?.body?.plan, '# Explore plan');
  assert.equal(response?.body?.revision, 1, 'a subagent review starts its own numbering at one');
  assert.equal(response?.body?.agentId, 'sub-1');
  assert.deepEqual(response?.reviews?.map((review) => review.agentId), [null, 'sub-1']);
  await lane.stop();
});

test('an ended session is served from the file the lane no longer holds in memory', async () => {
  const lane = planWorkspace('ended-session');
  await openPlan(lane, {
    glissaId: 'session-1', event: 'permissionrequest-plan', payload: planRequest('# Ship it'), accepted: true,
  });
  lane.onHookEvent({ glissaId: 'session-1', event: 'SessionEnd', payload: {}, accepted: true });
  const connection = planHarness(lane.readPlanRevision);
  await connection.send({ type: 'session-plan', id: 'session-1', agentId: null });
  const response = connection.sent.find((frame) => frame.type === 'session-plan-response');
  assert.equal(response?.body?.plan, '# Ship it');
  assert.equal(reviewOf(response)?.state, 'closed');
  await lane.stop();
});

test('a missing plan and a disabled lane are both reported through session-error copy', async () => {
  const lane = planWorkspace('missing-plan');
  const connection = planHarness(lane.readPlanRevision);
  await connection.send({ type: 'session-plan', id: 'session-1', agentId: null });
  assert.equal(connection.sent.at(-1)?.type, 'error');
  assert.match(String(connection.sent.at(-1)?.message), /not found/);

  const disabled = planHarness(null);
  await disabled.send({ type: 'session-plan', id: 'session-1', agentId: null });
  assert.match(String(disabled.sent.at(-1)?.message), /not enabled/);
  await lane.stop();
});

test('a session id that is not a safe path segment never reaches the plans directory', async () => {
  const lane = planWorkspace('unsafe-id');
  await openPlan(lane, {
    glissaId: '../escape', event: 'permissionrequest-plan', payload: planRequest('# Ship it'), accepted: true,
  });
  assert.equal(lane.port.hasPlan('../escape'), false);
  assert.equal(await lane.readPlanRevision('../escape', {}), null);
  await lane.stop();
});

test('an approval on the terminal closes the review and records which revision was approved', async () => {
  const lane = planWorkspace('approved');
  const states: string[] = [];
  lane.on('plan-changed', (summary: { state: string }) => { states.push(summary.state); });
  await openPlan(lane, {
    glissaId: 'session-1', event: 'permissionrequest-plan', payload: planRequest('# Ship it'), accepted: true,
  });
  lane.onHookEvent({
    glissaId: 'session-1',
    event: 'PostToolUse',
    payload: { tool_name: 'ExitPlanMode', tool_response: { plan: '# Ship it' } },
    accepted: true,
  });
  const result = await lane.readPlanRevision('session-1', {});
  assert.deepEqual(states, ['open', 'closed']);
  assert.equal(reviewOf(result)?.state, 'closed');
  assert.equal(reviewOf(result)?.approvedRevision, 1);
  await lane.stop();
});

test('a tool result for another tool leaves the review alone', async () => {
  const lane = planWorkspace('other-tool');
  await openPlan(lane, {
    glissaId: 'session-1', event: 'permissionrequest-plan', payload: planRequest('# Ship it'), accepted: true,
  });
  lane.onHookEvent({ glissaId: 'session-1', event: 'PostToolUse', payload: { tool_name: 'Read' }, accepted: true });
  assert.equal(reviewOf(await lane.readPlanRevision('session-1', {}))?.state, 'open');
  await lane.stop();
});

test('a turn end closes the main review and a subagent stop closes only its own', async () => {
  const lane = planWorkspace('turn-end');
  await openPlan(lane, {
    glissaId: 'session-1', event: 'permissionrequest-plan', payload: planRequest('# Main plan'), accepted: true,
  });
  await openPlan(lane, {
    glissaId: 'session-1',
    event: 'permissionrequest-plan',
    payload: planRequest('# Explore plan', 'sub-1', 'Explore'),
    accepted: true,
  });
  lane.onHookEvent({ glissaId: 'session-1', event: 'SubagentStop', payload: { agent_id: 'sub-1' }, accepted: true });
  assert.equal(reviewOf(await lane.readPlanRevision('session-1', { agentId: 'sub-1' }), 'sub-1')?.state, 'closed');
  assert.equal(reviewOf(await lane.readPlanRevision('session-1', {}))?.state, 'open', 'a subagent stop leaves the main review actionable');

  lane.onHookEvent({ glissaId: 'session-1', event: 'Stop', payload: {}, accepted: true });
  assert.equal(reviewOf(await lane.readPlanRevision('session-1', {}))?.state, 'closed');
  await lane.stop();
});

test('a hook the router refused is never stored, whatever its body says', async () => {
  const lane = planWorkspace('refused-hook');
  await openPlan(lane, {
    glissaId: 'session-1', event: 'permissionrequest-plan', payload: planRequest('# Ship it'), accepted: false,
  });
  assert.equal(lane.port.hasPlan('session-1'), false);
  await lane.stop();
});

test('a revision after a close reopens the same review at the next number', async () => {
  const lane = planWorkspace('reopen');
  await openPlan(lane, {
    glissaId: 'session-1', event: 'permissionrequest-plan', payload: planRequest('# First'), accepted: true,
  });
  lane.onHookEvent({ glissaId: 'session-1', event: 'Stop', payload: {}, accepted: true });
  await openPlan(lane, {
    glissaId: 'session-1', event: 'permissionrequest-plan', payload: planRequest('# Second'), accepted: true,
  });
  const result = await lane.readPlanRevision('session-1', {});
  assert.equal(result?.body?.revision, 2);
  assert.equal(reviewOf(result)?.state, 'open');
  await lane.stop();
});

test('a subagent-only plan is discoverable from the index request the reloaded client sends', async () => {
  const lane = planWorkspace('index-after-reload');
  await openPlan(lane, {
    glissaId: 'session-1',
    event: 'permissionrequest-plan',
    payload: planRequest('# Explore plan', 'sub-1', 'Explore'),
    accepted: true,
  });
  const connection = planHarness(lane.readPlanRevision);
  await connection.send({ type: 'session-plan', id: 'session-1', agentId: null });
  const index = connection.sent.find((frame) => frame.type === 'session-plan-response');
  assert.ok(index, 'the index came back even though the main agent never planned');
  assert.equal(index.body, null);
  assert.deepEqual(index.reviews?.map((review) => [review.agentId, review.agentType]), [['sub-1', 'Explore']]);

  await connection.send({ type: 'session-plan', id: 'session-1', agentId: 'sub-1' });
  const body = connection.sent.filter((frame) => frame.type === 'session-plan-response').at(-1);
  assert.equal(body?.body?.plan, '# Explore plan');
  await lane.stop();
});

test('a revision the client names but the store never held is refused rather than answered empty', async () => {
  const lane = planWorkspace('missing-revision');
  await openPlan(lane, {
    glissaId: 'session-1', event: 'permissionrequest-plan', payload: planRequest('# Ship it'), accepted: true,
  });
  const connection = planHarness(lane.readPlanRevision);
  await connection.send({ type: 'session-plan', id: 'session-1', agentId: null, revision: 9 });
  assert.equal(connection.sent.at(-1)?.type, 'error');
  assert.match(String(connection.sent.at(-1)?.message), /not found/);
  await lane.stop();
});

test('every plan summary reaches every control client, and the body request reaches the lane', () => {
  const lanesSource = fs.readFileSync(new URL('../server/backend-lanes.ts', import.meta.url), 'utf8');
  assert.match(lanesSource, /planReview\?\.on\('plan-changed'/);
  assert.match(lanesSource, /broadcastControl\(\{ type: 'session-plan-changed', \.\.\.summary \}\)/);
  const backendSource = fs.readFileSync(new URL('../server/backend.ts', import.meta.url), 'utf8');
  assert.match(backendSource, /readPlanRevision: laneAssembly\.planReview\?\.readPlanRevision \?\? null/);
  assert.match(backendSource, /getPlanReviewPort: \(\) => laneAssembly\.planReview\?\.port \?\? null/);
});

test('a plan read for a session with no live Session never pins its file against the retention window', async () => {
  const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-control-plan-retention-'));
  temporaryDirectories.push(configDirectory);
  const lane = createPlanReviewWiring({
    configPath: path.join(configDirectory, 'config.json'),
    logger: { warn: () => {} },
  });
  const liveSession = plainSession('live-session');
  lane.attachSession(liveSession);
  for (const sessionId of ['dormant-session', 'live-session']) {
    await openPlan(lane, {
      glissaId: sessionId, event: 'permissionrequest-plan', payload: planRequest('# Ship it'), accepted: true,
    });
  }

  const aged = new Date(Date.now() - (40 * 24 * 60 * 60 * 1000));
  const planFileOf = (sessionId: string) => path.join(configDirectory, 'plans', `${sessionId}.jsonl`);
  for (const sessionId of ['dormant-session', 'live-session']) {
    fs.utimesSync(planFileOf(sessionId), aged, aged);
  }

  const read = await lane.readPlanRevision('dormant-session', { agentId: null });
  assert.equal(read?.body?.plan, '# Ship it');

  await lane.start();
  assert.equal(fs.existsSync(planFileOf('dormant-session')), false, 'reading a dormant plan never makes it live');
  assert.equal(fs.existsSync(planFileOf('live-session')), true, 'an attached session keeps its plan file');
  await lane.stop();
});

test('the title the notification reads is the title of the entry the lane pushed', async () => {
  const lane = planWorkspace('notify-title');
  const pushed: Record<string, unknown>[] = [];
  lane.on('plan-changed', (summary: Record<string, unknown>) => { pushed.push(summary); });

  assert.equal(lane.latestPlanTitle('session-1'), null, 'a session with nothing stored names no plan');

  await openPlan(lane, {
    glissaId: 'session-1', event: 'permissionrequest-plan', payload: planRequest('# Ship the rollout'), accepted: true,
  });
  assert.equal(lane.latestPlanTitle('session-1'), 'Ship the rollout');
  assert.equal(pushed.at(-1)?.title, 'Ship the rollout');

  await openPlan(lane, {
    glissaId: 'session-1', event: 'permissionrequest-plan', payload: planRequest('# Ship it again', 'sub-3', 'Explore'), accepted: true,
  });
  assert.equal(lane.latestPlanTitle('session-1'), 'Ship it again');
  assert.equal(pushed.at(-1)?.title, 'Ship it again');

  await lane.stop();
});

test('a decision is refused unless it names the open revision of an open review', async () => {
  const lane = planWorkspace('decision-guards');
  await openPlan(lane, {
    glissaId: 'session-1', event: 'permissionrequest-plan', payload: planRequest('# Ship it'), accepted: true,
  });
  const connection = planHarness(lane.readPlanRevision, lane.decide);

  await connection.send({ type: 'plan-decision', id: 'session-1', agentId: null, revision: 9, decision: 'approve' });
  const stale = connection.sent.at(-1);
  assert.equal(stale?.type, 'session-error');
  assert.match(String(stale?.message), /names revision 9, but revision 1 is open/);

  await connection.send({ type: 'plan-decision', id: 'no-such-session', agentId: null, revision: 1, decision: 'approve' });
  assert.match(String(connection.sent.at(-1)?.message), /Session not found/);

  await connection.send({ type: 'plan-decision', id: 'session-1', agentId: 'sub-9', revision: 1, decision: 'approve' });
  assert.match(String(connection.sent.at(-1)?.message), /no longer open/, 'a review that never opened takes no decision');

  assert.equal(reviewOf(await lane.readPlanRevision('session-1', {}))?.state, 'open', 'a refused decision changes nothing');

  await connection.send({ type: 'plan-decision', id: 'session-1', agentId: null, revision: 1, decision: 'terminal' });
  assert.equal(reviewOf(await lane.readPlanRevision('session-1', {}))?.state, 'released');

  await connection.send({ type: 'plan-decision', id: 'session-1', agentId: null, revision: 1, decision: 'approve' });
  assert.match(String(connection.sent.at(-1)?.message), /no longer open/, 'a released review takes no second decision');
  await lane.stop();
});

test('a decision refusal names the plan scope so a trace error can never strand the plan face', async () => {
  const lane = planWorkspace('decision-scope');
  const connection = planHarness(lane.readPlanRevision, lane.decide);
  await connection.send({ type: 'plan-decision', id: 'session-1', agentId: null, revision: 1, decision: 'approve' });
  const refusal = connection.sent.at(-1);
  assert.equal(refusal?.type, 'session-error');
  assert.equal(refusal?.scope, 'plan-decision');

  const disabled = planHarness(null, null);
  await disabled.send({ type: 'plan-decision', id: 'session-1', agentId: null, revision: 1, decision: 'approve' });
  assert.equal(disabled.sent.at(-1)?.scope, 'plan-decision');
  assert.match(String(disabled.sent.at(-1)?.message), /not enabled/);
  await lane.stop();
});

test('deciding one subagent review leaves the other actionable', async () => {
  const lane = planWorkspace('two-subagents');
  for (const agentId of ['sub-1', 'sub-2']) {
    await openPlan(lane, {
      glissaId: 'session-1',
      event: 'permissionrequest-plan',
      payload: planRequest(`# ${agentId} plan`, agentId, 'Explore'),
      accepted: true,
    });
  }
  const connection = planHarness(lane.readPlanRevision, lane.decide);
  await connection.send({ type: 'plan-decision', id: 'session-1', agentId: 'sub-1', revision: 1, decision: 'approve' });
  assert.equal(connection.sent.filter((frame) => frame.type === 'session-error').length, 0);

  const index = await lane.readPlanRevision('session-1', { agentId: 'sub-2' });
  assert.equal(reviewOf(index, 'sub-1')?.state, 'decided');
  assert.equal(reviewOf(index, 'sub-2')?.state, 'open');
  assert.equal(index?.body?.plan, '# sub-2 plan');
  await lane.stop();
});

interface HeldReply {
  reply: Promise<Record<string, unknown> | null>;
}

async function openHeld(lane: PlanLane, plan = '# Ship it'): Promise<HeldReply> {
  const held = lane.onHookEvent({
    glissaId: 'session-1',
    event: 'permissionrequest-plan',
    payload: planRequest(plan),
    accepted: true,
  });
  assert.ok(held, 'the lane held the reply');
  await lane.whenIdle();
  return { reply: held };
}

test('the deny message the hook reply carries is the text the section comments composed', async () => {
  const lane = planWorkspace('composed-deny');
  const { reply: held } = await openHeld(lane);
  const connection = planHarness(lane.readPlanRevision, lane.decide);
  const comments = [
    { heading: 'Rollout', comment: 'stage it behind the flag' },
    { heading: null, comment: 'no rollback story anywhere' },
  ];
  await connection.send({
    type: 'plan-decision',
    id: 'session-1',
    agentId: null,
    revision: 1,
    decision: 'revise',
    feedback: 'the whole thing is too long',
    comments,
  });

  assert.deepEqual(await held, {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'deny',
        message: composePlanFeedback({ revision: 1, comments, feedback: 'the whole thing is too long' }),
      },
    },
  });
  assert.equal(connection.sent.filter((frame) => frame.type === 'session-error').length, 0);
  await lane.stop();
});

test('an approve carrying an edited plan puts the edit in updatedInput, and the path stays the one received', async () => {
  const lane = planWorkspace('edited-approve');
  const { reply: held } = await openHeld(lane);
  const connection = planHarness(lane.readPlanRevision, lane.decide);
  await connection.send({
    type: 'plan-decision',
    id: 'session-1',
    agentId: null,
    revision: 1,
    decision: 'approve-accept-edits',
    plan: '# Ship it\n\nwith the operator step',
  });

  assert.deepEqual(await held, {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'allow',
        updatedInput: { plan: '# Ship it\n\nwith the operator step', planFilePath: '/plans/a.md' },
        updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      },
    },
  });
  await lane.stop();
});

test('an edited plan over the byte cap is refused and the review stays open for a smaller one', async () => {
  const lane = planWorkspace('edited-cap');
  const { reply: held } = await openHeld(lane);
  const connection = planHarness(lane.readPlanRevision, lane.decide);
  const overCap = String.fromCharCode(0x4e2d).repeat(PLAN_BODY_CAP_BYTES / 2);
  assert.ok(overCap.length <= PLAN_BODY_CAP_BYTES, 'the edit is inside the character cap the wire enforces');
  await connection.send({
    type: 'plan-decision', id: 'session-1', agentId: null, revision: 1, decision: 'approve', plan: overCap,
  });

  const refusal = connection.sent.at(-1);
  assert.equal(refusal?.type, 'session-error');
  assert.match(String(refusal?.message), /larger than the plan hook carries/);
  assert.equal(reviewOf(await lane.readPlanRevision('session-1', {}))?.state, 'open');

  await connection.send({
    type: 'plan-decision', id: 'session-1', agentId: null, revision: 1, decision: 'approve', plan: '# Small',
  });
  assert.deepEqual(await held, {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow', updatedInput: { plan: '# Small', planFilePath: '/plans/a.md' } },
    },
  });
  await lane.stop();
});

test('an edit naming a revision the review has moved past is refused before it reaches the reply', async () => {
  const lane = planWorkspace('edited-stale');
  await openHeld(lane, '# First');
  const { reply: second } = await openHeld(lane, '# Second');
  const connection = planHarness(lane.readPlanRevision, lane.decide);
  await connection.send({
    type: 'plan-decision', id: 'session-1', agentId: null, revision: 1, decision: 'approve', plan: '# Edited first',
  });
  assert.match(String(connection.sent.at(-1)?.message), /names revision 1, but revision 2 is open/);

  await connection.send({ type: 'plan-decision', id: 'session-1', agentId: null, revision: 2, decision: 'terminal' });
  assert.deepEqual(await second, {});
  await lane.stop();
});

test('a draft body crosses the socket only when the client asks for one', async () => {
  const lane = planWorkspace('draft-request');
  const plansDirectory = path.join(claudeHome, 'plans');
  fs.mkdirSync(plansDirectory, { recursive: true });
  const planFilePath = path.join(plansDirectory, 'draft.md');
  fs.writeFileSync(planFilePath, '# Ship it');
  lane.onHookEvent({
    glissaId: 'session-1',
    event: 'permissionrequest-plan',
    payload: { tool_name: 'ExitPlanMode', tool_input: { plan: '# Ship it', planFilePath } },
    accepted: true,
  });
  await lane.whenIdle();
  fs.writeFileSync(planFilePath, '# Ship it\n\nthe draft the agent is writing');

  const connection = planHarness(lane.readPlanRevision);
  await connection.send({ type: 'session-plan', id: 'session-1', agentId: null });
  await connection.send({ type: 'session-plan', id: 'session-1', agentId: null, draft: true });
  const responses = connection.sent.filter((frame) => frame.type === 'session-plan-response');
  assert.equal(responses[0].body?.plan, '# Ship it');
  assert.equal(responses[0].body?.revision, 1);
  assert.equal(responses[1].body?.plan, '# Ship it\n\nthe draft the agent is writing');
  assert.equal(responses[1].body?.revision, 0, 'the draft is marked by revision zero');
  await lane.stop();
});

test('every plan draft notice reaches every control client', () => {
  const lanesSource = fs.readFileSync(new URL('../server/backend-lanes.ts', import.meta.url), 'utf8');
  assert.match(lanesSource, /planReview\?\.on\('plan-draft'/);
  assert.match(lanesSource, /broadcastControl\(\{ type: 'session-plan-draft', \.\.\.notice \}\)/);
});
