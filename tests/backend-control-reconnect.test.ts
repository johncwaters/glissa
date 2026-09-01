import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createBackend } from '../server/backend.ts';
import { closeSocket, dashboardClient, openRecordingSocket, openSocket, waitForMessage } from './helpers/dashboard-ws.ts';
import type { DashboardClient } from './helpers/dashboard-ws.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';

const SESSION_ID = 'reconnect-test-session';

const OVERSIZED_INPUT = 'x'.repeat(20000);

interface ControlFrame {
  type: string;
  id?: string;
  seq?: number;
  sessions?: { id: string }[];
}

function withBackend(fn: (client: DashboardClient) => Promise<void>) {
  return async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-reconnect-'));
    const cfgPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      projects: [{ id: SESSION_ID, name: 'reconnect probe', path: tmpDir }],
      teams: [], repoRoots: [],
    }, null, 2), 'utf8');
    const prevEnv = process.env.GLISSA_CONFIG;
    process.env.GLISSA_CONFIG = cfgPath;

    const server = http.createServer();
    const backend = createBackend(server, { staticDir: null });
    server.on('request', backend.app);
    await listenOnLoopback(server);

    const client = await dashboardClient(boundPort(server));

    try {
      await fn(client);
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

const isSessionError = (m: ControlFrame) => m.type === 'session-error';

test('a control reconnect carrying a replay cursor connects and gets snapshot then replay', withBackend(async (client) => {
  const first = await openRecordingSocket<ControlFrame>(client, '/control');
  const snapshot = await waitForMessage(first.received, (m) => m.type === 'snapshot', 'the snapshot');
  assert.deepEqual(snapshot.sessions?.map((s) => s.id), [SESSION_ID]);

  const dataConnection = await openSocket(client, `/terminals/${SESSION_ID}?probe=1`);
  const dataCloseCode = new Promise<number>((resolve) => { dataConnection.once('close', (code: number) => resolve(code)); });

  dataConnection.send(JSON.stringify({ type: 'input', data: OVERSIZED_INPUT }));
  const beforeCursor = await waitForMessage(first.received, isSessionError, 'the first session-error');
  assert.equal(beforeCursor.id, SESSION_ID, 'the query string never became part of the session id');
  assert.equal(typeof beforeCursor.seq, 'number');
  const cursorSeq = beforeCursor.seq ?? 0;

  dataConnection.send(JSON.stringify({ type: 'input', data: OVERSIZED_INPUT }));
  const afterCursor = await waitForMessage(
    first.received,
    (m) => isSessionError(m) && (m.seq ?? 0) > cursorSeq,
    'a session-error past the cursor',
  );

  await closeSocket(first.ws);

  const reconnected = await openRecordingSocket<ControlFrame>(client, `/control?since=${cursorSeq}`);
  const replayedError = await waitForMessage(reconnected.received, isSessionError, 'the replayed session-error');
  assert.equal(reconnected.received[0].type, 'snapshot', 'the snapshot is still the first frame of a reconnect');
  assert.equal(replayedError.seq, afterCursor.seq, 'exactly the broadcasts past the cursor are replayed');
  assert.equal(reconnected.received.filter(isSessionError).length, 1, 'the entry at the cursor is not replayed again');

  await closeSocket(reconnected.ws);
  await closeSocket(dataConnection);
  assert.notEqual(await dataCloseCode, 1008, 'the data socket was never refused as an unknown session');
}));

test('a data socket whose id does not exist is still refused', withBackend(async (client) => {
  const ws = await openSocket(client, '/terminals/no-such-session?probe=1');
  const code = await new Promise<number>((resolve) => { ws.once('close', (closeCode: number) => resolve(closeCode)); });
  assert.equal(code, 1008);
}));
