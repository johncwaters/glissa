import test from 'node:test';
import assert from 'node:assert/strict';

import { buildWebSocketUrl, webSocketProtocolFor } from '../public/ws-url-core.ts';

test('webSocketProtocolFor: upgrades https pages to wss', () => {
  assert.equal(webSocketProtocolFor('https:'), 'wss:');
});

test('webSocketProtocolFor: keeps non-https pages on ws', () => {
  assert.equal(webSocketProtocolFor('http:'), 'ws:');
  assert.equal(webSocketProtocolFor('file:'), 'ws:');
  assert.equal(webSocketProtocolFor(undefined), 'ws:');
});

test('buildWebSocketUrl: preserves host and path', () => {
  assert.equal(
    buildWebSocketUrl({ protocol: 'https:', host: 'example.test:3000' }, '/control?since=7'),
    'wss://example.test:3000/control?since=7',
  );
  assert.equal(
    buildWebSocketUrl({ protocol: 'http:', host: 'localhost:5173' }, '/terminals/a%20b'),
    'ws://localhost:5173/terminals/a%20b',
  );
});
