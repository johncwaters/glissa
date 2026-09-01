'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const importCore = () => import('../public/ws-url-core.ts');

test('webSocketProtocolFor: upgrades https pages to wss', async () => {
  const { webSocketProtocolFor } = await importCore();
  assert.equal(webSocketProtocolFor('https:'), 'wss:');
});

test('webSocketProtocolFor: keeps non-https pages on ws', async () => {
  const { webSocketProtocolFor } = await importCore();
  assert.equal(webSocketProtocolFor('http:'), 'ws:');
  assert.equal(webSocketProtocolFor('file:'), 'ws:');
  assert.equal(webSocketProtocolFor(undefined), 'ws:');
});

test('buildWebSocketUrl: preserves host and path', async () => {
  const { buildWebSocketUrl } = await importCore();
  assert.equal(
    buildWebSocketUrl({ protocol: 'https:', host: 'example.test:3000' }, '/control?since=7'),
    'wss://example.test:3000/control?since=7',
  );
  assert.equal(
    buildWebSocketUrl({ protocol: 'http:', host: 'localhost:5173' }, '/terminals/a%20b'),
    'ws://localhost:5173/terminals/a%20b',
  );
});
