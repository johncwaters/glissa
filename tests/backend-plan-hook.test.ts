import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';

import { createBackend } from '../server/backend.ts';
import { createBackendHttpApp } from '../server/backend-http.ts';
import { PLAN_HOOK_BODY_CAP_BYTES, PLAN_RESULT_BODY_CAP_BYTES, carriesPlanBody } from '../server/plan-review-wiring.ts';
import type { Session } from '../session/sessions.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';
import type { Backend } from './helpers/lanes.ts';

const SESSION_ID = 'plan-hook-session';

interface PlanHookContext {
  tmpDir: string;
  prevEnv: string | undefined;
  server: Server;
  backend: Backend;
  base: string;
  session: Session;
  token: string;
}

const booted: { context: PlanHookContext | null } = { context: null };

function ctx(): PlanHookContext {
  if (!booted.context) throw new Error('the backend was never booted');
  return booted.context;
}

function planFilePath(): string {
  return path.join(ctx().tmpDir, 'plans', `${SESSION_ID}.jsonl`);
}

function planLines(): Record<string, unknown>[] {
  const raw = fs.readFileSync(planFilePath(), 'utf8');
  return raw.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

async function postHook(event: string, body: unknown): Promise<Response> {
  const { base, token } = ctx();
  return fetch(`${base}/hook/${SESSION_ID}/${event}?t=${encodeURIComponent(token)}`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

async function releasePlanHold(): Promise<void> {
  const lane = ctx().backend.getLane('plan-review');
  if (!lane) throw new Error('the plan review lane is off');
  for (let attempt = 0; attempt < 400; attempt++) {
    const result = await lane.readPlanRevision(SESSION_ID, {});
    const open = result?.reviews.find((review) => review.state === 'open');
    if (open?.openRevision) {
      lane.decide(SESSION_ID, {
        id: SESSION_ID,
        agentId: open.agentId,
        revision: open.openRevision.revision,
        decision: 'terminal',
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the plan request never opened a held reply');
}

async function postPlanHook(body: unknown): Promise<Response> {
  const pending = postHook('permissionrequest-plan', body);
  await releasePlanHold();
  return pending;
}

function exitPlanModeBody(plan: string, agentId?: string) {
  return {
    tool_name: 'ExitPlanMode',
    tool_input: { plan, planFilePath: '/plans/session.md' },
    ...(agentId ? { agent_id: agentId, agent_type: 'Explore' } : {}),
  };
}

test.before(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-planhook-'));
  const projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(projectDir);
  const cfgPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    projects: [{ id: SESSION_ID, name: 'plan hook', path: projectDir }],
    teams: [],
    repoRoots: [],
    millEnabled: false,
    autoResume: false,
  }, null, 2), 'utf8');
  const prevEnv = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = cfgPath;

  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });
  server.on('request', backend.app);
  await listenOnLoopback(server);

  const session = backend.getSession(SESSION_ID);
  assert.ok(session, 'the boot loop created the configured session');
  session._hooks.inject();
  const token = session._hooks.token();
  assert.ok(token, 'hook injection produced a token');

  booted.context = { tmpDir, prevEnv, server, backend, base: `http://127.0.0.1:${boundPort(server)}`, session, token };
});

test.after(async () => {
  if (!booted.context) return;
  const { backend, server, prevEnv, tmpDir } = booted.context;
  backend.shutdown();
  server.closeAllConnections();
  await closeServer(server);
  if (prevEnv == null) delete process.env.GLISSA_CONFIG;
  if (prevEnv != null) process.env.GLISSA_CONFIG = prevEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('a plan request is stored as one revision and a terminal decision answers it with no hook decision', async () => {
  const response = await postPlanHook(exitPlanModeBody('# Ship it\n\nthe body'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(Object.hasOwn(body, 'hookSpecificOutput'), false, 'answer in terminal decides nothing for the agent');
  assert.equal(body.ok, true);

  const lines = planLines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].revision, 1);
  assert.equal(lines[0].plan, '# Ship it\n\nthe body');
  assert.equal(lines[0].planFilePath, '/plans/session.md');
  assert.equal(lines[0].sessionId, SESSION_ID);
  assert.equal(lines[0].agentId, null);
});

test('hasPlan reaches the session snapshot without a filesystem check on the render path', () => {
  assert.equal(ctx().session.toSnapshot().hasPlan, true);
  assert.equal(ctx().backend.getSession('no-such-session'), null);
});

test('a resubmitted plan appends the next revision on the same review', async () => {
  await postPlanHook(exitPlanModeBody('# Ship it, revised'));
  const lines = planLines();
  assert.equal(lines.length, 2);
  assert.equal(lines[1].revision, 2);
  assert.equal(lines[1].plan, '# Ship it, revised');
});

test('a subagent plan is stored beside the main review with its own numbering', async () => {
  await postPlanHook(exitPlanModeBody('# Explore plan', 'sub-7'));
  const lines = planLines();
  assert.equal(lines.length, 3);
  assert.equal(lines[2].agentId, 'sub-7');
  assert.equal(lines[2].agentType, 'Explore');
  assert.equal(lines[2].revision, 1);
});

test('a plan over the raised cap is refused and logged, and the server survives', async () => {
  const oversize = 'x'.repeat(600 * 1024);
  await postHook('permissionrequest-plan', exitPlanModeBody(oversize))
    .then((response) => assert.notEqual(response.status, 200, 'over the cap never yields 200'))
    .catch(() => {});
  assert.equal(planLines().length, 3, 'nothing over the cap was stored');

  const after = await postHook('Stop', {});
  assert.equal(after.status, 200, 'the route still answers after the aborted request');
});

test('a plan between the old 64 KB cap and the raised cap is accepted', async () => {
  const plan = `# Big plan\n${'y'.repeat(200 * 1024)}`;
  const response = await postPlanHook(exitPlanModeBody(plan));
  assert.equal(response.status, 200);
  const lines = planLines();
  assert.equal(lines.length, 4);
  assert.equal(String(lines[3].plan).length, plan.length);
});

test('an unparseable plan payload falls back to the reply the route sends today', async () => {
  const before = planLines().length;
  const response = await postHook('permissionrequest-plan', { tool_name: 'ExitPlanMode', tool_input: {} });
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(await response.json()).sort(), ['ok', 'reason']);
  assert.equal(planLines().length, before, 'a refused parse stores nothing');
});

test('the unmatched permission request stays a plain status signal that stores nothing', async () => {
  const before = planLines().length;
  const response = await postHook('permissionrequest', exitPlanModeBody('# Not stored here'));
  assert.equal(response.status, 200);
  assert.equal(planLines().length, before);
});

test('a large plan also clears the generic permission request endpoint, so the awaiting-input signal still lands', async () => {
  const before = planLines().length;
  const response = await postHook('permissionrequest', exitPlanModeBody(`# Big plan\n${'z'.repeat(200 * 1024)}`));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reason, 'ok', 'the awaiting-input signal was raised rather than refused');
  assert.equal(planLines().length, before, 'the generic endpoint still stores nothing');
});

test('an event that carries no plan keeps the 64 KB cap', async () => {
  await postHook('Stop', { note: 'q'.repeat(100 * 1024) })
    .then((response) => assert.notEqual(response.status, 200, 'over the generic cap never yields 200'))
    .catch(() => {});
  const after = await postHook('Stop', {});
  assert.equal(after.status, 200, 'the route still answers after the aborted request');
});

test('the raised cap belongs to the plan lane and covers only the segments that carry a plan', () => {
  assert.equal(PLAN_HOOK_BODY_CAP_BYTES, 512 * 1024);
  assert.equal(carriesPlanBody('permissionrequest-plan'), true);
  assert.equal(carriesPlanBody('posttooluse-plan'), true, 'the approved plan arrives twice in one plan result body');
  assert.equal(carriesPlanBody('PermissionRequest'), true);
  assert.equal(carriesPlanBody('PostToolUse'), false, 'the shared tool result route never carries a plan');
  assert.equal(carriesPlanBody('stop'), false);
  assert.equal(
    PLAN_RESULT_BODY_CAP_BYTES,
    2 * PLAN_HOOK_BODY_CAP_BYTES,
    'the result segment carries the plan in tool_input and in tool_response',
  );
});

test('a plan the request cap accepted still clears the result cap once the result carries it twice', async () => {
  const plan = `# Big plan\n${'y'.repeat(300 * 1024)}`;
  const body = JSON.stringify({
    tool_name: 'ExitPlanMode',
    tool_input: { plan, planFilePath: '/plans/session.md' },
    tool_response: { plan },
  });
  assert.ok(
    Buffer.byteLength(body) > PLAN_HOOK_BODY_CAP_BYTES,
    'the doubled result of an accepted plan is over the request cap',
  );
  const approved = await postHook('posttooluse-plan', body);
  assert.equal(approved.status, 200, 'a terminal approval of an accepted plan always reaches the lane');
});

test('the shared PostToolUse route keeps the 64 KB cap that only the plan segment raises', async () => {
  const sharedRouteOutcome: number | string = await postHook('PostToolUse', {
    tool_name: 'Read',
    tool_response: { content: 'q'.repeat(100 * 1024) },
  }).then((response) => response.status).catch(() => 'destroyed');
  assert.notEqual(sharedRouteOutcome, 200, 'a wakeup or pack read body over 64 KB is still refused');

  const plan = `# Big plan\n${'y'.repeat(200 * 1024)}`;
  const approved = await postHook('posttooluse-plan', {
    tool_name: 'ExitPlanMode',
    tool_input: { plan, planFilePath: '/plans/session.md' },
    tool_response: { plan },
  });
  assert.equal(approved.status, 200, 'the plan segment carries the plan the shared route no longer may');
});

test('a disabled plan lane leaves the 64 KB cap on the permission request route', async () => {
  const app = createBackendHttpApp({
    staticDir: null,
    configStore: { configPath: path.join(ctx().tmpDir, 'config.json') },
    remote: { allowedOrigins: [] },
    remoteAuth: null,
    allowedHosts: [],
    listenerPortsFor: () => [],
    pageToken: 'page-token',
    hookRouter: { handle: () => ({ status: 200, reason: 'ok' }) },
    getSession: () => null,
    getUsage: () => ({ ingestStatusline: () => {} }),
    logger: { warn: () => {} },
  });
  const server = http.createServer(app);
  await listenOnLoopback(server);
  const base = `http://127.0.0.1:${boundPort(server)}`;
  const post = (plan: string) => fetch(`${base}/hook/${SESSION_ID}/permissionrequest`, {
    method: 'POST',
    body: JSON.stringify(exitPlanModeBody(plan)),
    headers: { 'content-type': 'application/json' },
  });

  const refusedStatus = await post('q'.repeat(100 * 1024)).then((response) => response.status).catch(() => 0);
  assert.notEqual(refusedStatus, 200, 'without the lane a 100 KB body is over the generic cap');
  const accepted = await post('# small plan');
  assert.equal(accepted.status, 200, 'the route still answers a body under the generic cap');

  server.closeAllConnections();
  await closeServer(server);
});

function postHookSplitAcross(event: string, body: string, splitAtByte: number): Promise<number> {
  const { base, token } = ctx();
  const url = new URL(`${base}/hook/${SESSION_ID}/${event}?t=${encodeURIComponent(token)}`);
  const payload = Buffer.from(body, 'utf8');
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(payload.length) },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    });
    request.on('socket', (socket) => socket.setNoDelay(true));
    request.on('error', reject);
    request.write(payload.subarray(0, splitAtByte));
    setTimeout(() => request.end(payload.subarray(splitAtByte)), 25);
  });
}

test('a plan whose multibyte character straddles two socket reads is stored intact', async () => {
  const multibyteChar = String.fromCharCode(0x4e2d);
  const plan = `# Ship ${multibyteChar} it\n\nthe body`;
  const body = JSON.stringify(exitPlanModeBody(plan));
  const payload = Buffer.from(body, 'utf8');
  const charStart = payload.indexOf(Buffer.from(multibyteChar, 'utf8'));
  assert.ok(charStart > 0, 'the multibyte character is in the request body');

  const before = planLines().length;
  const pending = postHookSplitAcross('permissionrequest-plan', body, charStart + 1);
  await releasePlanHold();
  assert.equal(await pending, 200);

  const lines = planLines();
  assert.equal(lines.length, before + 1);
  assert.equal(lines[lines.length - 1].plan, plan);
});
