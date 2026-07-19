'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { HookRouter, mapHookToSignal, mapHookConfidence, mapHookPromptKind } = require('../detection/hook-source');
const {
  buildHookSettings,
  writeSessionSettings,
  sweepOrphans,
  generateToken,
  safeDirSegment,
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

test('mapHookToSignal: SubagentStart/Stop are tracking signals, never a completion', () => {
  // A sub-agent (Task tool) finishing mid-turn must not mark the session COMPLETE: it maps to a
  // counted tracking signal (gated downstream), not 'ready'. SubagentStart opens the count.
  assert.equal(mapHookToSignal('SubagentStart'), 'subagent-start');
  assert.equal(mapHookToSignal('SubagentStop'), 'subagent-stop');
  assert.notEqual(mapHookToSignal('SubagentStop'), 'ready');
});

test('mapHookToSignal: benign/unknown Notification subtypes are ignored (no false WAITING)', () => {
  assert.equal(mapHookToSignal('Notification', { notification_type: 'auth_success' }), null);
  assert.equal(mapHookToSignal('Notification', { notification_type: 'something_new' }), null);
  assert.equal(mapHookToSignal('Notification', {}), null);
  // elicitation prompts still count as needing input
  assert.equal(mapHookToSignal('Notification', { notification_type: 'elicitation_dialog' }), 'awaiting-input');
});

test('mapHookConfidence: idle_prompt readys are demoted to low (idle nudge, not a completion proof)', () => {
  assert.equal(mapHookConfidence('Notification', { notification_type: 'idle_prompt' }), 'low');
  assert.equal(mapHookConfidence('notification', { notificationType: 'idle_prompt' }), 'low');
  // Everything else keeps the source default (high for hooks).
  assert.equal(mapHookConfidence('Stop', {}), null);
  assert.equal(mapHookConfidence('Notification', { notification_type: 'permission_prompt' }), null);
  assert.equal(mapHookConfidence('UserPromptSubmit', {}), null);
});

test('mapHookPromptKind: classifies the origin of an awaiting-input signal', () => {
  assert.equal(mapHookPromptKind('PermissionRequest', {}), 'permission');
  assert.equal(mapHookPromptKind('Notification', { notification_type: 'permission_prompt' }), 'permission');
  assert.equal(mapHookPromptKind('Notification', { notification_type: 'elicitation_dialog' }), 'elicitation');
  // Not an awaiting-input origin: no kind.
  assert.equal(mapHookPromptKind('Stop', {}), null);
  assert.equal(mapHookPromptKind('Notification', { notification_type: 'idle_prompt' }), null);
  assert.equal(mapHookPromptKind('Notification', {}), null);
});

test('HookRouter attaches promptKind for permission/elicitation, omits it otherwise', () => {
  const r = new HookRouter();
  const got = [];
  r.register('s1', { token: 'tok', onSignal: (s) => got.push(s) });
  r.handle({ glissaId: 's1', event: 'PermissionRequest', token: 'tok', payload: {} });
  r.handle({ glissaId: 's1', event: 'Notification', token: 'tok', payload: { notification_type: 'elicitation_form' } });
  r.handle({ glissaId: 's1', event: 'Stop', token: 'tok', payload: {} });
  assert.equal(got.length, 3);
  assert.equal(got[0].promptKind, 'permission');
  assert.equal(got[1].promptKind, 'elicitation');
  assert.equal('promptKind' in got[2], false, 'Stop never carries a promptKind');
});

test('HookRouter passes the low-confidence override for idle_prompt, none for Stop', () => {
  const r = new HookRouter();
  const got = [];
  r.register('s1', { token: 'tok', onSignal: (s) => got.push(s) });
  r.handle({ glissaId: 's1', event: 'Notification', token: 'tok', payload: { notification_type: 'idle_prompt' } });
  r.handle({ glissaId: 's1', event: 'Stop', token: 'tok', payload: {} });
  assert.equal(got.length, 2);
  assert.equal(got[0].signal, 'ready');
  assert.equal(got[0].confidence, 'low');
  assert.equal(got[1].signal, 'ready');
  assert.equal('confidence' in got[1], false, 'Stop keeps the hook default');
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

test('safeDirSegment strips path-illegal chars (Windows) but keeps plain ids intact', () => {
  // Colon-namespaced setup/team ids must not produce an illegal Windows dir name.
  assert.equal(safeDirSegment('setup:marketing:bb78afb5'), 'setup-marketing-bb78afb5');
  assert.equal(safeDirSegment('a<b>c:"d/e\\f|g?h*i'), 'a-b-c--d-e-f-g-h-i');
  assert.equal(safeDirSegment('trailing.dot. '), 'trailing.dot');
  // Plain UUID-style ids (the normal-session case) are unchanged.
  assert.equal(safeDirSegment('bb78afb5-e527-48da-9632-580c00153a1b'), 'bb78afb5-e527-48da-9632-580c00153a1b');
});

test('writeSessionSettings handles colon-namespaced ids without ENOENT (Windows-safe dir)', () => {
  // Regression: setup:<team>:<uuid> contains colons, illegal in a Windows path segment, which
  // crashed mkdirSync with ENOENT. The dir name must be sanitized; the real glissaId still rides
  // the hook URL (URL-encoded) so HookRouter lookup by the unsanitized id is unaffected.
  const baseDir = path.join(os.tmpdir(), `glissa-colon-${Date.now()}`);
  const glissaId = 'setup:marketing:bb78afb5-e527-48da-9632-580c00153a1b';
  const { settingsPath, dir, cleanup } = writeSessionSettings({ port: 5173, glissaId, baseDir });
  assert.ok(fs.existsSync(settingsPath));
  assert.equal(path.basename(dir).includes(':'), false);
  const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  // URL keeps the real id, percent-encoded.
  assert.match(parsed.hooks.Stop[0].hooks[0].url, /\/hook\/setup%3Amarketing%3Abb78afb5/);
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
