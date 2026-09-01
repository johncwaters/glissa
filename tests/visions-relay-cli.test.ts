import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { createParserState, feedFrameBytes, serializeFrame } from '../server/core/visions-lsp-core.ts';
import type { AddressInfo } from 'node:net';

type LspRecord = Record<string, unknown>;
const CLI_PATH = path.join(import.meta.dirname, '..', 'bin', 'glissa.ts');
const WAIT_MS = 8000;
const URI = 'file:///tmp/cli-plan.md';

test('glissa visions relay speaks LSP on stdio and mirrors to the daemon', async (t) => {
  const server = new WebSocketServer({ port: 0, path: '/visions' });
  await once(server, 'listening');

  const mirrored = new Promise<LspRecord>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no didOpen reached the daemon')), WAIT_MS);
    server.on('connection', (connection) => {
      connection.on('message', (data) => {
        const message = JSON.parse(data.toString('utf8')) as LspRecord;
        if (message.type !== 'lsp' || message.method !== 'textDocument/didOpen') return;
        clearTimeout(timer);
        resolve(message);
      });
    });
  });

  const child = spawn(process.execPath, [CLI_PATH, 'visions', 'relay', '--port', String((server.address() as AddressInfo).port)]);
  t.after(async () => {
    child.kill();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  let parserState = createParserState();
  const initialized = new Promise<LspRecord>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no initialize answer on stdout')), WAIT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      const parsed = feedFrameBytes(parserState, Buffer.from(chunk));
      parserState = parsed.state;
      for (const message of parsed.messages as LspRecord[]) {
        if (message.id !== 1) continue;
        clearTimeout(timer);
        resolve(message);
      }
    });
  });

  child.stdin?.write(serializeFrame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { processId: process.pid, rootUri: null, capabilities: {} } }));
  const answer = await initialized;
  const result = answer.result as { serverInfo: LspRecord; capabilities: LspRecord };
  assert.equal(result.serverInfo.name, 'glissa-visions');
  assert.equal(result.capabilities.codeActionProvider, true);

  child.stdin?.write(serializeFrame({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: URI, languageId: 'markdown', version: 1, text: '# Plan\n' } },
  }));
  const message = await mirrored;
  const params = message.params as { textDocument: LspRecord };
  assert.equal(params.textDocument.uri, URI);
});
