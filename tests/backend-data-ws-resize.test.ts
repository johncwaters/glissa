import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import WebSocket from 'ws';

import { createBackend } from '../server/backend.ts';
import type { Session } from '../session/sessions.ts';
import { closeSocket, dashboardClient, openSocket } from './helpers/dashboard-ws.ts';
import type { DashboardClient } from './helpers/dashboard-ws.ts';
import { UNREACHABLE_PID } from './helpers/fake-pty.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';
import type { Backend } from './helpers/lanes.ts';

const SESSION_ID = 'a0000000-0000-4000-8000-000000000002';

interface ResizeCall {
  cols: number;
  rows: number;
}

interface ResizeContext {
  tmpDir: string;
  prevEnv: string | undefined;
  server: Server;
  backend: Backend;
  client: DashboardClient;
  session: Session;
}

const booted: { context: ResizeContext | null } = { context: null };
const ptyResizes: ResizeCall[] = [];

function ctx(): ResizeContext {
  if (!booted.context) throw new Error('the backend was never booted');
  return booted.context;
}

function attachFakePty(): void {
  ptyResizes.length = 0;

  ctx().session.ptyProcess = {
    pid: UNREACHABLE_PID,
    onData() {},
    onExit() {},
    write() {},
    resize: (cols: number, rows: number) => { ptyResizes.push({ cols, rows }); },
  };
  ctx().session._ptyAlive = true;
}

function openViewer(): Promise<WebSocket> {
  return openSocket(ctx().client, `/terminals/${SESSION_ID}`);
}

async function waitForResizeCount(expected: number): Promise<ResizeCall[]> {
  const deadline = Date.now() + 3000;
  while (ptyResizes.length < expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return ptyResizes;
}

async function closeViewer(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  await closeSocket(ws);
}

function settle(ms = 100): Promise<void> {
  return new Promise((resolve) => { setTimeout(() => resolve(), ms); });
}

test.before(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-dataws-resize-'));
  const projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(projectDir);
  const cfgPath = path.join(tmpDir, 'config.json');
  const projects = [{ id: SESSION_ID, name: 'resize-target', path: projectDir }];
  fs.writeFileSync(cfgPath, JSON.stringify({ projects, teams: [], repoRoots: [] }, null, 2), 'utf8');
  const prevEnv = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = cfgPath;

  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });

  server.on('request', backend.app);
  await listenOnLoopback(server);
  const client = await dashboardClient(boundPort(server));

  const session = backend.getSession(SESSION_ID);
  assert.ok(session, 'the configured project is a session in the backend map');
  assert.equal(session.pid, null, 'the session is dormant; no PTY was spawned by this test');

  booted.context = { tmpDir, prevEnv, server, backend, client, session };
});

test.after(async () => {
  if (!booted.context) return;
  const { backend, server, session, prevEnv, tmpDir } = booted.context;
  session.ptyProcess = null;
  session._ptyAlive = false;
  backend.shutdown();
  server.closeAllConnections();
  await closeServer(server);
  if (prevEnv == null) delete process.env.GLISSA_CONFIG;
  if (prevEnv != null) process.env.GLISSA_CONFIG = prevEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('unview hands the PTY back to the viewer that is still watching', async () => {
  attachFakePty();
  const desktop = await openViewer();
  const phone = await openViewer();

  desktop.send(JSON.stringify({ type: 'resize', cols: 200, rows: 50 }));
  await waitForResizeCount(1);
  phone.send(JSON.stringify({ type: 'resize', cols: 40, rows: 30 }));
  await waitForResizeCount(2);
  assert.deepEqual(ptyResizes.at(-1), { cols: 40, rows: 30 }, 'the newest active viewer still wins');

  phone.send(JSON.stringify({ type: 'unview' }));
  await waitForResizeCount(3);
  assert.deepEqual(ptyResizes.at(-1), { cols: 200, rows: 50 }, 'the desktop got its dimensions back');
  assert.equal(phone.readyState, WebSocket.OPEN, 'unview leaves the connection open; bytes keep flowing');

  await closeViewer(phone);
  await closeViewer(desktop);
});

test('a viewer that closes without unviewing hands the PTY back too', async () => {
  attachFakePty();
  const desktop = await openViewer();
  const phone = await openViewer();

  desktop.send(JSON.stringify({ type: 'resize', cols: 180, rows: 48 }));
  await waitForResizeCount(1);
  phone.send(JSON.stringify({ type: 'resize', cols: 40, rows: 30 }));
  await waitForResizeCount(2);

  await closeViewer(phone);
  await waitForResizeCount(3);
  assert.deepEqual(ptyResizes.at(-1), { cols: 180, rows: 48 });

  await closeViewer(desktop);
});

test('the last viewer leaving does not resize the PTY', async () => {
  attachFakePty();
  const only = await openViewer();
  only.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
  await waitForResizeCount(1);

  only.send(JSON.stringify({ type: 'unview' }));
  await closeViewer(only);
  await settle();
  assert.equal(ptyResizes.length, 1, 'nobody is left to speak for the PTY, so it keeps its size');
});

test('a repeated unview is a cheap no-op, not a re-apply', async () => {
  attachFakePty();
  const desktop = await openViewer();
  const phone = await openViewer();
  desktop.send(JSON.stringify({ type: 'resize', cols: 200, rows: 50 }));
  await waitForResizeCount(1);
  phone.send(JSON.stringify({ type: 'resize', cols: 40, rows: 30 }));
  await waitForResizeCount(2);

  phone.send(JSON.stringify({ type: 'unview' }));
  await waitForResizeCount(3);
  phone.send(JSON.stringify({ type: 'unview' }));
  phone.send(JSON.stringify({ type: 'unview' }));
  await settle();
  assert.equal(ptyResizes.length, 3);

  await closeViewer(phone);
  await closeViewer(desktop);
});

test('a same-size resize leaves the PTY untouched', async () => {
  attachFakePty();
  const phone = await openViewer();

  phone.send(JSON.stringify({ type: 'resize', cols: 150, rows: 44 }));
  await waitForResizeCount(1);
  assert.deepEqual(ptyResizes, [{ cols: 150, rows: 44 }]);

  phone.send(JSON.stringify({ type: 'resize', cols: 150, rows: 44 }));
  await settle();
  assert.deepEqual(ptyResizes, [{ cols: 150, rows: 44 }]);

  await closeViewer(phone);
});

test('an out-of-range resize is ignored and claims nothing', async () => {
  attachFakePty();
  const desktop = await openViewer();
  const phone = await openViewer();
  desktop.send(JSON.stringify({ type: 'resize', cols: 200, rows: 50 }));
  await waitForResizeCount(1);

  phone.send(JSON.stringify({ type: 'resize', cols: 9999, rows: 30 }));
  phone.send(JSON.stringify({ type: 'unview' }));
  await settle();
  assert.equal(ptyResizes.length, 1, 'the refused size neither applied nor triggered a hand-back');

  await closeViewer(phone);
  await closeViewer(desktop);
});
