import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type WebSocket from 'ws';

import { createBackend } from '../server/backend.ts';
import { closeSocket, dashboardClient, openRecordingSocket, waitForMessage } from './helpers/dashboard-ws.ts';
import type { DashboardClient } from './helpers/dashboard-ws.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';
import { visionsLane } from './helpers/lanes.ts';
import type { Backend } from './helpers/lanes.ts';
import { createReplayLog } from '../server/control-replay-core.ts';

const MARKDOWN_URI = 'file:///tmp/plan-visions.md';
const REPEATED_WORD_MARKDOWN = '# Title\n\nA line with with a repeat.\n';

interface Diagnostic {
  code: string;
}

interface VisionsDocument {
  uri: string;
  diagnostics: Diagnostic[];
}

interface IntentThread {
  id: string;
  text: string;
  ts: number;
}

interface IntentState {
  active: IntentThread;
  threads: IntentThread[];
}

type ControlFrame =
  | { type: 'visions-snapshot'; documents: VisionsDocument[]; intent: { byProject: Record<string, unknown>; unowned: IntentThread[] } }
  | { type: 'visions-findings'; uri: string; ts: number; diagnostics: Diagnostic[] }
  | { type: 'visions-intent'; projectId: string | null; intent: IntentState }
  | { type: string };

interface VisionsScope {
  dash: DashboardClient;
  backend: Backend;
  track: (ws: WebSocket) => WebSocket;
}

