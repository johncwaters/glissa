'use strict';

// The pure pieces server/pr-review-wiring.js exports for direct testing (no createBackend/httpServer):
// the start-gate decision, the seed-prompt builder, and the result-file verdict reader. Mirrors
// backend-auto-resume.test.js, which tests backend's module-level helpers the same way. The
// applySettingsReload hot-apply test at the bottom still boots a real backend, since that wiring is
// only reachable through createBackend.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const { buildReviewPrompt, readReviewResult, prPollerShouldStart } = require('../server/pr-review-wiring');
const { createBackend } = require('../server/backend');
const { dashboardClient } = require('./helpers/dashboard-ws');

const { withFakeSession } = require('./helpers/fake-session');

// --- prPollerShouldStart: inert-by-default + misconfiguration gating ---

test('prPollerShouldStart: inert when prReview absent or disabled (no reason, silent)', () => {
  assert.deepEqual(prPollerShouldStart({}), { start: false, reason: null });
  assert.deepEqual(prPollerShouldStart({ prReview: { enabled: false } }), { start: false, reason: null });
});

test('prPollerShouldStart: enabled but telegram missing -> does not start, with a reason', () => {
  const r = prPollerShouldStart({ prReview: { enabled: true } });
  assert.equal(r.start, false);
  assert.match(r.reason, /telegram/);
  const r2 = prPollerShouldStart({ prReview: { enabled: true }, telegram: { botToken: 'x' } });
  assert.equal(r2.start, false, 'chatId still missing');
});

test('prPollerShouldStart: enabled + telegram configured -> starts', () => {
  const r = prPollerShouldStart({ prReview: { enabled: true }, telegram: { botToken: 'x', chatId: '1' } });
  assert.deepEqual(r, { start: true, reason: null });
});

function assertPrStatusShape(status, { configured, reason }) {
  assert.equal(status.type, 'pr-status');
  assert.equal(status.configured, configured);
  assert.equal(status.reason, reason);
  assert.deepEqual(status.projects, []);
  assert.equal(Number.isFinite(status.ts), true);
}

test('PR review getStatus: disabled config synthesizes an off status', () => {
  withFakeSession('../server/pr-review-wiring', ({ createPrReviewWiring }) => {
    const wiring = createPrReviewWiring({
      config: { prReview: { enabled: false }, replayBufferKB: 256 },
      reviewSessions: new Map(),
      closeSessionDataClients() {},
      hookRouter: null,
      getHookPort: null,
      spawnGate: null,
      gitWorkspace: null,
      getProjectPathById: () => null,
    });
    assertPrStatusShape(wiring.getStatus(), { configured: false, reason: null });
  });
});

test('PR review getStatus: enabled without telegram synthesizes a misconfigured status', () => {
  withFakeSession('../server/pr-review-wiring', ({ createPrReviewWiring }) => {
    const wiring = createPrReviewWiring({
      config: { prReview: { enabled: true }, replayBufferKB: 256 },
      reviewSessions: new Map(),
      closeSessionDataClients() {},
      hookRouter: null,
      getHookPort: null,
      spawnGate: null,
      gitWorkspace: null,
      getProjectPathById: () => null,
    });
    const status = wiring.getStatus();
    assertPrStatusShape(status, { configured: false, reason: 'prReview.enabled but telegram botToken/chatId missing' });
  });
});

// --- buildReviewPrompt: clean vs conflict lane ---

