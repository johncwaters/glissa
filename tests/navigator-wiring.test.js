'use strict';

// The navigator lane, at both altitudes: the wiring driven directly on injected timers (debounce
// coalescing, save boundary, cleanup, malformed frames), and a REAL backend boot proving the
// /navigator upgrade is served on the local listener when enabled, inert when the config says nothing,
// and refused on the remote listener even when enabled.
//
// SAFETY: every boot points at a throwaway temp config with ZERO projects via GLISSA_CONFIG, like
// every other backend boot test (the boot worktree reconcile would otherwise touch real repos).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const { createBackend } = require('../server/backend');
const { createConfigStore, BOOLEAN_KEYS, STRING_KEYS, TIMEOUT_KEYS } = require('../server/config-store');
const { createNavigatorWiring, NAVIGATOR_DEBOUNCE_MS } = require('../server/navigator-wiring');

const MARKDOWN_URI = 'file:///tmp/plan-navigator.md';
const SCRIPT_URI = 'file:///tmp/app.js';
const CLEAN_MARKDOWN = '# Title\n\nA line with nothing wrong.\n';
const REPEATED_WORD_MARKDOWN = '# Title\n\nA line with with a repeat.\n';

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms).unref(); });
}

// --- Wiring driven directly (injected timers, no sockets) ---

function fakeTimers() {
  let nextId = 1;
  const pendingById = new Map();
  return {
    setTimeoutFn: (fn) => {
      const id = nextId++;
      pendingById.set(id, fn);
      return { id, unref() { return this; } };
    },
    clearTimeoutFn: (timer) => { if (timer) pendingById.delete(timer.id); },
    runPending: () => {
      const jobs = [...pendingById.values()];
      pendingById.clear();
      for (const job of jobs) job();
    },
    get pendingCount() { return pendingById.size; },
  };
}

const FIXED_TS = 1700000000000;

function drivenConnection() {
  const timers = fakeTimers();
  const warnings = [];
  const sent = [];
  const broadcasts = [];
  const wiring = createNavigatorWiring({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    nowFn: () => FIXED_TS,
    logger: { warn: (message) => warnings.push(message) },
    broadcast: (message) => broadcasts.push(message),
  });
  const connection = wiring.openConnection({ send: (message) => sent.push(message) });
  const lsp = (method, params) => connection.handleFrame(JSON.stringify({ type: 'lsp', method, params }));
  return { wiring, connection, timers, warnings, sent, broadcasts, lsp };
}

function didOpenParams(uri, languageId, text) {
  return { textDocument: { uri, languageId, version: 1, text } };
}

function didChangeParams(uri, version, text) {
  return { textDocument: { uri, version }, contentChanges: [{ text }] };
}

test('a burst of markdown edits coalesces into one sweep of the final text', (t) => {
  const { wiring, timers, sent, lsp } = drivenConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', CLEAN_MARKDOWN));
  lsp('textDocument/didChange', didChangeParams(MARKDOWN_URI, 2, '# Title\n\nA line\n'));
  lsp('textDocument/didChange', didChangeParams(MARKDOWN_URI, 3, REPEATED_WORD_MARKDOWN));
  assert.equal(timers.pendingCount, 1, 'one document, one pending sweep');
  assert.deepEqual(sent, [], 'nothing publishes before the quiet window');

  timers.runPending();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'publishDiagnostics');
  assert.equal(sent[0].params.uri, MARKDOWN_URI);
  assert.deepEqual(sent[0].params.diagnostics.map((d) => d.code), ['repeated-word']);
});

test('two open documents debounce independently', (t) => {
  const { wiring, timers, sent, lsp } = drivenConnection();
  t.after(() => wiring.stop());

  const otherUri = 'file:///tmp/other.markdown';
  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  lsp('textDocument/didOpen', didOpenParams(otherUri, undefined, REPEATED_WORD_MARKDOWN));
  assert.equal(timers.pendingCount, 2, 'a .markdown extension is markdown even with no languageId');

  timers.runPending();
  assert.deepEqual(sent.map((msg) => msg.params.uri).sort(), [MARKDOWN_URI, otherUri].sort());
});

test('a save publishes at once instead of waiting out the quiet window', (t) => {
  const { wiring, timers, sent, lsp } = drivenConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  lsp('textDocument/didSave', { textDocument: { uri: MARKDOWN_URI } });
  assert.equal(sent.length, 1, 'the save is the pause boundary');
  assert.equal(timers.pendingCount, 0, 'and it consumes the pending sweep rather than duplicating it');
});

