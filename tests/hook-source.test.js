'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { HookRouter, mapHookToSignal } = require('../detection/hook-source');
const {
  buildHookSettings,
  writeSessionSettings,
  sweepOrphans,
  generateToken,
} = require('../detection/settings-injector');

test('mapHookToSignal maps events correctly', () => {
  assert.equal(mapHookToSignal('SessionStart'), 'session-start');
  assert.equal(mapHookToSignal('SessionEnd'), 'session-end');
  assert.equal(mapHookToSignal('UserPromptSubmit'), 'resume');
  assert.equal(mapHookToSignal('Stop'), 'ready');
  assert.equal(mapHookToSignal('PermissionRequest'), 'awaiting-input');
  assert.equal(mapHookToSignal('Notification', { notification_type: 'idle_prompt' }), 'ready');
  assert.equal(mapHookToSignal('Notification', { notification_type: 'permission_prompt' }), 'awaiting-input');
  assert.equal(mapHookToSignal('PreToolUse'), null);
});

test('mapHookToSignal: SubagentStop does NOT complete the session', () => {
  // A sub-agent (Task tool) finishing mid-turn must not mark the session COMPLETE.
  assert.equal(mapHookToSignal('SubagentStop'), null);
});

test('mapHookToSignal: benign/unknown Notification subtypes are ignored (no false WAITING)', () => {
  assert.equal(mapHookToSignal('Notification', { notification_type: 'auth_success' }), null);
  assert.equal(mapHookToSignal('Notification', { notification_type: 'something_new' }), null);
  assert.equal(mapHookToSignal('Notification', {}), null);
  // elicitation prompts still count as needing input
  assert.equal(mapHookToSignal('Notification', { notification_type: 'elicitation_dialog' }), 'awaiting-input');
});

test('HookRouter rejects unknown session (404)', () => {
  const r = new HookRouter();
  const res = r.handle({ glissaId: 'nope', event: 'Stop', token: 'x', payload: {} });
  assert.equal(res.status, 404);
  assert.equal(res.signal, null);
});

test('HookRouter rejects bad token (403)', () => {
  const r = new HookRouter();
  const got = [];
  r.register('s1', { token: 'good', onSignal: (s) => got.push(s) });
  const res = r.handle({ glissaId: 's1', event: 'Stop', token: 'bad', payload: {} });
  assert.equal(res.status, 403);
  assert.equal(got.length, 0);
});

test('HookRouter dispatches valid signal to onSignal', () => {
  const r = new HookRouter();
  const got = [];
  r.register('s1', { token: 'good', onSignal: (s) => got.push(s) });
  const res = r.handle({ glissaId: 's1', event: 'Stop', token: 'good', payload: {} });
  assert.equal(res.status, 200);
  assert.equal(res.signal, 'ready');
  assert.equal(got.length, 1);
  assert.equal(got[0].signal, 'ready');
  assert.equal(got[0].source, 'hook');
});

test('HookRouter ignores unmapped events with 200', () => {
  const r = new HookRouter();
  r.register('s1', { token: 'good', onSignal: () => {} });
  const res = r.handle({ glissaId: 's1', event: 'PreToolUse', token: 'good', payload: {} });
  assert.equal(res.status, 200);
  assert.equal(res.signal, null);
});

test('unregister stops dispatch', () => {
  const r = new HookRouter();
  const got = [];
  r.register('s1', { token: 'good', onSignal: (s) => got.push(s) });
  r.unregister('s1');
  const res = r.handle({ glissaId: 's1', event: 'Stop', token: 'good', payload: {} });
  assert.equal(res.status, 404);
  assert.equal(got.length, 0);
});

test('buildHookSettings produces http hooks with glissaId + token in URL', () => {
  const s = buildHookSettings({ port: 1234, glissaId: 'abc', token: 'tok', timeoutSec: 5 });
  assert.ok(s.hooks.Stop);
  const url = s.hooks.Stop[0].hooks[0].url;
  assert.equal(s.hooks.Stop[0].hooks[0].type, 'http');
  assert.equal(s.hooks.Stop[0].hooks[0].timeout, 5);
  assert.match(url, /^http:\/\/127\.0\.0\.1:1234\/hook\/abc\/stop\?t=tok$/);
  assert.ok(s.hooks.Notification && s.hooks.UserPromptSubmit && s.hooks.SessionStart);
});

test('writeSessionSettings writes file and cleanup removes it', () => {
  const baseDir = path.join(os.tmpdir(), `glissa-test-${Date.now()}`);
  const { settingsPath, dir, token, cleanup } = writeSessionSettings({
    port: 5173,
    glissaId: 'sess-1',
    baseDir,
  });
  assert.ok(fs.existsSync(settingsPath));
  const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.match(parsed.hooks.Stop[0].hooks[0].url, /\/hook\/sess-1\/stop\?t=/);
  assert.ok(token && token.length >= 32);
  cleanup();
  assert.equal(fs.existsSync(dir), false);
  try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch {}
});

test('sweepOrphans removes stale dirs only', () => {
  const baseDir = path.join(os.tmpdir(), `glissa-sweep-${Date.now()}`);
  const fresh = writeSessionSettings({ port: 1, glissaId: 'fresh', baseDir });
  const stale = writeSessionSettings({ port: 1, glissaId: 'stale', baseDir });
  // Age the stale dir well past the cutoff.
  const old = Date.now() - 48 * 60 * 60 * 1000;
  fs.utimesSync(stale.dir, new Date(old), new Date(old));
  const removed = sweepOrphans(baseDir, 24 * 60 * 60 * 1000);
  assert.equal(removed, 1);
  assert.equal(fs.existsSync(stale.dir), false);
  assert.equal(fs.existsSync(fresh.dir), true);
  try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch {}
});

test('end-to-end: real HTTP POST through router validates token and dispatches', async () => {
  const r = new HookRouter();
  const got = [];
  const token = generateToken();
  r.register('e2e', { token, onSignal: (s) => got.push(s) });

  const server = http.createServer((req, res) => {
    const m = req.url.match(/^\/hook\/([^/]+)\/([^/?]+)(?:\?t=([^&]+))?$/);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch {}
      const out = r.handle({
        glissaId: decodeURIComponent(m[1]),
        event: m[2],
        token: m[3] ? decodeURIComponent(m[3]) : null,
        payload,
      });
      res.writeHead(out.status);
      res.end();
    });
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;

  const post = (url, body) =>
    new Promise((resolve) => {
      const req = http.request(url, { method: 'POST' }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.end(JSON.stringify(body));
    });

  const okStatus = await post(`http://127.0.0.1:${port}/hook/e2e/stop?t=${token}`, { hook_event_name: 'Stop' });
  assert.equal(okStatus, 200);
  const badStatus = await post(`http://127.0.0.1:${port}/hook/e2e/stop?t=wrong`, { hook_event_name: 'Stop' });
  assert.equal(badStatus, 403);

  assert.equal(got.length, 1);
  assert.equal(got[0].signal, 'ready');
  await new Promise((res) => server.close(res));
});
