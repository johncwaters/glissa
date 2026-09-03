import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';

import { createBackend } from '../server/backend.ts';
import grok from '../session/adapters/grok.ts';
import type { DeliveredPack } from '../session/session-pack-delivery.ts';
import type { Session } from '../session/sessions.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';
import type { Backend } from './helpers/lanes.ts';

const SESSION_ID = 'pack-notice-session';

interface PackNoticeContext {
  tmpDir: string;
  prevEnv: string | undefined;
  server: Server;
  backend: Backend;
  base: string;
  session: Session;
  token: string;
}

const booted: { context: PackNoticeContext | null } = { context: null };

function ctx(): PackNoticeContext {
  if (!booted.context) throw new Error('the backend was never booted');
  return booted.context;
}

function hookUrl(event: string, hookToken: string): string {
  return `${ctx().base}/hook/${SESSION_ID}/${event}?t=${encodeURIComponent(hookToken)}`;
}

function postHook(event: string, hookToken = ctx().token): Promise<Response> {
  return fetch(hookUrl(event, hookToken), {
    method: 'POST',
    body: JSON.stringify({}),
    headers: { 'content-type': 'application/json' },
  });
}

function pretendSpawnedWith(deliveredPacks: DeliveredPack[]): void {
  const { session } = ctx();
  session._packDelivery.replaceDelivered(deliveredPacks.map((pack) => ({ ...pack })));
  session._packDelivery.clearNotice();
}

test.before(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-packnotice-hook-'));
  const projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(projectDir);
  const cfgPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    projects: [{ id: SESSION_ID, name: 'packed', path: projectDir }],
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
  const { backend, server, session, prevEnv, tmpDir } = booted.context;
  session._hooks.cleanup();
  backend.shutdown();
  server.closeAllConnections();
  await closeServer(server);
  if (prevEnv == null) delete process.env.GLISSA_CONFIG;
  if (prevEnv != null) process.env.GLISSA_CONFIG = prevEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
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
  ctx().session.notePackUpdate('alpha', 'v2');

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
  ctx().session.notePackUpdate('alpha', 'v2');

  const refused = await postHook('UserPromptSubmit', 'not-the-token');
  assert.equal(refused.status, 403);

  const accepted = await (await postHook('UserPromptSubmit')).json();
  assert.ok(accepted.hookSpecificOutput, 'the notice survived the refused callback');
});

test('no other event carries the notice, even with one pending', async () => {
  pretendSpawnedWith([{ name: 'alpha', version: 'v1' }]);
  ctx().session.notePackUpdate('alpha', 'v2');

  for (const event of ['Stop', 'Notification', 'SessionStart', 'SubagentStop', 'PreCompact']) {
    const res = await postHook(event);
    const body = await res.json();
    assert.equal(body.hookSpecificOutput, undefined, `${event} must not carry injected context`);
  }

  const prompt = await (await postHook('UserPromptSubmit')).json();
  assert.ok(prompt.hookSpecificOutput, 'the notice was still waiting for the one event that can inject it');
});

test('an adapter can declare Stop as its notice delivery event', async () => {
  const { session } = ctx();
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
