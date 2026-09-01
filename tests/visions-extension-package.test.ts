import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';

import vscode from './helpers/vscode-stub.ts';
import { packVsix } from '../server/visions-setup.ts';

const WAIT_MS = 8000;

const requireFromHere = createRequire(import.meta.url);

type ModuleLoad = (request: string, ...rest: unknown[]) => unknown;
interface LoaderInternals {
  _load: ModuleLoad;
}

interface PackedExtension {
  activate(context: { subscriptions: { dispose?: () => void }[] }): void;
}

interface DidOpenMessage {
  type: string;
  method: string;
  params: { textDocument: { uri: string } };
}

const loader: LoaderInternals = requireFromHere('node:module');
const originalLoad = loader._load;
loader._load = function loadWithVscodeStub(this: unknown, request: string, ...rest: unknown[]): unknown {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, ...rest);
};

function unpack(vsix: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-vsix-'));
  const archive = path.join(dir, 'extension.vsix');
  fs.writeFileSync(archive, vsix);
  execFileSync('unzip', ['-o', '-q', archive, '-d', dir]);
  return path.join(dir, 'extension');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readJson(filePath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!isRecord(parsed)) throw new Error(`${filePath} is not a JSON object`);
  return parsed;
}

function isDidOpen(value: unknown): value is DidOpenMessage {
  if (!isRecord(value)) return false;
  if (value.type !== 'lsp' || value.method !== 'textDocument/didOpen') return false;
  if (!isRecord(value.params) || !isRecord(value.params.textDocument)) return false;
  return typeof value.params.textDocument.uri === 'string';
}

test('the extension sources stay CommonJS-shaped, since the dev-mode packer only strips types', () => {
  const sourceDir = path.join(import.meta.dirname, '..', 'tools', 'vscode-visions');
  for (const name of ['extension.ts', 'lsp-convert.ts']) {
    const source = fs.readFileSync(path.join(sourceDir, name), 'utf8');
    assert.match(source, /^module\.exports = \{/m, `${name} must export via module.exports for the extension host`);
    assert.doesNotMatch(source, /^export /m, `${name} must not use ESM exports`);
  }
});

test('the packed extension carries every file it requires and the stamped relay path', async (t) => {
  const { manifest, vsix } = packVsix();
  const extensionDir = unpack(vsix);
  t.after(() => fs.rmSync(path.dirname(extensionDir), { recursive: true, force: true }));

  assert.equal(readJson(path.join(extensionDir, 'package.json')).version, manifest.version);
  const stamped = readJson(path.join(extensionDir, 'relay-path.json')).relayPath;
  assert.equal(stamped, path.join(import.meta.dirname, '..', 'session', 'visions-relay.ts'));
  assert.equal(typeof stamped, 'string');
  assert.ok(fs.existsSync(String(stamped)), 'the stamped relay path points at a file that exists');

  const server = new WebSocketServer({ port: 0, path: '/visions' });
  await once(server, 'listening');
  const opened = new Promise<DidOpenMessage>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no didOpen reached the daemon')), WAIT_MS);
    server.on('connection', (connection) => {
      connection.on('message', (data: Buffer) => {
        const message: unknown = JSON.parse(data.toString('utf8'));
        if (!isDidOpen(message)) return;
        clearTimeout(timer);
        resolve(message);
      });
    });
  });

  const address = server.address();
  if (typeof address === 'string') throw new Error('the fake daemon bound a pipe, not a port');
  const { port }: AddressInfo = address;

  vscode.__test.reset();
  vscode.__test.state.settings = { relayPath: '', port };
  const context: { subscriptions: { dispose?: () => void }[] } = { subscriptions: [] };
  const packed: PackedExtension = requireFromHere(path.join(extensionDir, 'extension.js'));
  packed.activate(context);
  t.after(async () => {
    for (const subscription of context.subscriptions) subscription.dispose?.();
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  });

  vscode.__test.fire('open', vscode.__test.document({ uri: 'file:///tmp/packed.md', text: '# Packed\n' }));
  const message = await opened;
  assert.equal(message.params.textDocument.uri, 'file:///tmp/packed.md');
  assert.deepEqual(vscode.__test.state.errors, []);
});
