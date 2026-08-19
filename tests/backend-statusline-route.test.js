'use strict';

// The statusline event on the ONE write ingress, POST /hook/:glissaId/:event. Three things this pins:
// the token gate is the same one every other hook event goes through, an accepted callback stores the
// official plan limits, and the reply stays the plain ok JSON (the additionalContext injection shape is
// UserPromptSubmit-only, and a telemetry channel must never become a second injection point).
//
// It also pins that statusline is NOT a detection signal: it must not move the session's state machine.
//
// SAFETY: createBackend runs a boot worktree reconcile over the configured projects, so GLISSA_CONFIG
// points at a throwaway temp config whose single project path is an empty NON-GIT temp dir (memory:
// booting the backend against the real config once destroyed an active worktree). No wasActive, so boot
// auto-resume never spawns a real claude PTY.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createBackend } = require('../server/backend');

const SESSION_ID = 'statusline-session';

let tmpDir = null;
let prevEnv = null;
let server = null;
let backend = null;
let base = null;
let session = null;
let token = null;

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

function postStatusline(body, hookToken = token) {
  const url = `${base}/hook/${SESSION_ID}/statusline?t=${encodeURIComponent(hookToken)}`;
  return fetch(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-statusline-route-'));
  const projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(projectDir);
  const cfgPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    projects: [{ id: SESSION_ID, name: 'statusline', path: projectDir }],
    repoRoots: [],
    packsAutoRebuild: false,
    autoResume: false,
  }, null, 2), 'utf8');
  prevEnv = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = cfgPath;

  server = http.createServer();
  backend = createBackend(server, { staticDir: null });
  server.on('request', backend.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  session = backend.getSession(SESSION_ID);
  assert.ok(session, 'the boot loop created the configured session');
  // Registers the bearer token with the shared HookRouter without spawning a PTY: exactly what the
  // spawn path does, minus node-pty.
  session._injectHooks();
  token = session._hookToken;
  assert.ok(token, 'hook injection produced a token');
});

test.after(async () => {
  if (backend) backend.shutdown();
  if (server) server.closeAllConnections();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (prevEnv == null) delete process.env.GLISSA_CONFIG;
  if (prevEnv != null) process.env.GLISSA_CONFIG = prevEnv;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('a bad token is refused 403 and stores nothing', async () => {
  const res = await postStatusline(payload(), 'not-the-token');
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'bad-token');
  assert.equal(backend.getPlanLimits(), null, 'a refused callback never reaches the lane');
});

test('a missing token is refused and stores nothing', async () => {
  const res = await fetch(`${base}/hook/${SESSION_ID}/statusline`, {
    method: 'POST',
    body: JSON.stringify(payload()),
    headers: { 'content-type': 'application/json' },
  });
  assert.notEqual(res.status, 200);
  assert.equal(backend.getPlanLimits(), null);
});

test('an unknown session is 404, exactly as for any other event', async () => {
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
  const stateBefore = session.state;
  const res = await postStatusline(payload({ five: 21.5 }));
  assert.equal(res.status, 200);
  const body = await res.json();
  // Byte-identical to what the route answers for any other non-signal event: no hookSpecificOutput,
  // no additionalContext, nothing that could inject into the turn.
  assert.deepEqual(Object.keys(body).sort(), ['ok', 'reason']);
  assert.equal(body.ok, true);
  assert.equal(body.reason, 'ignored-event', 'statusline is telemetry, so it maps to no detection signal');

  const stored = backend.getPlanLimits();
  assert.ok(stored, 'the lane stored the snapshot');
  assert.equal(stored.type, 'plan-limits');
  assert.equal(stored.source, 'statusline');
  assert.equal(stored.fiveHour.pct, 21.5);
  assert.equal(stored.sevenDay.pct, 68.4);
  assert.equal(stored.fiveHour.resetsAtMs, 1_900_003_600_000, 'seconds became ms');
  // Telemetry must not move the state machine.
  assert.equal(session.state, stateBefore);
});

/*
 * Regression pin, and not only for this lane. The route accumulates the request body into a `body`
 * string, and commit 78dbc0b introduced a `const body` for the RESPONSE in the same block: that put the
 * string in the temporal dead zone for the whole callback, so JSON.parse threw a ReferenceError which
 * the surrounding tolerate-catch swallowed, and every hook payload arrived as {}. Nothing failed loudly,
 * it just silently disabled every payload-dependent behavior (session_id capture and therefore boot
 * auto-resume, the background_tasks gate, Notification subtypes, PostToolUse tool names).
 *
 * Notification is the sharpest probe available: its ROUTING depends on a payload field, so `reason` can
 * only be 'ok' if the payload survived the trip.
 */
test('the request payload reaches the router, not an empty object', async () => {
  const res = await fetch(`${base}/hook/${SESSION_ID}/notification?t=${encodeURIComponent(token)}`, {
    method: 'POST',
    body: JSON.stringify({ notification_type: 'permission_prompt' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  // An empty payload maps to no signal at all ('ignored-event'); this subtype maps to awaiting-input.
  assert.equal(body.reason, 'ok', 'the notification subtype was visible to the mapper');
});

test('the stored snapshot keeps nothing but the numbers', async () => {
  await postStatusline(payload({ five: 22.5 }));
  assert.ok(backend.getPlanLimits(), 'there is a snapshot to inspect');
  const serialized = JSON.stringify(backend.getPlanLimits());
  assert.equal(serialized.includes('transcript'), false);
  assert.equal(serialized.includes('C:/fixture'), false);
  assert.equal(serialized.includes('Opus'), false);
});

test('the freshest payload wins', async () => {
  await postStatusline(payload({ five: 30 }));
  assert.equal(backend.getPlanLimits().fiveHour.pct, 30);
  await postStatusline(payload({ five: 44.4 }));
  assert.equal(backend.getPlanLimits().fiveHour.pct, 44.4);
});

test('a malformed body is tolerated: the route answers and the snapshot survives', async () => {
  await postStatusline(payload({ five: 55 }));
  const res = await fetch(`${base}/hook/${SESSION_ID}/statusline?t=${encodeURIComponent(token)}`, {
    method: 'POST',
    body: '{ not json',
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  assert.equal(backend.getPlanLimits().fiveHour.pct, 55, 'garbage does not blank a good snapshot');
});

test('a startup payload (no rate_limits) is accepted and changes no snapshot', async () => {
  await postStatusline(payload({ five: 66 }));
  const res = await postStatusline({ session_id: 'c1', cost: { total_cost_usd: 0.5 } });
  assert.equal(res.status, 200);
  assert.equal(backend.getPlanLimits().fiveHour.pct, 66);
});