test('a non-markdown document arms no timer and publishes nothing', (t) => {
  const { wiring, timers, sent, lsp } = drivenConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(SCRIPT_URI, 'javascript', 'const the the = 1;\n'));
  lsp('textDocument/didChange', didChangeParams(SCRIPT_URI, 2, 'const the the = 2;\n'));
  assert.equal(timers.pendingCount, 0);

  timers.runPending();
  lsp('textDocument/didSave', { textDocument: { uri: SCRIPT_URI } });
  assert.deepEqual(sent, [], 'v1 sweeps markdown only');
});

test('didClose drops the document and its pending sweep', (t) => {
  const { wiring, connection, timers, sent, lsp } = drivenConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  lsp('textDocument/didClose', { textDocument: { uri: MARKDOWN_URI } });
  assert.equal(connection.docCount, 0);
  assert.equal(timers.pendingCount, 0);

  timers.runPending();
  assert.deepEqual(sent, []);
});

test('closing a connection clears its store, its timers, and the wiring roster', (t) => {
  const { wiring, connection, timers, sent, lsp } = drivenConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  assert.equal(wiring.connectionCount, 1);

  connection.close();
  assert.equal(connection.isClosed, true);
  assert.equal(connection.docCount, 0);
  assert.equal(connection.pendingSweepCount, 0);
  assert.equal(timers.pendingCount, 0);
  assert.equal(wiring.connectionCount, 0);

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  timers.runPending();
  assert.deepEqual(sent, [], 'a closed connection accepts nothing further');
});

test('malformed frames are dropped with a log line, never a throw', (t) => {
  const { wiring, connection, warnings, sent, timers, lsp } = drivenConnection();
  t.after(() => wiring.stop());

  connection.handleFrame('not json at all');
  connection.handleFrame(JSON.stringify(['an', 'array']));
  connection.handleFrame(JSON.stringify({ type: 'something-else', method: 'textDocument/didOpen' }));
  connection.handleFrame(JSON.stringify({ type: 'lsp' }));
  connection.handleFrame(JSON.stringify({ type: 'lsp', method: 'textDocument/didChange', params: { textDocument: { uri: 'file:///never-opened.md', version: 2 } } }));
  assert.equal(warnings.length, 5, 'every drop is logged');
  assert.deepEqual(sent, []);

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  timers.runPending();
  assert.equal(sent.length, 1, 'the connection still works afterwards');
});

// --- Tab feed: the control-WS broadcast and the connect-time snapshot ---

test('a sweep that publishes also broadcasts the findings for that uri', (t) => {
  const { wiring, timers, broadcasts, sent, lsp } = drivenConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  assert.deepEqual(broadcasts, [], 'nothing before the quiet window');

  timers.runPending();
  assert.equal(broadcasts.length, 1);
  assert.deepEqual(Object.keys(broadcasts[0]).sort(), ['diagnostics', 'ts', 'type', 'uri']);
  assert.equal(broadcasts[0].type, 'navigator-findings');
  assert.equal(broadcasts[0].uri, MARKDOWN_URI);
  assert.equal(broadcasts[0].ts, FIXED_TS, 'the ts comes from the injected clock');
  assert.deepEqual(broadcasts[0].diagnostics, sent[0].params.diagnostics, 'the tab sees what the editor sees');
});

test('an edit that fixes the last finding broadcasts an empty array and drops the uri', (t) => {
  const { wiring, timers, broadcasts, lsp } = drivenConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  timers.runPending();
  assert.equal(wiring.findingsSnapshot().length, 1);

  lsp('textDocument/didChange', didChangeParams(MARKDOWN_URI, 2, CLEAN_MARKDOWN));
  timers.runPending();
  assert.equal(broadcasts.length, 2);
  assert.deepEqual(broadcasts[1], {
    type: 'navigator-findings', uri: MARKDOWN_URI, diagnostics: [], ts: FIXED_TS,
  });
  assert.deepEqual(wiring.findingsSnapshot(), [], 'a uri with no findings is absent, never stored empty');
});

test('didClose clears the uri and tells the tab to forget its section', (t) => {
  const { wiring, timers, broadcasts, lsp } = drivenConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  timers.runPending();

  lsp('textDocument/didClose', { textDocument: { uri: MARKDOWN_URI } });
  assert.equal(broadcasts.length, 2);
  assert.deepEqual(broadcasts[1], {
    type: 'navigator-findings', uri: MARKDOWN_URI, diagnostics: [], ts: FIXED_TS,
  });
  assert.deepEqual(wiring.findingsSnapshot(), []);
});

test('closing a document that never had findings says nothing at all', (t) => {
  const { wiring, timers, broadcasts, lsp } = drivenConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', CLEAN_MARKDOWN));
  timers.runPending();
  const afterSweep = broadcasts.length;

  lsp('textDocument/didClose', { textDocument: { uri: MARKDOWN_URI } });
  assert.equal(broadcasts.length, afterSweep, 'no section existed, so there is nothing to clear');
});

