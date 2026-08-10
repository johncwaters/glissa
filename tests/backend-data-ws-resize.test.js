'use strict';

// Active-viewer resize arbitration over the data WebSocket. One session owns one PTY but any number of
// data connections, so a phone opening a session used to reflow the desktop's terminal to phone width
// and leave it there: the desktop's own box never changed, so its client cached the size and never
// re-pushed. The departing viewer now hands its claim back ({type:'unview'}, or a close) and the server
// re-applies the most recent surviving viewer's size. The decision itself is pure
// (tests/viewer-size-core.test.js); this file pins the wiring.
//
// SAFETY: same constraints as tests/backend-upload-route.test.js. createBackend runs a boot worktree
// reconcile against the configured projects, so GLISSA_CONFIG points at a throwaway temp config whose
// ONE project is an empty temp directory (not a git repo, so nothing is listed or removed) and whose
// session stays DORMANT. Never point this file at a path outside its temp dir. A fake PTY records the
// resizes; no real `claude` process launches.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const { createBackend } = require('../server/backend');

const SESSION_ID = 'a0000000-0000-4000-8000-000000000002';

let tmpDir = null;
let prevEnv = null;
let server = null;
let backend = null;
let base = null;
let session = null;
let ptyResizes = [];

function attachFakePty() {
  ptyResizes = [];
  session.ptyProcess = { write() {}, resize: (cols, rows) => ptyResizes.push({ cols, rows }), pid: 4243 };
  session._ptyAlive = true;
}

async function openViewer() {
  const ws = new WebSocket(`${base}/terminals/${SESSION_ID}`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
}

// Every message this file sends produces at most one pty.resize, so the assertions poll for the
// expected total rather than sleeping a fixed amount and hoping.
async function waitForResizeCount(expected) {
  const deadline = Date.now() + 3000;
  while (ptyResizes.length < expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return ptyResizes;
}

async function closeViewer(ws) {
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  const closed = new Promise((resolve) => ws.once('close', resolve));
  ws.close();
  await closed;
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-dataws-resize-'));
  const projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(projectDir);
  const cfgPath = path.join(tmpDir, 'config.json');
  const projects = [{ id: SESSION_ID, name: 'resize-target', path: projectDir }];
  fs.writeFileSync(cfgPath, JSON.stringify({ projects, teams: [], repoRoots: [] }, null, 2), 'utf8');
  prevEnv = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = cfgPath;

  server = http.createServer();
  backend = createBackend(server, { staticDir: null });
  // createBackend registers its own 'upgrade' listener; only 'request' is the embedder's to wire.
  server.on('request', backend.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `ws://127.0.0.1:${server.address().port}`;

  session = backend.getSession(SESSION_ID);
  assert.ok(session, 'the configured project is a session in the backend map');
  assert.equal(session.pid, null, 'the session is dormant; no PTY was spawned by this test');
});

test.after(async () => {
  if (session) {
    session.ptyProcess = null;
    session._ptyAlive = false;
  }
  if (backend) backend.shutdown();
  if (server) server.closeAllConnections();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (prevEnv == null) delete process.env.GLISSA_CONFIG;
  if (prevEnv != null) process.env.GLISSA_CONFIG = prevEnv;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
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
  await new Promise((resolve) => setTimeout(resolve, 100));
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
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(ptyResizes.length, 3);

  await closeViewer(phone);
  await closeViewer(desktop);
});

test('an out-of-range resize is ignored and claims nothing', async () => {
  attachFakePty();
  const desktop = await openViewer();
  const phone = await openViewer();
  desktop.send(JSON.stringify({ type: 'resize', cols: 200, rows: 50 }));
  await waitForResizeCount(1);

  phone.send(JSON.stringify({ type: 'resize', cols: 9999, rows: 30 }));
  phone.send(JSON.stringify({ type: 'unview' }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(ptyResizes.length, 1, 'the refused size neither applied nor triggered a hand-back');

  await closeViewer(phone);
  await closeViewer(desktop);
});