function withVisionsBackend(fn: (scope: VisionsScope) => Promise<void>) {
  return async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-visions-tab-'));
    const cfgPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      projects: [{ id: 'harness', name: 'harness', path: '/tmp' }], teams: [], repoRoots: [], visions: { enabled: true },
    }, null, 2), 'utf8');
    const prevEnv = process.env.GLISSA_CONFIG;
    process.env.GLISSA_CONFIG = cfgPath;

    const server = http.createServer();
    const backend = createBackend(server, { staticDir: null });
    server.on('request', backend.app);
    await listenOnLoopback(server);
    const dash = await dashboardClient(boundPort(server));
    const sockets: WebSocket[] = [];

    try {
      await fn({ dash, backend, track: (ws) => { sockets.push(ws); return ws; } });
    } finally {
      for (const ws of sockets) ws.close();
      backend.shutdown();
      server.closeAllConnections();
      await closeServer(server);
      if (prevEnv == null) delete process.env.GLISSA_CONFIG;
      if (prevEnv != null) process.env.GLISSA_CONFIG = prevEnv;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

function isSnapshot(frame: ControlFrame): frame is Extract<ControlFrame, { type: 'visions-snapshot' }> {
  return frame.type === 'visions-snapshot';
}

function isFindings(frame: ControlFrame): frame is Extract<ControlFrame, { type: 'visions-findings' }> {
  return frame.type === 'visions-findings';
}

function isIntent(frame: ControlFrame): frame is Extract<ControlFrame, { type: 'visions-intent' }> {
  return frame.type === 'visions-intent';
}

function sendLsp(ws: WebSocket, method: string, params: Record<string, unknown>): void {
  ws.send(JSON.stringify({ type: 'lsp', method, params }));
}

test('a sweep reaches every connected dashboard, and a later one is repaired by the snapshot', withVisionsBackend(async ({ dash, track }) => {
  const dashboard = await openRecordingSocket<ControlFrame>(dash, '/control');
  track(dashboard.ws);
  const snapshotOnFirstConnect = await waitForMessage(dashboard.received, isSnapshot, 'visions-snapshot');
  assert.deepEqual(snapshotOnFirstConnect.documents, [], 'nothing is open yet, so the repair frame is empty');

  const relay = await openRecordingSocket<ControlFrame>(dash, '/visions');
  track(relay.ws);
  sendLsp(relay.ws, 'textDocument/didOpen', {
    textDocument: {
      uri: MARKDOWN_URI, languageId: 'markdown', version: 1, text: REPEATED_WORD_MARKDOWN,
    },
  });

  const pushed = await waitForMessage(dashboard.received, isFindings, 'visions-findings');
  assert.equal(pushed.uri, MARKDOWN_URI);
  assert.deepEqual(pushed.diagnostics.map((diagnostic) => diagnostic.code), ['repeated-word']);
  assert.ok(Number.isFinite(pushed.ts) && pushed.ts > 0);

  const reconnected = await openRecordingSocket<ControlFrame>(dash, '/control');
  track(reconnected.ws);
  const repaired = await waitForMessage(reconnected.received, isSnapshot, 'visions-snapshot');
  assert.deepEqual(repaired.documents.map((document) => document.uri), [MARKDOWN_URI]);
  assert.deepEqual(repaired.documents[0].diagnostics.map((diagnostic) => diagnostic.code), ['repeated-word']);

  sendLsp(relay.ws, 'textDocument/didClose', { textDocument: { uri: MARKDOWN_URI } });
  const cleared = await waitForMessage(
    dashboard.received,
    (frame): frame is Extract<ControlFrame, { type: 'visions-findings' }> => isFindings(frame) && frame.diagnostics.length === 0,
    'an emptied visions-findings',
  );
  assert.equal(cleared.uri, MARKDOWN_URI);

  const afterClose = await openRecordingSocket<ControlFrame>(dash, '/control');
  track(afterClose.ws);
  const emptyRepair = await waitForMessage(afterClose.received, isSnapshot, 'visions-snapshot');
  assert.deepEqual(emptyRepair.documents, []);
}));

test('a model intent proposal broadcasts and rides the snapshot repair', withVisionsBackend(async ({ dash, backend, track }) => {
  const dashboard = await openRecordingSocket<ControlFrame>(dash, '/control');
  track(dashboard.ws);
  const firstSnapshot = await waitForMessage(dashboard.received, isSnapshot, 'visions-snapshot');
  assert.deepEqual(firstSnapshot.intent, { byProject: {}, unowned: [] }, 'a fresh daemon believes nothing yet');

  const lane = visionsLane(backend);
  assert.ok(lane, 'the visions lane is up');
  assert.equal(lane.applyModelIntent('  rewriting the merge gate  '), true);
  const proposed = await waitForMessage(dashboard.received, isIntent, 'visions-intent');
  assert.equal(proposed.projectId, null, 'no project owns it, so it is the unowned list');
  assert.equal(proposed.intent.active.text, 'rewriting the merge gate');
  assert.match(proposed.intent.active.id, /^t-[0-9a-f]{8}$/);
  assert.deepEqual(proposed.intent.threads, [proposed.intent.active]);
  assert.ok(Number.isFinite(proposed.intent.active.ts) && proposed.intent.active.ts > 0);

  const reconnected = await openRecordingSocket<ControlFrame>(dash, '/control');
  track(reconnected.ws);
  const repaired = await waitForMessage(reconnected.received, isSnapshot, 'visions-snapshot');
  assert.equal(repaired.intent.unowned[0].text, 'rewriting the merge gate');
  assert.equal(repaired.intent.unowned[0].id, proposed.intent.active.id);
  assert.deepEqual(repaired.intent.byProject, {});
}));

test('a control client connecting with the lane off is told nothing about the visions', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-visions-off-'));
  const cfgPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ projects: [], teams: [], repoRoots: [] }, null, 2), 'utf8');
  const prevEnv = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = cfgPath;

  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });
  server.on('request', backend.app);
  await listenOnLoopback(server);

  try {
    const dash = await dashboardClient(boundPort(server));
    const { ws, received } = await openRecordingSocket<ControlFrame>(dash, '/control');
    await waitForMessage(received, (frame) => frame.type === 'client-trust', 'client-trust');
    assert.equal(received.some((frame) => frame.type.startsWith('visions-')), false, 'an absent lane adds no frame');
    await closeSocket(ws);
  } finally {
    backend.shutdown();
    server.closeAllConnections();
    await closeServer(server);
    if (prevEnv == null) delete process.env.GLISSA_CONFIG;
    if (prevEnv != null) process.env.GLISSA_CONFIG = prevEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('visions messages are not on the control replay retention list', () => {
  const log = createReplayLog();
  log.stamp({ type: 'visions-findings', uri: MARKDOWN_URI, diagnostics: [], ts: 1 });
  log.stamp({ type: 'visions-snapshot', documents: [], ts: 2 });
  log.stamp({ type: 'session-error', session: 'probe', message: 'kept' });

  const { entries } = log.entriesSince(0);
  assert.deepEqual(entries.map((entry) => entry.type), ['session-error']);
});
