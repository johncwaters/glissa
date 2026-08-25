'use strict';

// The hook relay (M2 of docs/plan-agent-adapters.md): the standalone process a non-Claude agent CLI
// runs as a command hook. Its contract is narrow and every clause is security-relevant, so the pure
// decisions are tested exhaustively and main() is driven against a real loopback listener with a fake
// stdin: the payload must arrive byte-identical on the existing route shape, and every refusal must
// still exit 0 without a socket.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable } = require('node:stream');

const { main } = require('../session/hook-relay');
const {
  HOOK_URL_ENV,
  MAX_PAYLOAD_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_ADDITIONAL_CONTEXT_CHARS,
  readHookUrl,
  normalizeEvent,
  resolveHookTarget,
  decideRelayPost,
  decideHookStdout,
} = require('../session/core/hook-relay-core');

const BASE = 'http://127.0.0.1:41234/hook/sess-1?t=deadbeef';

function fakeStdin(text) {
  return Readable.from([Buffer.from(text, 'utf8')]);
}

function startIngress({ status = 200, responseBody = JSON.stringify({ ok: true, reason: 'ok' }) } = {}) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, body, contentType: req.headers['content-type'] });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(responseBody);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, received, port: server.address().port }));
  });
}

function captureStdout() {
  let output = '';
  return {
    stream: { write: (chunk) => { output += String(chunk); return true; } },
    read: () => output,
  };
}

async function relayResponse({ event = 'UserPromptSubmit', status = 200, responseBody }, hookStdoutDecision) {
  const { server, port } = await startIngress({ status, responseBody });
  const stdout = captureStdout();
  try {
    const result = await main([event], fakeStdin('{}'), {
      [HOOK_URL_ENV]: `http://127.0.0.1:${port}/hook/s?t=t`,
    }, stdout.stream, hookStdoutDecision);
    return { result, output: stdout.read() };
  } finally {
    server.close();
  }
}

test('readHookUrl reads only the spawn-env variable, trimmed, and nothing else', () => {
  assert.equal(HOOK_URL_ENV, 'GLISSA_HOOK_URL');
  assert.equal(readHookUrl({ [HOOK_URL_ENV]: `  ${BASE}  ` }), BASE);
  assert.equal(readHookUrl({}), null);
  assert.equal(readHookUrl({ [HOOK_URL_ENV]: '   ' }), null);
  assert.equal(readHookUrl({ [HOOK_URL_ENV]: 7 }), null);
  assert.equal(readHookUrl(null), null);
});

test('normalizeEvent lowercases the argv token and refuses anything that is not one', () => {
  assert.equal(normalizeEvent('Stop'), 'stop');
  assert.equal(normalizeEvent(' UserPromptSubmit '), 'userpromptsubmit');
  assert.equal(normalizeEvent('Pre_Tool-Use'), 'pre_tool-use');
  // A path segment, a query, or a traversal would repoint the POST at another route.
  assert.equal(normalizeEvent('stop/../upload'), null);
  assert.equal(normalizeEvent('stop?t=x'), null);
  assert.equal(normalizeEvent('..'), null);
  assert.equal(normalizeEvent('1stop'), null);
  assert.equal(normalizeEvent(''), null);
  assert.equal(normalizeEvent(undefined), null);
});

test('resolveHookTarget appends the event segment and keeps the token query', () => {
  assert.equal(resolveHookTarget(BASE, 'stop').url, 'http://127.0.0.1:41234/hook/sess-1/stop?t=deadbeef');
  assert.equal(resolveHookTarget('http://localhost:3000/hook/s/', 'stop').url, 'http://localhost:3000/hook/s/stop');
});

test('resolveHookTarget refuses every target that is not the local hook ingress', () => {
  assert.deepEqual(resolveHookTarget('https://127.0.0.1/hook/s', 'stop'), { url: null, reason: 'not-http' });
  assert.deepEqual(resolveHookTarget('http://10.0.0.5/hook/s', 'stop'), { url: null, reason: 'not-loopback' });
  assert.deepEqual(resolveHookTarget('http://evil.example.com/hook/s', 'stop'), { url: null, reason: 'not-loopback' });
  assert.deepEqual(resolveHookTarget('http://127.0.0.1:41234/upload/s', 'stop'), { url: null, reason: 'not-hook-path' });
  assert.deepEqual(resolveHookTarget('not a url', 'stop'), { url: null, reason: 'bad-url' });
});

test('decideRelayPost: the whole verdict, refusal by refusal', () => {
  const env = { [HOOK_URL_ENV]: BASE };
  assert.deepEqual(decideRelayPost({ env, event: 'Stop', payloadBytes: 12 }), {
    post: true, url: 'http://127.0.0.1:41234/hook/sess-1/stop?t=deadbeef', reason: 'ok',
  });
  // No variable in the env is the INERT case: an installed hooks file must do nothing outside Glissa.
  assert.deepEqual(decideRelayPost({ env: {}, event: 'Stop' }), { post: false, url: null, reason: 'no-hook-url' });
  assert.equal(decideRelayPost({ env, event: 'sto p' }).reason, 'bad-event');
  assert.equal(decideRelayPost({ env, event: 'Stop', payloadBytes: MAX_PAYLOAD_BYTES }).post, true);
  assert.equal(decideRelayPost({ env, event: 'Stop', payloadBytes: MAX_PAYLOAD_BYTES + 1 }).reason, 'payload-too-large');
  assert.equal(decideRelayPost({ env, event: 'Stop', payloadBytes: -1 }).reason, 'bad-payload');
  assert.equal(decideRelayPost({ env: { [HOOK_URL_ENV]: 'http://8.8.8.8/hook/s' }, event: 'Stop' }).reason, 'not-loopback');
  assert.equal(decideRelayPost().reason, 'no-hook-url');
});

