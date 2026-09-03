import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import type WebSocket from 'ws';

import { createBackend } from '../server/backend.ts';
import {
  buildReviewPrompt, createPrReviewWiring, prPollerShouldStart, prReviewCfgKey, readReviewResult,
} from '../server/pr-review-wiring.ts';
import type { PrGitWorkspace } from '../server/pr-poller.ts';
import { createSpawnGate } from '../server/spawn-gate.ts';
import { closeSocket, dashboardClient, openSocket } from './helpers/dashboard-ws.ts';
import type { DashboardClient } from './helpers/dashboard-ws.ts';
import { recordingSessionFactory } from './helpers/fake-session.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';

const INERT_WORKSPACE: PrGitWorkspace = {
  listWorktreeBranches: async () => [],
  create: async () => null,
  discard: async () => { throw new Error('no PR review is dispatched in this suite'); },
  removeWorktreeByPath: async () => { throw new Error('no PR review is dispatched in this suite'); },
};

function inertWiringDeps() {
  return {
    reviewSessions: new Map<string, unknown>(),
    closeSessionDataClients() {},
    hookRouter: null,
    getHookPort: null,
    spawnGate: createSpawnGate(),
    gitWorkspace: INERT_WORKSPACE,
    getProjectPathById: () => null,
  };
}

test('prPollerShouldStart: inert when prReview absent or disabled (no reason, silent)', () => {
  assert.deepEqual(prPollerShouldStart({}), { start: false, reason: null });
  assert.deepEqual(prPollerShouldStart({ prReview: { enabled: false } }), { start: false, reason: null });
});

test('prPollerShouldStart: enabled but telegram missing -> does not start, with a reason', () => {
  const r = prPollerShouldStart({ prReview: { enabled: true } });
  assert.equal(r.start, false);
  assert.ok(r.reason);
  assert.match(r.reason, /telegram/);
  const r2 = prPollerShouldStart({ prReview: { enabled: true }, telegram: { botToken: 'x' } });
  assert.equal(r2.start, false, 'chatId still missing');
});

test('prPollerShouldStart: enabled + telegram configured -> starts', () => {
  const r = prPollerShouldStart({ prReview: { enabled: true }, telegram: { botToken: 'x', chatId: '1' } });
  assert.deepEqual(r, { start: true, reason: null });
});

function assertPrStatusShape(status: Record<string, unknown>, { configured, reason }: { configured: boolean; reason: string | null }): void {
  assert.equal(status.type, 'pr-status');
  assert.equal(status.configured, configured);
  assert.equal(status.reason, reason);
  assert.deepEqual(status.projects, []);
  assert.ok(typeof status.ts === 'number' && Number.isFinite(status.ts));
}

test('PR review getStatus: disabled config synthesizes an off status', () => {
  const wiring = createPrReviewWiring({
    config: { prReview: { enabled: false }, replayBufferKB: 256 },
    ...inertWiringDeps(),
  });
  assertPrStatusShape(wiring.getStatus(), { configured: false, reason: null });
});

test('PR review getStatus: enabled without telegram synthesizes a misconfigured status', () => {
  const wiring = createPrReviewWiring({
    config: { prReview: { enabled: true }, replayBufferKB: 256 },
    ...inertWiringDeps(),
  });
  const status = wiring.getStatus();
  assertPrStatusShape(status, { configured: false, reason: 'prReview.enabled but telegram botToken/chatId missing' });
});

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

