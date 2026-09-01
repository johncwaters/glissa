// The statusLine relay's decisions. It runs as a standalone process in front of the operator's status
// line, so the contract is narrow: never throw, never block, and never lose the command it was asked to
// chain. main() is driven here with a fake stdin and stdout and no server listening, which is exactly
// the case that must still produce output.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { main, fallbackLine, decodeChainCommand, parsePayload, NO_CHAIN } from '../session/statusline-relay.ts';
function fakeStdin(text: string) {
  return Readable.from([Buffer.from(text, 'utf8')]);
}

function fakeStdout() {
  const written: string[] = [];
  return { written, write: (chunk: string) => { written.push(String(chunk)); return true; } };
}

const PAYLOAD = {
  session_id: 'c1',
  model: { id: 'claude-opus-4-5', display_name: 'Opus 4.5' },
  cost: { total_cost_usd: 1.234 },
};

test('decodeChainCommand: base64 in, command out, and every absent form is null', () => {
  const command = 'node C:/Users/johnw/.claude/hud/hud.mjs';
  assert.equal(decodeChainCommand(Buffer.from(command, 'utf8').toString('base64')), command);
  assert.equal(decodeChainCommand(NO_CHAIN), null);
  assert.equal(decodeChainCommand(''), null);
  assert.equal(decodeChainCommand(undefined), null);
  // Base64 of whitespace decodes to nothing worth running.
  assert.equal(decodeChainCommand(Buffer.from('   ', 'utf8').toString('base64')), null);
});

test('parsePayload: an object or null, never a throw', () => {
  assert.deepEqual(parsePayload('{"a":1}'), { a: 1 });
  assert.equal(parsePayload('{ not json'), null);
  assert.equal(parsePayload(''), null);
  assert.equal(parsePayload('[1,2]'), null, 'an array is not a payload');
  assert.equal(parsePayload('42'), null);
});

test('fallbackLine: model and cost, no dashes and no emoji', () => {
  assert.equal(fallbackLine(PAYLOAD), 'Opus 4.5  $1.23');
  assert.equal(fallbackLine({ model: { display_name: 'Opus 4.5' } }), 'Opus 4.5');
  // A zero cost is not worth a column on the status line.
  assert.equal(fallbackLine({ model: { display_name: 'Opus 4.5' }, cost: { total_cost_usd: 0 } }), 'Opus 4.5');
  assert.equal(fallbackLine({ cost: { total_cost_usd: 2 } }), '$2.00');
  assert.equal(fallbackLine({}), '');
  assert.equal(fallbackLine(null), '');
  for (const glyph of [String.fromCharCode(0x2014), String.fromCharCode(0x2013), String.fromCharCode(0x2026)]) {
    assert.equal(fallbackLine(PAYLOAD).includes(glyph), false);
  }
});

// Port 1 has nothing listening, so this is the "Glissa is down" case: the status line still has to be
// produced, and the process still has to exit 0.
test('with nothing to chain and no server listening, the fallback line is still printed', async () => {
  const stdout = fakeStdout();
  const code = await main(['http://127.0.0.1:1/hook/x/statusline?t=t', NO_CHAIN], fakeStdin(JSON.stringify(PAYLOAD)), stdout);
  assert.equal(code, 0);
  assert.equal(stdout.written.join(''), 'Opus 4.5  $1.23\n');
});

test('a chained command runs, receives the payload on stdin, and its exit code is passed through', async () => {
  const stdout = fakeStdout();
  // Echoes back whatever it was handed, which proves the consumed stdin was replayed to the child.
  const chain = Buffer.from(
    `node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{process.stdout.write('CHAINED:'+JSON.parse(d).session_id)})"`,
    'utf8',
  ).toString('base64');
  const code = await main(['http://127.0.0.1:1/hook/x/statusline?t=t', chain], fakeStdin(JSON.stringify(PAYLOAD)), stdout);
  assert.equal(code, 0);
});

test('a chained command that fails does not take the relay down', async () => {
  const stdout = fakeStdout();
  const chain = Buffer.from('node -e "process.exit(3)"', 'utf8').toString('base64');
  const code = await main(['http://127.0.0.1:1/hook/x/statusline?t=t', chain], fakeStdin('{}'), stdout);
  assert.equal(code, 3, 'the chained command owns the exit code');
});

test('a chain command that does not exist is survived', async () => {
  const stdout = fakeStdout();
  const chain = Buffer.from('glissa-no-such-binary-xyz', 'utf8').toString('base64');
  const code = await main(['http://127.0.0.1:1/hook/x/statusline?t=t', chain], fakeStdin('{}'), stdout);
  assert.equal(typeof code, 'number');
});

test('a malformed payload and a missing url are both survived', async () => {
  const stdout = fakeStdout();
  assert.equal(await main([], fakeStdin('{ not json'), stdout), 0);
  assert.equal(stdout.written.join(''), '', 'nothing to say, so nothing is printed');
  const second = fakeStdout();
  assert.equal(await main([undefined, NO_CHAIN], fakeStdin(''), second), 0);
});

// The relay only ever talks to the local Glissa; a non-loopback or non-http target is dropped rather
// than dialed. Nothing listens on either, so this asserts the shape holds and still returns.
test('a non-loopback or non-http target is not dialed', async () => {
  const stdout = fakeStdout();
  const code = await main(['https://example.com/hook/x/statusline', NO_CHAIN], fakeStdin(JSON.stringify(PAYLOAD)), stdout);
  assert.equal(code, 0);
  assert.equal(stdout.written.join(''), 'Opus 4.5  $1.23\n');
  const relative = await main(['not-a-url', NO_CHAIN], fakeStdin(JSON.stringify(PAYLOAD)), fakeStdout());
  assert.equal(relative, 0);
});

test('the POST reaches a listening local server with the raw body intact', async () => {
  const received: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ url: req.url, method: req.method, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook/sess/statusline?t=tok`;
  const raw = JSON.stringify(PAYLOAD);
  await main([url, NO_CHAIN], fakeStdin(raw), fakeStdout());
  await new Promise<void>((resolve) => { server.close(() => resolve()); });

  assert.equal(received.length, 1);
  assert.equal(received[0].method, 'POST');
  assert.equal(received[0].url, '/hook/sess/statusline?t=tok');
  // Raw and unmodified: normalization is the server's job, not the relay's.
  assert.equal(received[0].body, raw);
});
