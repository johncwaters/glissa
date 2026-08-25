'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_DAEMON_FRAME_BYTES,
  decideDaemonFrame,
  decideMirrorSync,
  planMirrorReplay,
} = require('../session/core/visions-relay-core');

function mirroredDocument(text) {
  return {
    uri: 'file:///large.md',
    languageId: 'markdown',
    version: 1,
    text,
  };
}

test('replay excludes a mirrored document whose didOpen frame exceeds the daemon cap', () => {
  const oversized = mirroredDocument('x'.repeat(MAX_DAEMON_FRAME_BYTES));
  const replay = planMirrorReplay([oversized]);

  assert.deepEqual(replay.frames, []);
  assert.equal(replay.skipped.length, 1);
  assert.equal(replay.skipped[0].uri, oversized.uri);
  assert.ok(replay.skipped[0].frameBytes > MAX_DAEMON_FRAME_BYTES);
});

test('daemon frame decisions count the exact serialized UTF-8 bytes', () => {
  const payload = { type: 'lsp', value: 'é' };
  const exactBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');

  assert.equal(decideDaemonFrame(payload, exactBytes).send, true);
  assert.equal(decideDaemonFrame(payload, exactBytes - 1).send, false);
});

test('a refused mirror frame closes the daemon document and marks the URI unsynced', () => {
  assert.deepEqual(decideMirrorSync({
    method: 'textDocument/didChange',
    isUnsynced: false,
    originalFrameFits: false,
    fullFrameFits: false,
  }), {
    actions: ['close'],
    forgetUnsynced: false,
    markUnsynced: true,
    shouldLog: true,
  });
});

test('an unsynced URI suppresses changes until a full didOpen fits', () => {
  assert.deepEqual(decideMirrorSync({
    method: 'textDocument/didChange',
    isUnsynced: true,
    originalFrameFits: true,
    fullFrameFits: false,
  }), {
    actions: [],
    forgetUnsynced: false,
    markUnsynced: false,
    shouldLog: false,
  });

  assert.deepEqual(decideMirrorSync({
    method: 'textDocument/didChange',
    isUnsynced: true,
    originalFrameFits: true,
    fullFrameFits: true,
  }), {
    actions: ['full-open'],
    forgetUnsynced: false,
    markUnsynced: false,
    shouldLog: false,
  });
});
