import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';

import { createBackend } from '../server/backend.ts';
import { MAX_UPLOAD_BYTES } from '../server/core/upload-core.ts';
import type { Session } from '../session/sessions.ts';
import { capturingPty } from './helpers/fake-pty.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';
import type { Backend } from './helpers/lanes.ts';

const SESSION_ID = 'a0000000-0000-4000-8000-000000000001';

interface UploadRouteContext {
  tmpDir: string;
  prevEnv: string | undefined;
  server: Server;
  backend: Backend;
  base: string;
  session: Session;
}

const booted: { context: UploadRouteContext | null } = { context: null };

const ptyWrites: string[] = [];

function ctx(): UploadRouteContext {
  if (!booted.context) throw new Error('the backend was never booted');
  return booted.context;
}

function attachFakePty(): void {
  ptyWrites.length = 0;
  ctx().session.ptyProcess = capturingPty(ptyWrites);
  ctx().session._ptyAlive = true;
}

function detachFakePty(): void {
  ctx().session.ptyProcess = null;
  ctx().session._ptyAlive = false;
}

function uploadsDirFor(id: string): string {
  return path.join(ctx().tmpDir, 'uploads', id);
}

function listUploads(id: string): string[] {
  try {
    return fs.readdirSync(uploadsDirFor(id));
  } catch {
    return [];
  }
}

async function waitForUploadCount(id: string, expected: number): Promise<number> {
  const deadline = Date.now() + 3000;
  while (listUploads(id).length !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return listUploads(id).length;
}

async function fetchAfterReset(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    return fetch(url, init);
  }
}

test.before(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-uploadroute-'));
  const projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(projectDir);
  const cfgPath = path.join(tmpDir, 'config.json');
  const projects = [{ id: SESSION_ID, name: 'upload-target', path: projectDir }];
  fs.writeFileSync(cfgPath, JSON.stringify({ projects, teams: [], repoRoots: [] }, null, 2), 'utf8');
  const prevEnv = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = cfgPath;

  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });

  server.on('request', backend.app);
  await listenOnLoopback(server);

  const session = backend.getSession(SESSION_ID);
  assert.ok(session, 'the configured project is a session in the backend map');
  assert.equal(session.pid, null, 'the session is dormant; no PTY was spawned by this test');

  booted.context = { tmpDir, prevEnv, server, backend, base: `http://127.0.0.1:${boundPort(server)}`, session };
});

test.after(async () => {
  if (!booted.context) return;
  const { backend, server, prevEnv, tmpDir } = booted.context;
  detachFakePty();
  backend.shutdown();

  server.closeAllConnections();
  await closeServer(server);
  if (prevEnv == null) delete process.env.GLISSA_CONFIG;
  if (prevEnv != null) process.env.GLISSA_CONFIG = prevEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('unknown session id is rejected 404', async () => {
  const res = await fetch(`${ctx().base}/upload/no-such-session`, {
    method: 'POST', body: 'x', headers: { 'content-type': 'image/png' },
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'unknown session' });
});

test('a non-image content type is rejected 415 and writes nothing', async () => {
  attachFakePty();
  const res = await fetch(`${ctx().base}/upload/${SESSION_ID}`, {
    method: 'POST', body: 'not an image', headers: { 'content-type': 'application/pdf' },
  });
  assert.equal(res.status, 415);
  const body = await res.json();
  assert.equal(typeof body.error, 'string');
  assert.deepEqual(listUploads(SESSION_ID), [], 'nothing reached the disk');
  assert.deepEqual(ptyWrites, [], 'nothing reached the terminal');
});

test('a missing content type is rejected 415', async () => {
  attachFakePty();
  const res = await fetch(`${ctx().base}/upload/${SESSION_ID}`, { method: 'POST', body: 'x' });
  assert.equal(res.status, 415, 'undici sends text/plain for a string body; either way it is not an image');
  assert.deepEqual(ptyWrites, []);
});

test('an image is saved under the config dir and its path is bracket-pasted into the PTY', async () => {
  attachFakePty();
  const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
  const res = await fetch(`${ctx().base}/upload/${SESSION_ID}`, {
    method: 'POST', body: bytes, headers: { 'content-type': 'image/png' },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);

  assert.equal(path.dirname(body.path), uploadsDirFor(SESSION_ID), 'saved beside the temp config, per session');
  assert.equal(path.extname(body.path), '.png');
  assert.deepEqual(fs.readFileSync(body.path), bytes, 'bytes land verbatim');

  assert.deepEqual(ptyWrites, [`\x1b[200~${body.path} \x1b[201~`], 'exactly the bracketed paste, nothing else');
  assert.equal(ptyWrites[0].includes('\r'), false, 'the operator presses Enter, not Glissa');
  assert.equal(ptyWrites[0].includes('\n'), false);
});

test('a body past the 15MB cap is refused and the server survives', async () => {
  attachFakePty();
  const before = listUploads(SESSION_ID).length;
  const big = Buffer.alloc(MAX_UPLOAD_BYTES + 1024, 0x41);

  await fetch(`${ctx().base}/upload/${SESSION_ID}`, {
    method: 'POST', body: big, headers: { 'content-type': 'image/png' },
  })
    .then((res) => assert.notEqual(res.status, 200, 'oversize never yields 200'))
    .catch(() => {  });

  assert.deepEqual(ptyWrites, [], 'an aborted upload never pastes');
  assert.equal(await waitForUploadCount(SESSION_ID, before), before, 'the partial file was removed');

  const after = await fetchAfterReset(`${ctx().base}/upload/no-such-session`, {
    method: 'POST', body: 'x', headers: { 'content-type': 'image/png' },
  });
  assert.equal(after.status, 404, 'server is still alive and routing after the aborted request');
});

function sendHeadersThenReset(sessionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(boundPort(ctx().server), '127.0.0.1', () => {
      socket.write(
        `POST /upload/${sessionId} HTTP/1.1\r\n`
        + 'Host: 127.0.0.1\r\n'
        + 'content-type: image/png\r\n'
        + 'content-length: 4096\r\n'
        + 'connection: close\r\n\r\n',
        () => {
          socket.destroy();
          resolve();
        },
      );
    });
    socket.on('error', reject);
  });
}

test('a client that resets right after its headers leaves no orphan file and no wedged stream', async () => {
  attachFakePty();
  const before = listUploads(SESSION_ID).length;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await sendHeadersThenReset(SESSION_ID);
  }
  assert.equal(await waitForUploadCount(SESSION_ID, before), before, 'no partial file survived the reset');
  assert.deepEqual(ptyWrites, [], 'an abandoned upload never pastes');

  const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
  const res = await fetchAfterReset(`${ctx().base}/upload/${SESSION_ID}`, {
    method: 'POST', body: bytes, headers: { 'content-type': 'image/png' },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(ptyWrites, [`\x1b[200~${body.path} \x1b[201~`]);
  fs.rmSync(body.path, { force: true });
});

test('a session with no live terminal is refused 409 and keeps no orphan file', async () => {
  attachFakePty();
  const before = listUploads(SESSION_ID).length;
  detachFakePty();
  const res = await fetch(`${ctx().base}/upload/${SESSION_ID}`, {
    method: 'POST', body: Buffer.from('gif87a'), headers: { 'content-type': 'image/gif' },
  });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'session has no live terminal' });
  assert.equal(await waitForUploadCount(SESSION_ID, before), before, 'an upload nobody can paste is not left behind');
  assert.deepEqual(ptyWrites, []);
});
