// HTTP-level coverage of the ONE write ingress: POST /hook/:glissaId/:event (Claude Code hook
// callbacks). The unit-level token logic lives in hook-source.test.ts; this exercises the mounted
// Express route end to end: status codes, JSON shape, the 64KB body cap, and that an aborted
// oversize request does not kill the server (backend req.on('error') listener).
//
// SAFETY: createBackend resolves its config store and runs a boot worktree reconcile against the
// configured projects. It is pointed at a throwaway temp config with a single non-git temp project via
// GLISSA_CONFIG, so it can never touch a real repo or remove a real worktree.

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
import type { Backend } from './helpers/lanes.ts';

const SESSION_ID = 'hook-route-session';

interface HookRouteContext {
  tmpDir: string;
  prevEnv: string | undefined;
  server: Server;
  backend: Backend;
  base: string;
  session: Session;
  token: string;
}

const booted: { context: HookRouteContext | null } = { context: null };

function ctx(): HookRouteContext {
  if (!booted.context) throw new Error('the backend was never booted');
  return booted.context;
}

test.before(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-hookroute-'));
  const projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(projectDir);
  const cfgPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    projects: [{ id: SESSION_ID, name: 'hook route', path: projectDir }],
    teams: [],
    repoRoots: [],
    packsAutoRebuild: false,
    autoResume: false,
  }, null, 2), 'utf8');
  const prevEnv = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = cfgPath;

  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });
  // createBackend returns the Express app; the embedder wires it (mirrors server/main.ts).
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
  // fetch (undici) pools keep-alive sockets; server.close() alone would wait on them forever.
  server.closeAllConnections();
  await closeServer(server);
  if (prevEnv == null) delete process.env.GLISSA_CONFIG;
  if (prevEnv != null) process.env.GLISSA_CONFIG = prevEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('unknown session id is rejected 404 with ok:false', async () => {
  const res = await fetch(`${ctx().base}/hook/no-such-session/Stop`, {
    method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'unknown-session');
});

test('missing and bad tokens are rejected', async () => {
  const noToken = await fetch(`${ctx().base}/hook/any/Stop`, { method: 'POST', body: '{}' });
  assert.notEqual(noToken.status, 200, 'no token never yields 200');
  const badToken = await fetch(`${ctx().base}/hook/any/Stop?t=wrong-token`, { method: 'POST', body: '{}' });
  assert.notEqual(badToken.status, 200, 'bad token never yields 200');
});

test('successful hook callbacks answer only ok and reason', async () => {
  const { base, token } = ctx();
  const res = await fetch(`${base}/hook/${SESSION_ID}/NotARealHook?t=${encodeURIComponent(token)}`, {
    method: 'POST',
    body: '{}',
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ['ok', 'reason']);
  assert.equal(body.ok, true);
  assert.equal(body.reason, 'ignored-event');
});

test('malformed JSON body is tolerated (route answers, does not throw)', async () => {
  const res = await fetch(`${ctx().base}/hook/no-such-session/Stop`, { method: 'POST', body: '{not json' });
  assert.equal(res.status, 404, 'body parse failure falls back to {} and the route still answers');
});

test('oversize body (>64KB) is aborted and the server survives', async () => {
  const { base } = ctx();
  const big = 'x'.repeat(70 * 1024);
  // The route destroys the request mid-body; fetch surfaces that as a network error OR a non-200.
  await fetch(`${base}/hook/no-such-session/Stop`, { method: 'POST', body: big })
    .then((res) => assert.notEqual(res.status, 200, 'oversize never yields 200'))
    .catch(() => { /* connection reset is the expected shape */ });

  // The regression this pins: req.destroy() emits a request 'error'; without backend's error
  // listener that throw killed the whole process. A follow-up request must still be served.
  const after = await fetch(`${base}/hook/no-such-session/Stop`, { method: 'POST', body: '{}' });
  assert.equal(after.status, 404, 'server is still alive and routing after the aborted request');
});
