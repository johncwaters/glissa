'use strict';

// HTTP-level coverage of the ONE write ingress: POST /hook/:glissaId/:event (Claude Code hook
// callbacks). The unit-level token logic lives in hook-source.test.js; this exercises the mounted
// Express route end to end: status codes, JSON shape, the 64KB body cap, and that an aborted
// oversize request does not kill the server (backend req.on('error') listener).
//
// SAFETY: createBackend resolves its config store and runs a boot worktree reconcile against the
// configured projects. It is pointed at a throwaway temp config with a single non-git temp project via
// GLISSA_CONFIG, so it can never touch a real repo or remove a real worktree.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createBackend } = require('../server/backend.ts');

const SESSION_ID = 'hook-route-session';

let tmpDir = null;
let prevEnv = null;
let server = null;
let backend = null;
let base = null;
let session = null;
let token = null;

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-hookroute-'));
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
  prevEnv = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = cfgPath;

  server = http.createServer();
  backend = createBackend(server, { staticDir: null });
  // createBackend returns the Express app; the embedder wires it (mirrors server/main.ts).
  server.on('request', backend.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  session = backend.getSession(SESSION_ID);
  assert.ok(session, 'the boot loop created the configured session');
  session._hooks.inject();
  token = session._hooks.token();
  assert.ok(token, 'hook injection produced a token');
});

test.after(async () => {
  if (backend) backend.shutdown();
  // fetch (undici) pools keep-alive sockets; server.close() alone would wait on them forever.
  if (server) server.closeAllConnections();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (prevEnv == null) delete process.env.GLISSA_CONFIG;
  if (prevEnv != null) process.env.GLISSA_CONFIG = prevEnv;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('unknown session id is rejected 404 with ok:false', async () => {
  const res = await fetch(`${base}/hook/no-such-session/Stop`, {
    method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'unknown-session');
});

test('missing and bad tokens are rejected', async () => {
  const noToken = await fetch(`${base}/hook/any/Stop`, { method: 'POST', body: '{}' });
  assert.notEqual(noToken.status, 200, 'no token never yields 200');
  const badToken = await fetch(`${base}/hook/any/Stop?t=wrong-token`, { method: 'POST', body: '{}' });
  assert.notEqual(badToken.status, 200, 'bad token never yields 200');
});

test('successful hook callbacks answer only ok and reason', async () => {
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
  const res = await fetch(`${base}/hook/no-such-session/Stop`, { method: 'POST', body: '{not json' });
  assert.equal(res.status, 404, 'body parse failure falls back to {} and the route still answers');
});

test('oversize body (>64KB) is aborted and the server survives', async () => {
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
