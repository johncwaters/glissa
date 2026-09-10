import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import WebSocket from 'ws';

import { createBackend } from '../server/backend.ts';
import { PtySizeFrame } from '../shared/contracts/data-messages.ts';
import { SCREEN_RESET } from '../session/core/screen-keeper-core.ts';
import type { Session } from '../session/sessions.ts';
import { closeSocket, dashboardClient, openDataRecordingSocket } from './helpers/dashboard-ws.ts';
import type { DashboardClient, DataRecordingSocket } from './helpers/dashboard-ws.ts';
import { UNREACHABLE_PID } from './helpers/fake-pty.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';
import type { Backend } from './helpers/lanes.ts';

const SESSION_ID = 'a0000000-0000-4000-8000-000000000002';

interface ResizeCall {
  cols: number;
  rows: number;
}

type Viewer = DataRecordingSocket;

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

function openViewer(): Promise<Viewer> {
  return openDataRecordingSocket(ctx().client, `/terminals/${SESSION_ID}`);
}

function sizeFrames(viewer: Viewer): PtySizeFrame[] {
  return viewer.frames
    .filter((frame) => frame.binary)
    .map((frame) => PtySizeFrame.parse(JSON.parse(frame.text)));
}

async function waitForResizeCount(expected: number): Promise<ResizeCall[]> {
  const deadline = Date.now() + 3000;
  while (ptyResizes.length < expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return ptyResizes;
}

async function waitForSizeFrames(viewer: Viewer, expected: number): Promise<PtySizeFrame[]> {
  const deadline = Date.now() + 3000;
  while (sizeFrames(viewer).length < expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return sizeFrames(viewer);
}

function claim(viewer: Viewer, cols: number, rows: number): void {
  viewer.ws.send(JSON.stringify({ type: 'claim', cols, rows }));
}

async function closeViewer(viewer: Viewer): Promise<void> {
  if (viewer.ws.readyState === WebSocket.CLOSED) return;
  await closeSocket(viewer.ws);
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

test('attach sends the authoritative size first, then one screen frame', async () => {
  attachFakePty();
  const viewer = await openViewer();
  await waitForSizeFrames(viewer, 1);
  await settle(50);

  const first = viewer.frames[0];
  assert.ok(first, 'the socket received something');
  assert.equal(first.binary, true, 'the size frame is binary and arrives first');
  const size = PtySizeFrame.parse(JSON.parse(first.text));
  assert.equal(size.type, 'pty-size');
  assert.ok(size.cols > 0 && size.rows > 0);

  const second = viewer.frames[1];
  assert.ok(second, 'the screen frame follows the size frame');
  assert.equal(second.binary, false, 'PTY bytes stay text frames');
  assert.ok(second.text.startsWith(SCREEN_RESET), 'the screen frame opens with the shared reset prefix');

  await closeViewer(viewer);
});

test('every socket of the session is told about an accepted size change', async () => {
  attachFakePty();
  const desktop = await openViewer();
  const phone = await openViewer();
  await waitForSizeFrames(desktop, 1);
  await waitForSizeFrames(phone, 1);

  claim(phone, 100, 42);
  await waitForResizeCount(1);
  const desktopSizes = await waitForSizeFrames(desktop, 2);
  const phoneSizes = await waitForSizeFrames(phone, 2);

  assert.deepEqual(
    { cols: desktopSizes[1]?.cols, rows: desktopSizes[1]?.rows },
    { cols: 100, rows: 42 },
    'a viewer that did not claim still learns the authoritative size',
  );
  assert.deepEqual({ cols: phoneSizes[1]?.cols, rows: phoneSizes[1]?.rows }, { cols: 100, rows: 42 });
  assert.ok((phoneSizes[1]?.seq ?? 0) > (phoneSizes[0]?.seq ?? 0), 'the sequence climbs with every accepted change');

  await closeViewer(phone);
  await closeViewer(desktop);
});

test('the newest claimant wins while it is still watching', async () => {
  attachFakePty();
  const desktop = await openViewer();
  const phone = await openViewer();

  claim(desktop, 200, 50);
  await waitForResizeCount(1);
  claim(phone, 40, 30);
  await waitForResizeCount(2);
  assert.deepEqual(ptyResizes.at(-1), { cols: 40, rows: 30 }, 'the newest active viewer still wins');

  phone.ws.send(JSON.stringify({ type: 'unview' }));
  await waitForResizeCount(3);
  assert.deepEqual(ptyResizes.at(-1), { cols: 200, rows: 50 }, 'the desktop got its dimensions back');
  assert.equal(phone.ws.readyState, WebSocket.OPEN, 'unview leaves the connection open; bytes keep flowing');

  await closeViewer(phone);
  await closeViewer(desktop);
});

test('a viewer that closes without unviewing hands the PTY back too', async () => {
  attachFakePty();
  const desktop = await openViewer();
  const phone = await openViewer();

  claim(desktop, 180, 48);
  await waitForResizeCount(1);
  claim(phone, 40, 30);
  await waitForResizeCount(2);

  await closeViewer(phone);
  await waitForResizeCount(3);
  assert.deepEqual(ptyResizes.at(-1), { cols: 180, rows: 48 });

  await closeViewer(desktop);
});

test('the last viewer leaving does not resize the PTY', async () => {
  attachFakePty();
  const only = await openViewer();
  claim(only, 120, 40);
  await waitForResizeCount(1);

  only.ws.send(JSON.stringify({ type: 'unview' }));
  await closeViewer(only);
  await settle();
  assert.equal(ptyResizes.length, 1, 'nobody is left to speak for the PTY, so it keeps its size');
});

test('a repeated unview is a cheap no-op, not a re-apply', async () => {
  attachFakePty();
  const desktop = await openViewer();
  const phone = await openViewer();
  claim(desktop, 200, 50);
  await waitForResizeCount(1);
  claim(phone, 40, 30);
  await waitForResizeCount(2);

  phone.ws.send(JSON.stringify({ type: 'unview' }));
  await waitForResizeCount(3);
  phone.ws.send(JSON.stringify({ type: 'unview' }));
  phone.ws.send(JSON.stringify({ type: 'unview' }));
  await settle();
  assert.equal(ptyResizes.length, 3);

  await closeViewer(phone);
  await closeViewer(desktop);
});

test('a claim matching the size the PTY already has leaves it untouched', async () => {
  attachFakePty();
  const phone = await openViewer();

  claim(phone, 150, 44);
  await waitForResizeCount(1);
  await waitForSizeFrames(phone, 2);
  assert.deepEqual(ptyResizes, [{ cols: 150, rows: 44 }]);

  claim(phone, 150, 44);
  await settle();
  assert.deepEqual(ptyResizes, [{ cols: 150, rows: 44 }]);
  assert.equal(sizeFrames(phone).length, 2, 'one attach frame and one change frame, nothing for the no-op');

  await closeViewer(phone);
});

test('an out-of-range claim is refused outright and claims nothing', async () => {
  attachFakePty();
  const desktop = await openViewer();
  const phone = await openViewer();
  claim(desktop, 200, 50);
  await waitForResizeCount(1);

  claim(phone, 9999, 30);
  phone.ws.send(JSON.stringify({ type: 'unview' }));
  await settle();
  assert.equal(ptyResizes.length, 1, 'the refused size neither applied nor triggered a hand-back');

  await closeViewer(phone);
  await closeViewer(desktop);
});

test('the retired resize message and malformed frames are dropped, never fatal', async () => {
  attachFakePty();
  const viewer = await openViewer();
  claim(viewer, 130, 41);
  await waitForResizeCount(1);

  viewer.ws.send(JSON.stringify({ type: 'resize', cols: 60, rows: 20 }));
  viewer.ws.send('{ not json');
  viewer.ws.send(JSON.stringify({ type: 'claim', cols: 'wide', rows: 20 }));
  await settle();

  assert.equal(ptyResizes.length, 1, 'the legacy resize branch is gone');
  assert.equal(viewer.ws.readyState, WebSocket.OPEN, 'a malformed frame is dropped, not a reason to close');

  await closeViewer(viewer);
});

test('a claim against a session with no live PTY is still echoed to every socket', async () => {
  attachFakePty();
  ctx().session.ptyProcess = null;
  ctx().session._ptyAlive = false;

  const viewer = await openViewer();
  await waitForSizeFrames(viewer, 1);
  claim(viewer, 96, 36);

  const sizes = await waitForSizeFrames(viewer, 2);
  assert.deepEqual(
    { cols: sizes[1]?.cols, rows: sizes[1]?.rows },
    { cols: 96, rows: 36 },
    'the remembered size the next attacher would be told is the size the claimant hears back',
  );
  assert.equal(ptyResizes.length, 0, 'there was no PTY to accept it');

  await closeViewer(viewer);
});
