'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeOrigin, decideOriginAllowed } = require('../server/core/origin-policy');

// The exact function decideOriginAllowed replaced in backend.js. Kept here so the "empty list ==
// today's behavior" claim is checked against the original code, not against a paraphrase of it.
function legacyIsAllowedOrigin(origin) {
  if (!origin) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

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

test('an empty allow-list reproduces the replaced isAllowedOrigin exactly', () => {
  const cases = [
    undefined, null, '', 'http://localhost', 'http://localhost:5173', 'https://localhost',
    'http://127.0.0.1:3000', 'https://127.0.0.1', 'http://[::1]:3000', 'https://evil.example',
    'https://glissa.test', 'not-an-origin', 'null', 'http://127.0.0.2:3000',
    'http://localhost.evil.example',
  ];
  for (const origin of cases) {
    assert.equal(
      decideOriginAllowed(origin, []),
      legacyIsAllowedOrigin(origin),
      `origin ${String(origin)} must decide the same as the legacy check`
    );
  }
});

test('a missing Origin is allowed (non-browser clients never send one)', () => {
  assert.equal(decideOriginAllowed(undefined, ['https://glissa.test']), true);
  assert.equal(decideOriginAllowed('', ['https://glissa.test']), true);
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
