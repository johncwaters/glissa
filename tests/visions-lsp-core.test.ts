import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyMessage,
  createParserState,
  feedFrameBytes,
  serializeFrame,
} from '../server/core/visions-lsp-core.ts';
import type { LspMessage, LspParserState } from '../server/core/visions-lsp-core.ts';

function feedAll(chunks: Buffer[], startState: LspParserState | null = null) {
  let state = startState || createParserState();
  const messages: LspMessage[] = [];
  for (const chunk of chunks) {
    const frame = feedFrameBytes(state, chunk);
    state = frame.state;
    messages.push(...frame.messages);
  }
  return { state, messages };
}

test('serializeFrame writes byte counted Content-Length frames', () => {
  const message = { jsonrpc: '2.0', method: 'textDocument/didOpen', params: { text: 'snowman \u2603' } };
  const frame = serializeFrame(message);
  const [header, body] = frame.toString('utf8').split('\r\n\r\n');
  assert.equal(header, `Content-Length: ${Buffer.byteLength(body, 'utf8')}`);
  assert.deepEqual(JSON.parse(body), message);
});

test('feedFrameBytes handles a header split across every byte boundary', () => {
  const message = { jsonrpc: '2.0', method: 'initialized', params: {} };
  const frame = serializeFrame(message);
  for (let splitAt = 1; splitAt < frame.length; splitAt++) {
    const { messages } = feedAll([frame.subarray(0, splitAt), frame.subarray(splitAt)]);
    assert.deepEqual(messages, [message], `split at ${splitAt}`);
  }
});

test('feedFrameBytes handles a body split across every byte boundary', () => {
  const message = { jsonrpc: '2.0', id: 7, result: { text: 'rocket \ud83d\ude80' } };
  const frame = serializeFrame(message);
  const bodyStartsAt = frame.indexOf('\r\n\r\n') + 4;
  for (let splitAt = bodyStartsAt + 1; splitAt < frame.length; splitAt++) {
    const { messages } = feedAll([frame.subarray(0, splitAt), frame.subarray(splitAt)]);
    assert.deepEqual(messages, [message], `split at ${splitAt}`);
  }
});

test('feedFrameBytes handles multiple complete frames in one chunk', () => {
  const first = { jsonrpc: '2.0', method: 'one' };
  const second = { jsonrpc: '2.0', method: 'two' };
  const { messages } = feedAll([Buffer.concat([serializeFrame(first), serializeFrame(second)])]);
  assert.deepEqual(messages, [first, second]);
});

test('feedFrameBytes handles optional Content-Type and interleaved frames', () => {
  const first = { jsonrpc: '2.0', method: 'first', params: { text: 'cafe \u00e9' } };
  const body = Buffer.from(JSON.stringify(first), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n`);
  const second = { jsonrpc: '2.0', id: 2, result: true };
  const combined = Buffer.concat([header, body, serializeFrame(second)]);
  const { messages } = feedAll([
    combined.subarray(0, 5),
    combined.subarray(5, header.length + 2),
    combined.subarray(header.length + 2, header.length + body.length - 1),
    combined.subarray(header.length + body.length - 1),
  ]);
  assert.deepEqual(messages, [first, second]);
});

test('feedFrameBytes reports malformed JSON and recovers for the next frame', () => {
  const malformed = Buffer.from('Content-Length: 6\r\n\r\n{"x":}');
  const next = { jsonrpc: '2.0', method: 'next' };
  const { messages } = feedAll([Buffer.concat([malformed, serializeFrame(next)])]);
  assert.deepEqual(messages, [{ parseError: true, raw: '{"x":}' }, next]);
});

/*
 * A headerless block is unframeable and an editor's own LSP client never sends one, so the buffered
 * bytes are dropped rather than scanned for a header that might follow them.
 */
test('feedFrameBytes reports a missing Content-Length and drops what it cannot frame', () => {
  const next = { jsonrpc: '2.0', method: 'next' };
  const badHeader = Buffer.from('Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n');
  const { state, messages } = feedAll([Buffer.concat([badHeader, Buffer.from('discard me\n'), serializeFrame(next)])]);
  assert.deepEqual(messages, [
    {
      parseError: true,
      reason: 'missing-content-length',
      raw: 'Content-Type: application/vscode-jsonrpc; charset=utf-8',
    },
  ]);
  assert.equal(state.buffer.length, 0);

  // The stream reads cleanly again from the next well-formed frame.
  assert.deepEqual(feedAll([serializeFrame(next)], state).messages, [next]);
});

test('classifyMessage separates requests notifications responses and invalid messages', () => {
  assert.deepEqual(classifyMessage({ method: 'm', id: 1 }), { kind: 'request', method: 'm', id: 1 });
  assert.deepEqual(classifyMessage({ method: 'm' }), { kind: 'notification', method: 'm', id: undefined });
  assert.deepEqual(classifyMessage({ id: 1, result: null }), { kind: 'response', method: undefined, id: 1 });
  assert.deepEqual(classifyMessage({ result: null }), { kind: 'invalid', method: undefined, id: undefined });
});
