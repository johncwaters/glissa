import test from 'node:test';
import assert from 'node:assert/strict';

import { decideHostAllowed, hostOnly } from '../server/core/host-policy.ts';

test('hostOnly strips the port and lowercases, brackets intact for IPv6', () => {
  assert.equal(hostOnly('Localhost:3000'), 'localhost');
  assert.equal(hostOnly('box.TS.net'), 'box.ts.net');
  assert.equal(hostOnly('[::1]:3000'), '[::1]');
  assert.equal(hostOnly('[::1]'), '[::1]');
  assert.equal(hostOnly(''), '');
  assert.equal(hostOnly(null), '');
});

test('every loopback literal passes, with or without a port', () => {
  for (const host of ['localhost', 'localhost:3000', '127.0.0.1', '127.0.0.1:5173', '127.5.5.5:80', '[::1]:3000', '[::1]']) {
    assert.equal(decideHostAllowed(host, []), true, host);
  }
});

// A Host header brackets IPv6, so the bare spelling is not a form this ever has to accept - and it
// cannot be split from a port unambiguously anyway.
test('a bare unbracketed IPv6 literal is not treated as loopback', () => {
  assert.equal(decideHostAllowed('::1', []), false);
});

test('a rebinding name is refused unless it is allow-listed', () => {
  assert.equal(decideHostAllowed('evil.example', []), false);
  assert.equal(decideHostAllowed('evil.example:3000', []), false);
  assert.equal(decideHostAllowed('box.ts.net', []), false);
  assert.equal(decideHostAllowed('box.ts.net', ['box.ts.net']), true);
  assert.equal(decideHostAllowed('BOX.ts.net:8443', ['box.ts.net']), true);
});

test('a host wildcard matches below the apex only, same rule as the origin list', () => {
  assert.equal(decideHostAllowed('box.ts.net', ['*.ts.net']), true);
  assert.equal(decideHostAllowed('a.b.ts.net', ['*.ts.net']), true);
  assert.equal(decideHostAllowed('ts.net', ['*.ts.net']), false);
  assert.equal(decideHostAllowed('evilts.net', ['*.ts.net']), false);
});

// Rebinding always carries a name, so an absent Host cannot be the attack; refusing it would only
// break HTTP/1.0 clients.
test('an absent Host is allowed, an empty-after-parse one is not', () => {
  assert.equal(decideHostAllowed(undefined, []), true);
  assert.equal(decideHostAllowed('', []), true);
  assert.equal(decideHostAllowed(':3000', []), false);
});
