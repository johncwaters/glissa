// HTTP-level coverage of the SECOND write ingress: POST /upload/:sessionId (the phone key strip's
// Image button). The pure rules live in upload-core.test.ts; this exercises the mounted Express route
// end to end: unknown session, refused content type, the 15MB cap, the happy path (file on disk +
// exactly the bracketed paste into the session's PTY), and a dead PTY leaving no orphan file.
//
// SAFETY: createBackend resolves its config store and runs a boot worktree reconcile against the
// configured projects, so it is pointed at a throwaway temp config via GLISSA_CONFIG and can never
// see a real repo (memory: booting the backend against the real config once destroyed an active
// worktree). The route needs a session in the backend's map, so this file carries EXACTLY ONE
// project, whose path is an empty temp directory: not a git repo, so the reconcile lists no
// worktrees and removes nothing, and the boot loop builds the session DORMANT without spawning.
// Adding the session over the control WS instead is NOT safe here - that path calls sess.start(),
// which launches a real `claude` PTY. Never point this file at a path outside its temp dir.

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
// Everything the fake PTY was told to write, in order.
const ptyWrites: string[] = [];

function ctx(): UploadRouteContext {
  if (!booted.context) throw new Error('the backend was never booted');
  return booted.context;
}

// A live-enough PTY: Session.write only checks ptyProcess + _ptyAlive, so a recorder is all the route
// can observe. capturingPty's pid is deliberately past every platform's pid_max: shutdown() destroys
// this session, and off Windows that kill signals the pid's process GROUP, which must never name a
// real one on the host. No real `claude` process ever launches in this file.
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

// A refused upload unlinks its partial file asynchronously, so the count is polled rather than read
// once behind a fixed sleep.
async function waitForUploadCount(id: string, expected: number): Promise<number> {
  const deadline = Date.now() + 3000;
  while (listUploads(id).length !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return listUploads(id).length;
}

// A request the server destroys mid-body can leave undici's pooled keep-alive socket unusable, so the
// NEXT request fails at the transport with no server fault. One retry (on a connection the pool has
// since replaced) separates that from a server that actually died: a dead server refuses both.
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
  // createBackend returns the Express app; the embedder wires it (mirrors server/main.ts).
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
  // fetch (undici) pools keep-alive sockets; server.close() alone would wait on them forever.
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
  const bytes = Buffer.from('89504e470d0a1a0a', 'hex'); // PNG magic; the route stores bytes verbatim
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
  // The route destroys the request mid-body; fetch surfaces that as a network error OR a non-200.
  await fetch(`${ctx().base}/upload/${SESSION_ID}`, {
    method: 'POST', body: big, headers: { 'content-type': 'image/png' },
  })
    .then((res) => assert.notEqual(res.status, 200, 'oversize never yields 200'))
    .catch(() => { /* connection reset is the expected shape */ });

  assert.deepEqual(ptyWrites, [], 'an aborted upload never pastes');
  assert.equal(await waitForUploadCount(SESSION_ID, before), before, 'the partial file was removed');

  // The regression this pins: req.destroy() emits a request 'error'; without the route's error
  // listener that throw kills the whole process. A follow-up request must still be served.
  const after = await fetchAfterReset(`${ctx().base}/upload/no-such-session`, {
    method: 'POST', body: 'x', headers: { 'content-type': 'image/png' },
  });
  assert.equal(after.status, 404, 'server is still alive and routing after the aborted request');
});

// The window the route's synchronous req.on('error') exists for: a client that sends headers and then
// resets while the uploads mkdir is still pending. With the error swallowed (no listener yet) and the
// body piped with req.pipe, the destroyed request never emits 'end', so the write stream stays open
// forever - a leaked fd and a partial file per aborted request. Both symptoms are visible as an orphan
// left in the session's uploads directory.
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

  // The server is still healthy afterwards, and its next real upload behaves exactly as before.
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
