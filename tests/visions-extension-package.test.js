'use strict';

// The packed extension is what an operator actually runs: it lives outside this package, so every file
// it requires has to be inside the vsix and the relay path has to be stamped. This test unpacks the
// real archive and boots that copy against a fake daemon.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');

const vscode = require('./helpers/vscode-stub');
const { packVsix } = require('../server/visions-setup');

const STUB_PATH = require.resolve('./helpers/vscode-stub');
const WAIT_MS = 8000;

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolveWithVscodeStub(request, ...rest) {
  if (request === 'vscode') return STUB_PATH;
  return originalResolve.call(this, request, ...rest);
};

function unpack(vsix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-vsix-'));
  const archive = path.join(dir, 'extension.vsix');
  fs.writeFileSync(archive, vsix);
  execFileSync('unzip', ['-o', '-q', archive, '-d', dir]);
  return path.join(dir, 'extension');
}

test('the packed extension carries every file it requires and the stamped relay path', async (t) => {
  const { manifest, vsix } = packVsix();
  const extensionDir = unpack(vsix);
  t.after(() => fs.rmSync(path.dirname(extensionDir), { recursive: true, force: true }));

  assert.equal(JSON.parse(fs.readFileSync(path.join(extensionDir, 'package.json'), 'utf8')).version, manifest.version);
  const stamped = JSON.parse(fs.readFileSync(path.join(extensionDir, 'relay-path.json'), 'utf8')).relayPath;
  assert.equal(stamped, path.join(__dirname, '..', 'session', 'visions-relay.ts'));
  assert.ok(fs.existsSync(stamped), 'the stamped relay path points at a file that exists');

  const server = new WebSocketServer({ port: 0, path: '/visions' });
  await once(server, 'listening');
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no didOpen reached the daemon')), WAIT_MS);
    server.on('connection', (connection) => {
      connection.on('message', (data) => {
        const message = JSON.parse(data.toString('utf8'));
        if (message.type !== 'lsp' || message.method !== 'textDocument/didOpen') return;
        clearTimeout(timer);
        resolve(message);
      });
    });
  });

  vscode.__test.reset();
  vscode.__test.state.settings = { relayPath: '', port: server.address().port };
  const context = { subscriptions: [] };
  const packed = require(path.join(extensionDir, 'extension.js'));
  packed.activate(context);
  t.after(async () => {
    for (const subscription of context.subscriptions) subscription.dispose?.();
    await new Promise((resolve) => server.close(resolve));
  });

  vscode.__test.fire('open', vscode.__test.document({ uri: 'file:///tmp/packed.md', text: '# Packed\n' }));
  const message = await opened;
  assert.equal(message.params.textDocument.uri, 'file:///tmp/packed.md');
  assert.deepEqual(vscode.__test.state.errors, []);
});