test('buildReviewPrompt (clean lane) forbids merge + self-review, omits the conflict step', () => {
  const p = buildReviewPrompt({ slug: 'me/repo', number: 12, baseRefName: 'main', conflicting: false, resultPath: '/tmp/r.json' });
  assert.match(p, /pull request #12/);
  assert.match(p, /Do NOT run `gh pr merge`/);
  assert.match(p, /Do NOT use `gh pr review`/);
  assert.match(p, /\.github\/workflows\//);
  assert.match(p, /\/tmp\/r\.json/);
  assert.doesNotMatch(p, /gh pr checkout/, 'no conflict-resolution step in the clean lane');
});

test('buildReviewPrompt carries the human-readable comment format rules', () => {
  const p = buildReviewPrompt({ slug: 'me/repo', number: 12, baseRefName: 'main', conflicting: false, resultPath: '/tmp/r.json' });
  assert.match(p, /Comment format/);
  assert.match(p, /### Blocking/);
  assert.match(p, /<!-- glissa-pr-review -->/);
  assert.match(p, /Resolved since last review/);
  assert.match(p, /https:\/\/github\.com\/me\/repo\/blob\/<full head sha>/);
  assert.match(p, /Skip style and formatting nitpicks/);
  assert.match(p, /at most 10 findings/);
  assert.match(p, /<details><summary>Details<\/summary>/);
  assert.match(p, /Prompt for AI agents/);
  assert.match(p, /following the comment format above/);
  assert.match(p, /Automated review \(glissa\)/, 'comment self-identifies as automated');
  assert.match(p, /post NO comment at all/, 'zero-delta re-review stays silent');
  assert.match(p, /Never praise/, 'summary bans praise filler');
  assert.match(p, /Omit the block entirely when there are no findings/, 'AI-agents block is conditional');
});

test('buildReviewPrompt (conflict lane) includes checkout+rebase+push and forbids a guessed resolution', () => {
  const p = buildReviewPrompt({ slug: 'me/repo', number: 7, baseRefName: 'develop', conflicting: true, resultPath: '/tmp/r.json' });
  assert.match(p, /gh pr checkout 7/);
  assert.match(p, /git rebase origin\/develop/);
  assert.match(p, /git push/);
  assert.match(p, /Never push a guessed resolution/);
});

// --- readReviewResult: verdict file parsing ---

function withResultFile(contents, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-prresult-'));
  const p = path.join(dir, 'result.json');
  if (contents != null) fs.writeFileSync(p, contents);
  try { return fn(p); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('readReviewResult: a valid verdict file parses to {verdict, summary}', () => {
  withResultFile(JSON.stringify({ verdict: 'clean', head: 'abc', summary: 'looks good' }), (p) => {
    assert.deepEqual(readReviewResult(p), { verdict: 'CLEAN', summary: 'looks good' });
  });
});

test('readReviewResult: an unknown verdict degrades to ERROR', () => {
  withResultFile(JSON.stringify({ verdict: 'LGTM' }), (p) => {
    assert.equal(readReviewResult(p).verdict, 'ERROR');
  });
});

test('readReviewResult: a missing file is ERROR (never a false clean pass)', () => {
  withResultFile(null, (p) => {
    assert.equal(readReviewResult(p).verdict, 'ERROR');
  });
});

// --- prReviewCfgKey: identity used to gate a restart to actual prReview/telegram changes ---

test('prReviewCfgKey: identical prReview/telegram produce the same key regardless of key order', () => {
  const { prReviewCfgKey } = require('../server/pr-review-wiring');
  const a = prReviewCfgKey({ prReview: { enabled: true, projects: ['p1'] }, telegram: { botToken: 'x', chatId: 'y' } });
  const b = prReviewCfgKey({ telegram: { botToken: 'x', chatId: 'y' }, prReview: { enabled: true, projects: ['p1'] } });
  assert.equal(a, b);
});

test('prReviewCfgKey: absent prReview/telegram normalizes to null, distinct from a disabled/empty object', () => {
  const { prReviewCfgKey } = require('../server/pr-review-wiring');
  assert.equal(prReviewCfgKey({}), prReviewCfgKey({ prReview: undefined, telegram: undefined }));
  assert.notEqual(prReviewCfgKey({}), prReviewCfgKey({ prReview: { enabled: false } }));
});

test('prReviewCfgKey: a changed packs list counts as a lane config change', () => {
  const { prReviewCfgKey } = require('../server/pr-review-wiring');
  const base = { prReview: { enabled: true, projects: ['p1'], packs: ['glissa'] }, telegram: { botToken: 'x', chatId: 'y' } };
  const changed = { prReview: { enabled: true, projects: ['p1'], packs: ['company-context'] }, telegram: { botToken: 'x', chatId: 'y' } };
  assert.notEqual(prReviewCfgKey(base), prReviewCfgKey(changed));
});

test('PR review lane passes configured packs into Session options', () => {
  withFakeSession('../server/pr-review-wiring', ({ createPrReviewWiring }, constructed) => {
    const wiring = createPrReviewWiring({
      config: { prReview: { packs: ['glissa', '../bad', 'glissa', 'company-context'] }, replayBufferKB: 256 },
      reviewSessions: new Map(),
      closeSessionDataClients() {},
      hookRouter: null,
      getHookPort: null,
      spawnGate: null,
      gitWorkspace: null,
      getProjectPathById: () => null,
    });
    wiring._makeReviewSession({ id: 'pr:1', name: 'PR', path: process.cwd(), initialPrompt: 'prompt' });
    assert.deepEqual(constructed[0].packs, ['glissa', 'company-context']);
  });
});

test('PR review lane omitting packs leaves Session options with an empty packs list', () => {
  withFakeSession('../server/pr-review-wiring', ({ createPrReviewWiring }, constructed) => {
    const wiring = createPrReviewWiring({
      config: { prReview: {}, replayBufferKB: 256 },
      reviewSessions: new Map(),
      closeSessionDataClients() {},
      hookRouter: null,
      getHookPort: null,
      spawnGate: null,
      gitWorkspace: null,
      getProjectPathById: () => null,
    });
    wiring._makeReviewSession({ id: 'pr:2', name: 'PR', path: process.cwd(), initialPrompt: 'prompt' });
    assert.deepEqual(constructed[0].packs, []);
  });
});

// --- applySettingsReload hot-applies the poller, gated + serialized (pr-review-wiring.js startPoller
// runs only when prReviewCfgKey(config) changes; see AGENTS.md GitHub PR Auto-Review). startPoller and
// its `prPoller` instance are private to the wiring closure, so there is no seam to inspect them
// directly. This exercises the wiring end to end through a real boot + real control-WS 'update-settings'
// round trips, but stays off the misconfigured (enabled, no telegram) path: prPollerShouldStart fails
// the gate before any gh/git/fs IO runs, so the test never touches a real gh binary or
// ~/.glissa/pr-review-state.json. The restart itself runs on an async promise chain (prPollerChain), so
// assertions poll briefly instead of checking immediately after the settings-updated ack.
// SAFETY: same throwaway-config pattern as backend-hook-route.test.js (zero projects, temp GLISSA_CONFIG).

function withBackend(fn) {
  return async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-prrestart-'));
    const cfgPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ projects: [], teams: [], repoRoots: [] }, null, 2), 'utf8');
    const prevEnv = process.env.GLISSA_CONFIG;
    process.env.GLISSA_CONFIG = cfgPath;

    const server = http.createServer();
    const backend = createBackend(server, { staticDir: null });
    server.on('request', backend.app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const dash = await dashboardClient(server.address().port);

    try {
      await fn(t, dash);
    } finally {
      backend.shutdown();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      if (prevEnv == null) delete process.env.GLISSA_CONFIG;
      if (prevEnv != null) process.env.GLISSA_CONFIG = prevEnv;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

function connectControl(dash) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(dash.url('/control'), dash.options);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function sendAndWait(ws, msg, matchType) {
  return new Promise((resolve) => {
    function onMessage(raw) {
      const parsed = JSON.parse(raw.toString());
      if (parsed.type !== matchType) return;
      ws.off('message', onMessage);
      resolve(parsed);
    }
    ws.on('message', onMessage);
    ws.send(JSON.stringify(msg));
  });
}

// The restart runs on the wiring's prPollerChain, appended (not awaited) by applySettingsReload, so a
// warning it logs can land after the settings-updated ack the client already received. Poll briefly
// instead of asserting immediately, bounded so a genuinely missing warning still fails promptly.
async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

function prPollerWarns(warnSpy) {
  return warnSpy.mock.calls.filter((c) => /pr-poller/i.test(String(c.arguments[0])));
}

test('update-settings hot-applies the poller only when prReview/telegram actually changed', withBackend(async (t, dash) => {
  const warnSpy = t.mock.method(console, 'warn');
  const ws = await connectControl(dash);

  await sendAndWait(ws, { type: 'get-settings', requestId: '1' }, 'settings');

  // enabled + no telegram: prPollerShouldStart fails the gate with a reason, so the chained restart
  // logs a warning instead of actually starting (no gh/fs IO). The warning firing on THIS settings save
  // (not at boot, where prReview was absent) proves the cfg-key change triggered startPrPoller.
  warnSpy.mock.resetCalls();
  const updated = await sendAndWait(ws, {
    type: 'update-settings',
    requestId: '2',
    settings: { prReview: { enabled: true }, telegram: { botToken: '', chatId: '' } },
  }, 'settings-updated');

  assert.deepEqual(updated.settings.prReview, { enabled: true });
  assert.ok(
    await waitFor(() => prPollerWarns(warnSpy).some((c) => /not starting.*telegram/i.test(String(c.arguments[0])))),
    'startPrPoller ran on this settings save and logged the misconfiguration reason',
  );

  // An UNRELATED save (no prReview/telegram in the payload) must not touch the poller: the persisted
  // prReview/telegram are unchanged on disk, so prReviewCfgKey is unchanged, so no restart is queued.
  warnSpy.mock.resetCalls();
  await sendAndWait(ws, {
    type: 'update-settings',
    requestId: '3',
    settings: { cursorBlink: true },
  }, 'settings-updated');
  await new Promise((r) => setTimeout(r, 300)); // bounded settle window for a negative assertion
  assert.equal(prPollerWarns(warnSpy).length, 0, 'an unrelated settings save never restarts the poller');

  // Disabling is a real prReview change -> a restart IS queued, but it is a clean gate failure
  // (reason: null) so no warning, and the wiring must not throw on a second consecutive restart
  // (stop-then-start of a poller that was never actually started).
  warnSpy.mock.resetCalls();
  await sendAndWait(ws, {
    type: 'update-settings',
    requestId: '4',
    settings: { prReview: { enabled: false } },
  }, 'settings-updated');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(prPollerWarns(warnSpy).length, 0, 'a clean disable does not warn');

  ws.close();
}));