test('the snapshot accessor carries every uri that currently has findings', (t) => {
  const { wiring, timers, lsp } = drivenConnection();
  t.after(() => wiring.stop());

  const otherUri = 'file:///tmp/other.markdown';
  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  lsp('textDocument/didOpen', didOpenParams(otherUri, 'markdown', CLEAN_MARKDOWN));
  lsp('textDocument/didOpen', didOpenParams(SCRIPT_URI, 'javascript', 'const the the = 1;\n'));
  timers.runPending();

  const snapshot = wiring.findingsSnapshot();
  assert.deepEqual(snapshot.map((entry) => entry.uri), [MARKDOWN_URI], 'clean and non-markdown documents earn no entry');
  assert.deepEqual(snapshot[0].diagnostics.map((d) => d.code), ['repeated-word']);

  const message = wiring.snapshotMessage();
  assert.equal(message.type, 'navigator-snapshot');
  assert.equal(message.ts, FIXED_TS);
  assert.deepEqual(message.documents, snapshot);
});

// The relay replays its open buffers on reconnect (docs/plan-navigator.md, M1), so a dropped socket is a
// gap in the feed, not news that the carbon unit closed anything.
test('a relay disconnect keeps the findings the tab is showing', (t) => {
  const { wiring, connection, timers, broadcasts, lsp } = drivenConnection();
  t.after(() => wiring.stop());

  lsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  timers.runPending();
  const afterSweep = broadcasts.length;

  connection.close();
  assert.equal(connection.docCount, 0, 'the mirrored buffer is gone with the socket');
  assert.equal(broadcasts.length, afterSweep, 'but the tab is told nothing');
  assert.deepEqual(wiring.findingsSnapshot().map((entry) => entry.uri), [MARKDOWN_URI]);
});

test('a lane with no broadcast injected still sweeps and still tracks findings', (t) => {
  const timers = fakeTimers();
  const sent = [];
  const wiring = createNavigatorWiring({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    logger: { warn: () => {} },
  });
  t.after(() => wiring.stop());
  const connection = wiring.openConnection({ send: (message) => sent.push(message) });

  connection.handleFrame(JSON.stringify({
    type: 'lsp', method: 'textDocument/didOpen', params: didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN),
  }));
  timers.runPending();
  assert.equal(sent.length, 1);
  assert.deepEqual(wiring.findingsSnapshot().map((entry) => entry.uri), [MARKDOWN_URI]);
});

// --- Real backend boots ---

const booted = [];

function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function bootBackend(configPatch, { remotePort = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-navigator-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ projects: [], teams: [], repoRoots: [], ...configPatch }, null, 2), 'utf8');
  const previousEnv = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = configPath;

  const entry = { dir, backend: null, server: http.createServer(), remoteServer: null, port: null, remotePort };
  try {
    entry.backend = createBackend(entry.server, { staticDir: null });
  } finally {
    if (previousEnv == null) delete process.env.GLISSA_CONFIG;
    if (previousEnv != null) process.env.GLISSA_CONFIG = previousEnv;
  }
  booted.push(entry);
  entry.server.on('request', entry.backend.app);
  await new Promise((resolve) => entry.server.listen(0, '127.0.0.1', resolve));
  entry.port = entry.server.address().port;

  if (remotePort) {
    entry.remoteServer = http.createServer();
    entry.backend.remote.attach(entry.remoteServer);
    await new Promise((resolve) => entry.remoteServer.listen(remotePort, '127.0.0.1', resolve));
  }
  return entry;
}

