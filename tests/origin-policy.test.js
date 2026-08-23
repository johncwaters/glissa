'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeOrigin, decideOriginAllowed, hostOfOrigin } = require('../server/core/origin-policy');

// The listener a dashboard socket lands on. Every loopback decision below is relative to it: that is
// the whole point of the 2026-08 port-exact rule.
const LISTENER = [3000];

test('normalizeOrigin lowercases, drops the trailing slash and the default port', () => {
  assert.equal(normalizeOrigin('HTTPS://Example.COM/'), 'https://example.com');
  assert.equal(normalizeOrigin('https://example.com:443'), 'https://example.com');
  assert.equal(normalizeOrigin('http://example.com:80'), 'http://example.com');
  assert.equal(normalizeOrigin('http://example.com:5173'), 'http://example.com:5173');
});

test('normalizeOrigin keeps bracketed IPv6 hosts intact', () => {
  assert.equal(normalizeOrigin('http://[::1]:3000'), 'http://[::1]:3000');
  assert.equal(normalizeOrigin('http://[::1]'), 'http://[::1]');
});

test('normalizeOrigin rejects anything that is not a bare origin', () => {
  for (const bad of ['', '   ', 'null', 'example.com', 'https://user@example.com', 'https://example.com/path',
    'https://example.com?q=1', 'https://example.com:notaport', null, undefined, 7]) {
    assert.equal(normalizeOrigin(bad), null, String(bad));
  }
});

test('normalizeOrigin passes a wildcard entry through (it is not a valid URL)', () => {
  assert.equal(normalizeOrigin('https://*.ts.net'), 'https://*.ts.net');
});

test('a loopback origin is admitted only on a listener port', () => {
  const opts = { listenerPorts: LISTENER };
  assert.equal(decideOriginAllowed('http://localhost:3000', [], opts), true);
  assert.equal(decideOriginAllowed('http://127.0.0.1:3000', [], opts), true);
  // The gap this closes: another web app on another local port (a dev server, a notebook, Grafana)
  // used to be admitted to a channel that spawns permissionless sessions.
  assert.equal(decideOriginAllowed('http://localhost:5173', [], opts), false);
  assert.equal(decideOriginAllowed('http://127.0.0.1:8888', [], opts), false);
  // No port at all means the scheme default, which is a listener port only on a server bound there.
  assert.equal(decideOriginAllowed('http://localhost', [], opts), false);
  assert.equal(decideOriginAllowed('http://localhost', [], { listenerPorts: [80] }), true);
  assert.equal(decideOriginAllowed('https://localhost', [], { listenerPorts: [443] }), true);
});

test('with no listener ports declared, no loopback origin is admitted by the loopback rule', () => {
  assert.equal(decideOriginAllowed('http://localhost:3000', []), false);
  assert.equal(decideOriginAllowed('http://localhost:3000', ['http://localhost:3000']), true);
});

test('a loopback origin on a non-listener port still passes if it is explicitly allow-listed', () => {
  const decision = decideOriginAllowed('http://localhost:8080', ['http://localhost:8080'], { listenerPorts: LISTENER });
  assert.equal(decision, true);
});

test('hosts that only look like loopback are refused whatever the port', () => {
  const opts = { listenerPorts: LISTENER };
  for (const origin of ['http://127.0.0.2:3000', 'http://localhost.evil.example:3000', 'http://[::1]:3000']) {
    assert.equal(decideOriginAllowed(origin, [], opts), false, origin);
  }
});

test('a missing Origin is allowed by default and refused where the caller demands one', () => {
  assert.equal(decideOriginAllowed(undefined, ['https://glissa.test']), true);
  assert.equal(decideOriginAllowed('', ['https://glissa.test']), true);
  assert.equal(decideOriginAllowed(undefined, ['https://glissa.test'], { requireOrigin: true }), false);
  assert.equal(decideOriginAllowed('', ['https://glissa.test'], { requireOrigin: true }), false);
});

test('hostOfOrigin reads the host an allow-list entry names, wildcard included', () => {
  assert.equal(hostOfOrigin('https://glissa.test'), 'glissa.test');
  assert.equal(hostOfOrigin('https://Box.TS.net:8443'), 'box.ts.net');
  assert.equal(hostOfOrigin('https://*.ts.net'), '*.ts.net');
  assert.equal(hostOfOrigin('nonsense'), '');
});

test('a configured origin is allowed by exact normalized match', () => {
  assert.equal(decideOriginAllowed('https://glissa.test', ['https://glissa.test']), true);
  assert.equal(decideOriginAllowed('HTTPS://Glissa.Test/', ['https://glissa.test']), true);
  assert.equal(decideOriginAllowed('https://glissa.test:443', ['https://glissa.test']), true);
});

test('a scheme or port mismatch is refused even when the host matches', () => {
  assert.equal(decideOriginAllowed('http://glissa.test', ['https://glissa.test']), false);
  assert.equal(decideOriginAllowed('https://glissa.test:8443', ['https://glissa.test']), false);
});

test('a host wildcard matches one or more labels below it, never the apex', () => {
  const list = ['https://*.ts.net'];
  assert.equal(decideOriginAllowed('https://box.ts.net', list), true);
  assert.equal(decideOriginAllowed('https://a.b.ts.net', list), true);
  assert.equal(decideOriginAllowed('https://ts.net', list), false);
  assert.equal(decideOriginAllowed('https://evilts.net', list), false);
  assert.equal(decideOriginAllowed('http://box.ts.net', list), false);
  assert.equal(decideOriginAllowed('https://box.ts.net.evil.example', list), false);
});

test('an unparseable Origin is refused regardless of the list', () => {
  assert.equal(decideOriginAllowed('null', ['https://glissa.test']), false);
  assert.equal(decideOriginAllowed('https://glissa.test/path', ['https://glissa.test']), false);
});

test('a garbage allow-list entry is skipped, not treated as a wildcard', () => {
  assert.equal(decideOriginAllowed('https://evil.example', ['', 'nonsense', null, 42]), false);
});
