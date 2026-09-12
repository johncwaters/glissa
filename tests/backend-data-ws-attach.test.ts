import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import headless from '@xterm/headless';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';

import { createBackend } from '../server/backend.ts';
import { PtySizeFrame } from '../shared/contracts/data-messages.ts';
import { SCREEN_KEEPER_SCROLLBACK, SCREEN_RESET } from '../session/core/screen-keeper-core.ts';
import type { Session } from '../session/sessions.ts';
import {
  binaryFramesOf, closeSocket, dashboardClient, openDataRecordingSocket, textFramesOf,
} from './helpers/dashboard-ws.ts';
import type { DashboardClient, DataRecordingSocket } from './helpers/dashboard-ws.ts';
import { fakePty } from './helpers/fake-pty.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';
import type { Backend } from './helpers/lanes.ts';

const { Terminal } = headless;

const SESSION_ID = 'a0000000-0000-4000-8000-000000000003';

type Cell = [string, number, number, number, boolean, boolean];

type Viewer = DataRecordingSocket;

interface AttachContext {
  tmpDir: string;
  prevEnv: string | undefined;
  server: Server;
  backend: Backend;
  client: DashboardClient;
  session: Session;
}

const booted: { context: AttachContext | null } = { context: null };

function ctx(): AttachContext {
  if (!booted.context) throw new Error('the backend was never booted');
  return booted.context;
}

function attachFakePty(): void {
  ctx().session.ptyProcess = fakePty();
  ctx().session._ptyAlive = true;
}

function openViewer(): Promise<Viewer> {
  return openDataRecordingSocket(ctx().client, `/terminals/${SESSION_ID}`);
}

function newTerminal(cols: number, rows: number): HeadlessTerminal {
  return new Terminal({ cols, rows, scrollback: SCREEN_KEEPER_SCROLLBACK, allowProposedApi: true });
}

function write(terminal: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => { terminal.write(data, () => resolve()); });
}

function dump(terminal: HeadlessTerminal): Cell[][] {
  const buffer = terminal.buffer.active;
  const rows: Cell[][] = [];
  for (let y = 0; y < buffer.length; y += 1) {
    const line = buffer.getLine(y);
    const cells: Cell[] = [];
    if (line) {
      for (let x = 0; x < terminal.cols; x += 1) {
        const cell = line.getCell(x);
        if (!cell) continue;
        cells.push([
          cell.getChars(),
          cell.getWidth(),
          cell.getFgColor(),
          cell.getBgColor(),
          cell.isBold() !== 0,
          cell.isInverse() !== 0,
        ]);
      }
    }
    rows.push(cells);
  }
  return rows;
}

function buildLine(index: number): string {
  const tint = 31 + (index % 7);
  const wide = index % 5 === 0 ? ' 世界' : '';
  return `\x1b[${tint}mbuild step ${index}\x1b[0m ${'.'.repeat(index % 40)}${wide}\r\n`;
}

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(() => resolve(), ms); });
}

test.before(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-dataws-attach-'));
  const projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(projectDir);
  const cfgPath = path.join(tmpDir, 'config.json');
  const projects = [{ id: SESSION_ID, name: 'attach-target', path: projectDir }];
  fs.writeFileSync(cfgPath, JSON.stringify({ projects, teams: [], repoRoots: [] }, null, 2), 'utf8');
  const prevEnv = process.env.GLIMMERVOID_CONFIG;
  process.env.GLIMMERVOID_CONFIG = cfgPath;

  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });
  server.on('request', backend.app);
  await listenOnLoopback(server);
  const client = await dashboardClient(boundPort(server));

  const session = backend.getSession(SESSION_ID);
  assert.ok(session, 'the configured project is a session in the backend map');

  booted.context = { tmpDir, prevEnv, server, backend, client, session };
});

test.after(async () => {
  if (!booted.context) return;
  const { backend, server, session, prevEnv, tmpDir } = booted.context;
  session.ptyProcess = null;
  session._ptyAlive = false;
  session._output.disposeScreenKeeper();
  backend.shutdown();
  server.closeAllConnections();
  await closeServer(server);
  if (prevEnv == null) delete process.env.GLIMMERVOID_CONFIG;
  if (prevEnv != null) process.env.GLIMMERVOID_CONFIG = prevEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('a socket attaching under continuous output ends up on the live screen, byte for byte', async () => {
  attachFakePty();
  const session = ctx().session;
  const emitted: string[] = [];

  const emit = (line: string): void => {
    emitted.push(line);
    session._handlePtyData(line);
  };

  for (let index = 0; index < 120; index += 1) emit(buildLine(index));
  await settle(30);

  const viewer = await openViewer();

  for (let index = 120; index < 200; index += 1) {
    emit(buildLine(index));
    if (index % 8 === 0) await settle(4);
  }
  await settle(250);

  assert.equal(binaryFramesOf(viewer).length, 1, 'exactly one size frame on attach and no change after it');
  const size = PtySizeFrame.parse(JSON.parse(binaryFramesOf(viewer)[0] ?? ''));

  const snapshotFrame = textFramesOf(viewer)[0];
  assert.ok(snapshotFrame, 'the socket got a screen frame');
  assert.ok(snapshotFrame.startsWith(SCREEN_RESET), 'the screen frame opens with the shared reset prefix');

  const liveTail = textFramesOf(viewer).slice(1).join('');
  const fullStream = emitted.join('');
  assert.ok(
    fullStream.endsWith(liveTail),
    'everything after the snapshot is the exact suffix of the stream: no byte arrived twice and none went missing',
  );

  const reference = newTerminal(size.cols, size.rows);
  await write(reference, fullStream);

  const replay = newTerminal(size.cols, size.rows);
  await write(replay, textFramesOf(viewer).join(''));

  assert.deepEqual(dump(replay), dump(reference), 'what the socket received IS the live screen');
  assert.equal(replay.buffer.active.cursorX, reference.buffer.active.cursorX);
  assert.equal(replay.buffer.active.cursorY, reference.buffer.active.cursorY);

  await closeSocket(viewer.ws);
  reference.dispose();
  replay.dispose();
});

test('a second socket attaching to the same session lands on the same screen', async () => {
  attachFakePty();
  const session = ctx().session;
  const first = await openViewer();
  const emitted: string[] = [];
  for (let index = 200; index < 260; index += 1) {
    const line = buildLine(index);
    emitted.push(line);
    session._handlePtyData(line);
  }
  await settle(120);

  const second = await openViewer();
  await settle(150);

  const firstReplay = newTerminal(80, 24);
  await write(firstReplay, textFramesOf(first).join(''));
  const secondReplay = newTerminal(80, 24);
  await write(secondReplay, textFramesOf(second).join(''));

  assert.deepEqual(dump(secondReplay), dump(firstReplay), 'a late socket sees what the early one sees');

  await closeSocket(first.ws);
  await closeSocket(second.ws);
  firstReplay.dispose();
  secondReplay.dispose();
});
