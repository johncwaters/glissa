import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';

import { createBackend } from '../server/backend.ts';
import type { Session } from '../session/sessions.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';
import { usageLane } from './helpers/lanes.ts';
import type { Backend } from './helpers/lanes.ts';

const SESSION_ID = 'statusline-session';

interface StatuslineContext {
  tmpDir: string;
  prevEnv: string | undefined;
  server: Server;
  backend: Backend;
  base: string;
  session: Session;
  token: string;
}

const booted: { context: StatuslineContext | null } = { context: null };

function ctx(): StatuslineContext {
  if (!booted.context) throw new Error('the backend was never booted');
  return booted.context;
}

function payload({ five = 12, seven = 68.4, cost = 1.5 } = {}) {
  return {
    session_id: 'c1c1c1c1-2222-4333-8444-555555555555',
    transcript_path: 'C:/fixture/transcript.jsonl',
    cwd: 'C:/fixture/repo',
    model: { id: 'claude-opus-4-5', display_name: 'Opus 4.5' },
    cost: { total_cost_usd: cost },
    context_window: { used_percentage: 40 },
    rate_limits: {
      five_hour: { used_percentage: five, resets_at: 1_900_003_600 },
      seven_day: { used_percentage: seven, resets_at: 1_900_400_000 },
    },
  };
}

function postStatusline(body: unknown, hookToken = ctx().token): Promise<Response> {
  const url = `${ctx().base}/hook/${SESSION_ID}/statusline?t=${encodeURIComponent(hookToken)}`;
  return fetch(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function storedLimits() {
  return usageLane(ctx().backend).getPlanLimitsMessage();
}

function storedFiveHourPct(): number | null {
  const stored = storedLimits();
  assert.ok(stored, 'there is a stored snapshot');
  assert.ok(stored.fiveHour, 'the snapshot carries a five-hour window');
  return stored.fiveHour.pct;
}

test.before(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-statusline-route-'));
  const projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(projectDir);
  const cfgPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    projects: [{ id: SESSION_ID, name: 'statusline', path: projectDir }],
    repoRoots: [],
    packsAutoRebuild: false,
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

test('a bad token is refused 403 and stores nothing', async () => {
  const res = await postStatusline(payload(), 'not-the-token');
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'bad-token');
  assert.equal(storedLimits(), null, 'a refused callback never reaches the lane');
});

test('a missing token is refused and stores nothing', async () => {
  const res = await fetch(`${ctx().base}/hook/${SESSION_ID}/statusline`, {
    method: 'POST',
    body: JSON.stringify(payload()),
    headers: { 'content-type': 'application/json' },
  });
  assert.notEqual(res.status, 200);
  assert.equal(storedLimits(), null);
});

test('an unknown session is 404, exactly as for any other event', async () => {
  const { base, token } = ctx();
  const res = await fetch(`${base}/hook/no-such-session/statusline?t=${token}`, {
    method: 'POST',
    body: JSON.stringify(payload()),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.reason, 'unknown-session');
});

test('an accepted callback stores the plan limits and answers the plain ok JSON', async () => {
  const { session } = ctx();
  const stateBefore = session.state;
  const res = await postStatusline(payload({ five: 21.5 }));
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.deepEqual(Object.keys(body).sort(), ['ok', 'reason']);
  assert.equal(body.ok, true);
  assert.equal(body.reason, 'ignored-event', 'statusline is telemetry, so it maps to no detection signal');

  const stored = storedLimits();
  assert.ok(stored, 'the lane stored the snapshot');
  assert.ok(stored.fiveHour, 'the snapshot carries a five-hour window');
  assert.ok(stored.sevenDay, 'the snapshot carries a seven-day window');
  assert.equal(stored.type, 'plan-limits');
  assert.equal(stored.source, 'statusline');
  assert.equal(stored.fiveHour.pct, 21.5);
  assert.equal(stored.sevenDay.pct, 68.4);
  assert.equal(stored.fiveHour.resetsAtMs, 1_900_003_600_000, 'seconds became ms');

  assert.equal(session.state, stateBefore);
});

test('the request payload reaches the router, not an empty object', async () => {
  const { base, token } = ctx();
  const res = await fetch(`${base}/hook/${SESSION_ID}/notification?t=${encodeURIComponent(token)}`, {
    method: 'POST',
    body: JSON.stringify({ notification_type: 'permission_prompt' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);

  assert.equal(body.reason, 'ok', 'the notification subtype was visible to the mapper');
});

test('the stored snapshot keeps nothing but the numbers', async () => {
  await postStatusline(payload({ five: 22.5 }));
  const stored = storedLimits();
  assert.ok(stored, 'there is a snapshot to inspect');
  const serialized = JSON.stringify(stored);
  assert.equal(serialized.includes('transcript'), false);
  assert.equal(serialized.includes('C:/fixture'), false);
  assert.equal(serialized.includes('Opus'), false);
});

test('the freshest payload wins', async () => {
  await postStatusline(payload({ five: 30 }));
  assert.equal(storedFiveHourPct(), 30);
  await postStatusline(payload({ five: 44.4 }));
  assert.equal(storedFiveHourPct(), 44.4);
});

test('a malformed body is tolerated: the route answers and the snapshot survives', async () => {
  const { base, token } = ctx();
  await postStatusline(payload({ five: 55 }));
  const res = await fetch(`${base}/hook/${SESSION_ID}/statusline?t=${encodeURIComponent(token)}`, {
    method: 'POST',
    body: '{ not json',
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  assert.equal(storedFiveHourPct(), 55, 'garbage does not blank a good snapshot');
});

test('a startup payload (no rate_limits) is accepted and changes no snapshot', async () => {
  await postStatusline(payload({ five: 66 }));
  const res = await postStatusline({ session_id: 'c1', cost: { total_cost_usd: 0.5 } });
  assert.equal(res.status, 200);
  assert.equal(storedFiveHourPct(), 66);
});