function withResultFile<T>(contents: string | null, fn: (resultPath: string) => T): T {
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

test('prReviewCfgKey: identical prReview/telegram produce the same key regardless of key order', () => {
  const a = prReviewCfgKey({ prReview: { enabled: true, projects: ['p1'] }, telegram: { botToken: 'x', chatId: 'y' } });
  const b = prReviewCfgKey({ telegram: { botToken: 'x', chatId: 'y' }, prReview: { enabled: true, projects: ['p1'] } });
  assert.equal(a, b);
});

test('prReviewCfgKey: absent prReview/telegram normalizes to null, distinct from a disabled/empty object', () => {
  assert.equal(prReviewCfgKey({}), prReviewCfgKey({ prReview: undefined, telegram: undefined }));
  assert.notEqual(prReviewCfgKey({}), prReviewCfgKey({ prReview: { enabled: false } }));
});

test('prReviewCfgKey: a changed packs list counts as a lane config change', () => {
  const base = { prReview: { enabled: true, projects: ['p1'], packs: ['crew-rules'] }, telegram: { botToken: 'x', chatId: 'y' } };
  const changed = { prReview: { enabled: true, projects: ['p1'], packs: ['house-rules'] }, telegram: { botToken: 'x', chatId: 'y' } };
  assert.notEqual(prReviewCfgKey(base), prReviewCfgKey(changed));
});

test('PR review lane passes configured packs into Session options', () => {
  const { makeSession, constructed, created } = recordingSessionFactory();
  const wiring = createPrReviewWiring({
    config: { prReview: { packs: ['crew-rules', '../bad', 'crew-rules', 'house-rules'] }, replayBufferKB: 256 },
    ...inertWiringDeps(),
    makeSession,
  });
  try {
    wiring._makeReviewSession({ id: 'pr:1', name: 'PR', path: process.cwd(), initialPrompt: 'prompt' });
    assert.deepEqual(constructed[0].packs, ['crew-rules', 'house-rules']);
  } finally {
    for (const session of created) session.destroy();
  }
});

test('with the mill off the PR review lane spawns with no pack at all', () => {
  const { makeSession, constructed, created } = recordingSessionFactory();
  const wiring = createPrReviewWiring({
    config: { millEnabled: false, prReview: { packs: ['crew-rules', 'house-rules'] }, replayBufferKB: 256 },
    ...inertWiringDeps(),
    makeSession,
  });
  try {
    wiring._makeReviewSession({ id: 'pr:1', name: 'PR', path: process.cwd(), initialPrompt: 'prompt' });
    assert.deepEqual(constructed[0].packs, []);
  } finally {
    for (const session of created) session.destroy();
  }
});

function withBackend(fn: (t: TestContext, dash: DashboardClient) => Promise<void>) {
  return async (t: TestContext) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-prrestart-'));
    const cfgPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ projects: [], teams: [], repoRoots: [] }, null, 2), 'utf8');
    const prevEnv = process.env.GLISSA_CONFIG;
    process.env.GLISSA_CONFIG = cfgPath;

    const server = http.createServer();
    const backend = createBackend(server, { staticDir: null });
    server.on('request', backend.app);
    await listenOnLoopback(server);
    const dash = await dashboardClient(boundPort(server));

    try {
      await fn(t, dash);
    } finally {
      backend.shutdown();
      server.closeAllConnections();
      await closeServer(server);
      if (prevEnv == null) delete process.env.GLISSA_CONFIG;
      if (prevEnv != null) process.env.GLISSA_CONFIG = prevEnv;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

interface SettingsFrame {
  type: string;
  requestId?: string | null;
  settings?: Record<string, unknown>;
}

function sendAndWait(ws: WebSocket, message: unknown, matchType: string): Promise<SettingsFrame> {
  return new Promise((resolve) => {
    function onMessage(raw: Buffer) {
      const parsed = JSON.parse(raw.toString());
      if (parsed.type !== matchType) return;
      ws.off('message', onMessage);
      resolve(parsed);
    }
    ws.on('message', onMessage);
    ws.send(JSON.stringify(message));
  });
}

async function waitFor(predicate: () => boolean, { timeoutMs = 2000, intervalMs = 20 } = {}): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(() => resolve(), ms); });
}

test('update-settings hot-applies the poller only when prReview/telegram actually changed', withBackend(async (t, dash) => {
  const warnSpy = t.mock.method(console, 'warn');
  const prPollerWarnings = () => warnSpy.mock.calls
    .map((call) => String(call.arguments[0]))
    .filter((line) => /pr-poller/i.test(line));
  const ws = await openSocket(dash, '/control');

  await sendAndWait(ws, { type: 'get-settings', requestId: '1' }, 'settings');

  warnSpy.mock.resetCalls();
  const updated = await sendAndWait(ws, {
    type: 'update-settings',
    requestId: '2',
    settings: { prReview: { enabled: true }, telegram: { botToken: '', chatId: '' } },
  }, 'settings-updated');

  assert.deepEqual(updated.settings?.prReview, { enabled: true });
  assert.ok(
    await waitFor(() => prPollerWarnings().some((line) => /not starting.*telegram/i.test(line))),
    'startPrPoller ran on this settings save and logged the misconfiguration reason',
  );

  warnSpy.mock.resetCalls();
  await sendAndWait(ws, {
    type: 'update-settings',
    requestId: '3',
    settings: { cursorBlink: true },
  }, 'settings-updated');
  await settle(300);
  assert.equal(prPollerWarnings().length, 0, 'an unrelated settings save never restarts the poller');

  warnSpy.mock.resetCalls();
  await sendAndWait(ws, {
    type: 'update-settings',
    requestId: '4',
    settings: { prReview: { enabled: false } },
  }, 'settings-updated');
  await settle(300);
  assert.equal(prPollerWarnings().length, 0, 'a clean disable does not warn');

  await closeSocket(ws);
}));
