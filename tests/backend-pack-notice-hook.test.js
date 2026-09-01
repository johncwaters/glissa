'use strict';

// HTTP-level pin of the live context-pack channel on the hook ingress: a UserPromptSubmit response
// carries hookSpecificOutput.additionalContext when (and only when) the session owes a pack notice,
// in the ONE nesting Claude Code actually injects, and every other reply stays byte-identical to what
// the route answered before the channel existed.
//
// SAFETY: createBackend runs a boot worktree reconcile over the configured projects, so this points
// GLISSA_CONFIG at a throwaway temp config whose single project path is an empty NON-GIT temp dir
// (memory: booting the backend against the real config once destroyed an active worktree). Pack
// auto-rebuild is off here too, so booting never touches the real ~/.glissa/packs tree.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createBackend } = require('../server/backend');
const grok = require('../session/adapters/grok.ts').default;

const SESSION_ID = 'pack-notice-session';

let tmpDir = null;
let prevEnv = null;
let server = null;
let backend = null;
let base = null;
let session = null;
let token = null;

function hookUrl(event, hookToken = token) {
  return `${base}/hook/${SESSION_ID}/${event}?t=${encodeURIComponent(hookToken)}`;
}

function postHook(event, hookToken = token) {
  return fetch(hookUrl(event, hookToken), {
    method: 'POST',
    body: JSON.stringify({}),
    headers: { 'content-type': 'application/json' },
  });
}

// Stands in for a spawn: _resolvePacks records what the PTY was launched with, and launching a real
// `claude` here is not an option. Spawn-time resolution itself is covered by tests/session-packs.test.js.
function pretendSpawnedWith(deliveredPacks) {
  session._packDelivery.replaceDelivered(deliveredPacks.map((pack) => ({ ...pack })));
  session._packDelivery.clearNotice();
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-packnotice-hook-'));
  const projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(projectDir);
  const cfgPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    projects: [{ id: SESSION_ID, name: 'packed', path: projectDir }],
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
  // Register the session's bearer token with the shared HookRouter without spawning a PTY: this is
  // exactly what the spawn path does, minus node-pty.
  session._hooks.inject();
  token = session._hooks.token();
  assert.ok(token, 'hook injection produced a token');
});

test.after(async () => {
  if (session) session._hooks.cleanup();
  if (backend) backend.shutdown();
  if (server) server.closeAllConnections();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (prevEnv == null) delete process.env.GLISSA_CONFIG;
  if (prevEnv != null) process.env.GLISSA_CONFIG = prevEnv;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('with no notice pending the response body is byte-identical to the pre-channel reply', async () => {
  pretendSpawnedWith([{ name: 'alpha', version: 'v1' }]);
  const res = await postHook('UserPromptSubmit');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"ok":true,"reason":"ok"}');
});

test('an ignored event and a rejected token are unchanged too', async () => {
  const ignored = await postHook('PreCompact');
  assert.equal(await ignored.text(), '{"ok":true,"reason":"ignored-event"}');
  const badToken = await postHook('UserPromptSubmit', 'not-the-token');
  assert.equal(badToken.status, 403);
  assert.equal(await badToken.text(), '{"ok":false,"reason":"bad-token"}');
});

test('a pending notice rides the next UserPromptSubmit in the exact injectable shape', async () => {
  pretendSpawnedWith([{ name: 'alpha', version: 'v1' }]);
  session.notePackUpdate('alpha', 'v2');

  const body = await (await postHook('UserPromptSubmit')).json();
  assert.equal(body.ok, true);
  assert.equal(body.reason, 'ok');
  assert.deepEqual(Object.keys(body.hookSpecificOutput), ['hookEventName', 'additionalContext']);
  assert.equal(body.hookSpecificOutput.hookEventName, 'UserPromptSubmit', 'the event name must match or Claude Code drops it');
  assert.match(body.hookSpecificOutput.additionalContext, /^\[glissa\] Context pack updated since this session started: "alpha" \(version v1 is now v2\)\./);
  assert.equal(body.additionalContext, undefined, 'a top-level additionalContext is silently ignored by Claude Code, so it is never sent');

  const next = await postHook('UserPromptSubmit');
  assert.equal(await next.text(), '{"ok":true,"reason":"ok"}', 'consumed on read: the following turn is clean again');
});

test('a rejected callback cannot drain the pending notice', async () => {
  pretendSpawnedWith([{ name: 'alpha', version: 'v1' }]);
  session.notePackUpdate('alpha', 'v2');

  const refused = await postHook('UserPromptSubmit', 'not-the-token');
  assert.equal(refused.status, 403);

  const accepted = await (await postHook('UserPromptSubmit')).json();
  assert.ok(accepted.hookSpecificOutput, 'the notice survived the refused callback');
});

test('no other event carries the notice, even with one pending', async () => {
  pretendSpawnedWith([{ name: 'alpha', version: 'v1' }]);
  session.notePackUpdate('alpha', 'v2');

  for (const event of ['Stop', 'Notification', 'SessionStart', 'SubagentStop', 'PreCompact']) {
    const res = await postHook(event);
    const body = await res.json();
    assert.equal(body.hookSpecificOutput, undefined, `${event} must not carry injected context`);
  }

  const prompt = await (await postHook('UserPromptSubmit')).json();
  assert.ok(prompt.hookSpecificOutput, 'the notice was still waiting for the one event that can inject it');
});

test('an adapter can declare Stop as its notice delivery event', async () => {
  const originalAdapter = session._adapter;
  session._adapter = grok;
  try {
    pretendSpawnedWith([{ name: 'alpha', version: 'v1' }]);
    session.notePackUpdate('alpha', 'v2');

    const prompt = await postHook('UserPromptSubmit');
    assert.equal(await prompt.text(), '{"ok":true,"reason":"ok"}');
    const stop = await (await postHook('Stop')).json();
    assert.deepEqual(Object.keys(stop.hookSpecificOutput), ['hookEventName', 'additionalContext']);
    assert.equal(stop.hookSpecificOutput.hookEventName, 'Stop');
    assert.match(stop.hookSpecificOutput.additionalContext, /Context pack updated/);
  } finally {
    session._adapter = originalAdapter;
  }
});
