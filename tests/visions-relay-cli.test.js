'use strict';

// Every non-VS-Code editor spawns `glissa visions relay`; stdout must reach the client untouched.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');

const { createParserState, feedFrameBytes, serializeFrame } = require('../server/core/visions-lsp-core');

const CLI_PATH = path.join(__dirname, '..', 'bin', 'glissa.js');
const WAIT_MS = 8000;
const URI = 'file:///tmp/cli-plan.md';

test('glissa visions relay speaks LSP on stdio and mirrors to the daemon', async (t) => {
  const server = new WebSocketServer({ port: 0, path: '/visions' });
  await once(server, 'listening');

  const mirrored = new Promise((resolve, reject) => {
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

  const child = spawn(process.execPath, [CLI_PATH, 'visions', 'relay', '--port', String(server.address().port)]);
  t.after(async () => {
    child.kill();
    await new Promise((resolve) => server.close(resolve));
  });

  let parserState = createParserState();
  const initialized = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no initialize answer on stdout')), WAIT_MS);
    child.stdout.on('data', (chunk) => {
      const parsed = feedFrameBytes(parserState, Buffer.from(chunk));
      parserState = parsed.state;
      for (const message of parsed.messages) {
        if (message.id !== 1) continue;
        clearTimeout(timer);
        resolve(message);
      }
    });
  });

  child.stdin.write(serializeFrame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { processId: process.pid, rootUri: null, capabilities: {} } }));
  const answer = await initialized;
  assert.equal(answer.result.serverInfo.name, 'glissa-visions');
  assert.equal(answer.result.capabilities.codeActionProvider, true);

  child.stdin.write(serializeFrame({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: URI, languageId: 'markdown', version: 1, text: '# Plan\n' } },
  }));
  const message = await mirrored;
  assert.equal(message.params.textDocument.uri, URI);
});