test.after(async () => {
  for (const entry of booted) {
    entry.backend.shutdown();
    for (const server of [entry.server, entry.remoteServer]) {
      if (!server) continue;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(entry.dir, { recursive: true, force: true });
  }
});

function navigatorClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/navigator`);
  const frames = [];
  ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
  const opened = new Promise((resolve, reject) => {
    ws.on('open', () => resolve('open'));
    ws.on('error', reject);
  });
  return {
    ws,
    frames,
    opened,
    sendRaw: (raw) => ws.send(raw),
    sendLsp: (method, params) => ws.send(JSON.stringify({ type: 'lsp', method, params })),
    close: () => ws.close(),
  };
}

async function waitForDiagnostics(client, uri, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = client.frames.find((msg) => msg.type === 'publishDiagnostics'
      && msg.params.uri === uri
      && msg.params.diagnostics.length > 0);
    if (frame) return frame;
    await delay(25);
  }
  return null;
}

/**
 * Asks the SERVER what it did with a socket rather than inferring it from the client side (the trick
 * tests/backend-remote-enabled.test.js uses): a second 'upgrade' listener runs right after the
 * backend's, so socket.destroyed says whether the backend closed it or left it for another listener.
 * Destroying it here is also what keeps an accepted upgrade from leaking a detached handle.
 */
function backendDestroyedUpgrade(server, port, requestPath) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no upgrade event for ${requestPath}`)), 5000);
    let client = null;
    server.once('upgrade', (_req, socket) => {
      clearTimeout(timer);
      const destroyedByBackend = socket.destroyed;
      socket.destroy();
      if (client) client.destroy();
      resolve(destroyedByBackend);
    });
    client = net.connect(port, '127.0.0.1', () => {
      client.write([
        `GET ${requestPath} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        '', '',
      ].join('\r\n'));
    });
    client.on('error', () => { /* the server end closing is the expected outcome */ });
  });
}

test('an enabled lane serves /navigator on the local listener and publishes markdown diagnostics', async (t) => {
  const { port } = await bootBackend({ navigator: { enabled: true } });
  const client = navigatorClient(port);
  t.after(() => client.close());
  assert.equal(await client.opened, 'open');

  client.sendLsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', CLEAN_MARKDOWN));
  client.sendLsp('textDocument/didChange', didChangeParams(MARKDOWN_URI, 2, REPEATED_WORD_MARKDOWN));

  const frame = await waitForDiagnostics(client, MARKDOWN_URI);
  assert.ok(frame, 'a publishDiagnostics frame arrives on the same socket');
  assert.deepEqual(frame.params.diagnostics.map((d) => d.code), ['repeated-word']);
  assert.equal(frame.params.diagnostics[0].source, 'glissa-navigator');
  assert.equal(frame.params.diagnostics[0].range.start.line, 2);
});

test('a non-markdown document over the same socket yields no diagnostics, and a garbage frame kills nothing', async (t) => {
  const { port } = await bootBackend({ navigator: { enabled: true } });
  const client = navigatorClient(port);
  t.after(() => client.close());
  assert.equal(await client.opened, 'open');

  client.sendRaw('this is not a frame');
  client.sendLsp('textDocument/didOpen', didOpenParams(SCRIPT_URI, 'javascript', 'const the the = 1;\n'));
  client.sendLsp('textDocument/didChange', didChangeParams(SCRIPT_URI, 2, 'const the the = 2;\n'));
  await delay(NAVIGATOR_DEBOUNCE_MS * 4);
  assert.deepEqual(client.frames, [], 'v1 says nothing about code buffers');

  client.sendLsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  assert.ok(await waitForDiagnostics(client, MARKDOWN_URI), 'the connection survived the malformed frame');
});

test('a default config leaves /navigator exactly where an unowned path is left', async () => {
  const { server, port } = await bootBackend({});
  assert.equal(
    await backendDestroyedUpgrade(server, port, '/navigator'), false,
    'untouched on the local listener, so Vite HMR can still claim it',
  );
  assert.equal(
    await backendDestroyedUpgrade(server, port, '/some-other-app'), false,
    'byte-for-byte the unknown-path behavior',
  );
});

test('a config with navigator present but not enabled stays inert', async () => {
  const { server, port } = await bootBackend({ navigator: { enabled: false } });
  assert.equal(await backendDestroyedUpgrade(server, port, '/navigator'), false);
});

test('/navigator is refused on the remote listener even with the lane enabled', async () => {
  const remotePort = await reserveFreePort();
  const { server, port, remoteServer } = await bootBackend({
    navigator: { enabled: true },
    remote: { enabled: true, port: remotePort, publicHost: 'glissa.test', allowedOrigins: ['https://glissa.test'] },
  }, { remotePort });

  assert.equal(
    await backendDestroyedUpgrade(remoteServer, remotePort, '/navigator'), true,
    'buffer text never crosses the remote boundary in v1',
  );
  assert.equal(
    await backendDestroyedUpgrade(server, port, '/navigator'), false,
    'the same lane is served on the local listener',
  );
});

// The remote-mode precedent (tests/control-settings-remote.test.js): a control-WS-settable navigator
// block would let any local process point the lane at buffers, so it is config-file only.
test('navigator is in none of the settable key lists and is never echoed by getSettings', () => {
  assert.equal(BOOLEAN_KEYS.includes('navigator'), false);
  assert.equal(STRING_KEYS.includes('navigator'), false);
  assert.equal(TIMEOUT_KEYS.includes('navigator'), false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-navigator-settings-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ projects: [], teams: [], navigator: { enabled: true } }, null, 2), 'utf8');
  const previousEnv = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = configPath;
  try {
    const store = createConfigStore();
    assert.equal('navigator' in store.getSettings(), false);
    store.applySettings({ projects: [], navigator: { enabled: false } });
    assert.deepEqual(store.config.navigator, { enabled: true }, 'applySettings never reads it');
  } finally {
    if (previousEnv == null) delete process.env.GLISSA_CONFIG;
    if (previousEnv != null) process.env.GLISSA_CONFIG = previousEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