test('decideHookStdout returns only the validated UserPromptSubmit injection object', () => {
  const responseBody = JSON.stringify({
    ok: true,
    reason: 'ok',
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Read the updated pack.' },
    ignored: 'not forwarded',
  });
  assert.equal(decideHookStdout('UserPromptSubmit', 200, responseBody), JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Read the updated pack.' },
  }));
  assert.equal(decideHookStdout('Stop', 200, responseBody), null);
  assert.equal(decideHookStdout('UserPromptSubmit', 403, responseBody), null);
  assert.equal(decideHookStdout('UserPromptSubmit', 200, '{bad json'), null);
  assert.equal(decideHookStdout('UserPromptSubmit', 200, JSON.stringify({
    hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'x' },
  })), null);
  assert.equal(decideHookStdout('UserPromptSubmit', 200, JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 7 },
  })), null);
  assert.equal(decideHookStdout('UserPromptSubmit', 200, JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: 'x'.repeat(MAX_ADDITIONAL_CONTEXT_CHARS + 1),
    },
  })), null);
  assert.equal(decideHookStdout('UserPromptSubmit', 200, 'x'.repeat(MAX_RESPONSE_BYTES + 1)), null);
});

test('relay stdout is silent except for an accepted bounded UserPromptSubmit context', async () => {
  const acceptedBody = JSON.stringify({
    ok: true,
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Pack alpha changed.' },
  });
  const accepted = await relayResponse({ responseBody: acceptedBody });
  assert.equal(accepted.result.code, 0);
  assert.equal(accepted.output, `${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Pack alpha changed.' },
  })}\n`);

  const silentCases = [
    { event: 'Stop', responseBody: acceptedBody },
    { status: 403, responseBody: acceptedBody },
    { responseBody: '{bad json' },
    { responseBody: JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } }) },
    { responseBody: 'x'.repeat(MAX_RESPONSE_BYTES + 1), reason: 'response-too-large' },
  ];
  for (const silentCase of silentCases) {
    const response = await relayResponse(silentCase);
    assert.equal(response.result.code, 0);
    assert.equal(response.output, '');
    if (silentCase.reason) assert.equal(response.result.reason, silentCase.reason);
  }
});

test('an oversized response reaches decideHookStdout with only the overflow sentinel', async () => {
  let decisionInput = null;
  const response = await relayResponse({
    responseBody: 'x'.repeat(MAX_RESPONSE_BYTES + 1),
  }, (event, status, body) => {
    decisionInput = { event, status, body };
    return null;
  });
  assert.equal(response.result.reason, 'response-too-large');
  assert.deepEqual(decisionInput, { event: 'UserPromptSubmit', status: 200, body: null });
});

test('the relay POSTs the stdin bytes untouched to /hook/:glissaId/:event', async () => {
  const { server, received, port } = await startIngress();
  try {
    // camelCase and a vendor-only field: the relay must not translate, reshape or validate any of it.
    const payload = '{"sessionId":"abc","backgroundTasks":[],"toolInput":{"file_path":"C:\\\\x"}}';
    const result = await main(['Stop'], fakeStdin(payload), {
      [HOOK_URL_ENV]: `http://127.0.0.1:${port}/hook/sess-42?t=tok123`,
    });
    assert.equal(result.code, 0);
    assert.equal(result.reason, 'status-200');
    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'POST');
    assert.equal(received[0].url, '/hook/sess-42/stop?t=tok123');
    assert.equal(received[0].contentType, 'application/json');
    assert.equal(received[0].body, payload);
  } finally {
    server.close();
  }
});

test('a refused target posts nothing and still exits 0', async () => {
  const { server, received, port } = await startIngress();
  try {
    for (const [argv, env] of [
      [['Stop'], {}],
      [[], { [HOOK_URL_ENV]: `http://127.0.0.1:${port}/hook/s?t=t` }],
      [['Stop'], { [HOOK_URL_ENV]: `http://127.0.0.1:${port}/upload/s?t=t` }],
      [['Stop'], { [HOOK_URL_ENV]: 'https://example.com/hook/s?t=t' }],
    ]) {
      const result = await main(argv, fakeStdin('{}'), env);
      assert.equal(result.code, 0);
    }
    assert.equal(received.length, 0);
  } finally {
    server.close();
  }
});

test('an oversize payload is dropped locally rather than cut off mid-JSON by the ingress', async () => {
  const { server, received, port } = await startIngress();
  try {
    const huge = `{"pad":"${'x'.repeat(MAX_PAYLOAD_BYTES)}"}`;
    const result = await main(['Stop'], fakeStdin(huge), { [HOOK_URL_ENV]: `http://127.0.0.1:${port}/hook/s?t=t` });
    assert.equal(result.code, 0);
    assert.equal(result.reason, 'payload-too-large');
    assert.equal(received.length, 0);
  } finally {
    server.close();
  }
});

// The "Glissa is down" case: a hook must never fail the turn it was called from.
test('nothing listening still exits 0', async () => {
  const result = await main(['Stop'], fakeStdin('{}'), { [HOOK_URL_ENV]: 'http://127.0.0.1:1/hook/s?t=t' });
  assert.equal(result.code, 0);
});
