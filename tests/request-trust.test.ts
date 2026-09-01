import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyRequestOrigin, decideRequestAccess, decideUpgradeAccess, isPairPath, normalizePathname,
  normalizeClientTrust,
} from '../server/core/request-trust.ts';

test('normalizeClientTrust collapses an unstamped connection to local', () => {
  assert.equal(normalizeClientTrust('remote'), 'remote');
  assert.equal(normalizeClientTrust('local'), 'local');
  assert.equal(normalizeClientTrust(undefined), 'local',
    'remote mode off stamps no trust, and the client must read that as local');
  assert.equal(normalizeClientTrust(null), 'local');
  assert.equal(normalizeClientTrust('anything-else'), 'local');
});

test('with no remote listener every socket is local', () => {
  assert.equal(classifyRequestOrigin({ localPort: 3000, remoteListenerPort: null }), 'local');
  assert.equal(classifyRequestOrigin({ localPort: 3001, remoteListenerPort: null }), 'local');
  assert.equal(classifyRequestOrigin({ localPort: null, remoteListenerPort: null }), 'local');
});

test('only the remote listener port classifies as remote', () => {
  assert.equal(classifyRequestOrigin({ localPort: 3001, remoteListenerPort: 3001 }), 'remote');
  assert.equal(classifyRequestOrigin({ localPort: 3000, remoteListenerPort: 3001 }), 'local');
  assert.equal(classifyRequestOrigin({ localPort: undefined, remoteListenerPort: 3001 }), 'local');
});

test('isPairPath covers /pair and everything under it, and nothing that merely starts with the letters', () => {
  assert.equal(isPairPath('/pair'), true);
  assert.equal(isPairPath('/pair/abc'), true);
  assert.equal(isPairPath('/pairing'), false);
  assert.equal(isPairPath('/'), false);
  assert.equal(isPairPath(undefined), false);
});

test('normalizePathname decodes once, drops the query, and flags every dot segment', () => {
  assert.deepEqual(normalizePathname('/pair/abc?x=1#frag'), { pathname: '/pair/abc', suspicious: false });
  assert.deepEqual(normalizePathname('/pair/%61bc'), { pathname: '/pair/abc', suspicious: false });
  assert.equal(normalizePathname('/pair/%2e%2e/index.html').suspicious, true);
  assert.equal(normalizePathname('/pair/../index.html').suspicious, true);
  assert.equal(normalizePathname('/pair/./index.html').suspicious, true);
  // Encoded twice: the decode leaves a live %2e behind, which is not a path anyone legitimately asks for.
  assert.equal(normalizePathname('/pair/%252e%252e/index.html').suspicious, true);
  // A lone % throws in decodeURIComponent; that is a refusal, not an exception.
  assert.equal(normalizePathname('/pair/%').suspicious, true);
});

// The reviewer's reproduction: express.static decodes and resolves dot segments, so an un-normalized
// prefix check read "/pair/%2e%2e/index.html" as the pair page while express served the dashboard
// bundle to an unpaired remote device.
test('a traversal dressed as a pair path is not a pair path', () => {
  assert.equal(isPairPath('/pair/%2e%2e/index.html'), false);
  assert.equal(isPairPath('/pair/../index.html'), false);
  assert.equal(isPairPath('/pair/%2e%2e%2findex.html'), false);
  assert.deepEqual(
    decideRequestAccess({
      remoteEnabled: true, trust: 'remote', pathname: normalizePathname('/pair/%2e%2e/index.html').pathname, authenticated: false,
    }),
    { allow: false, action: 'unauthorized' }
  );
});

// Full matrix: remoteEnabled x trust x authenticated x path.
const PATHS = ['/', '/hook/abc/Stop', '/app.js', '/pair/tok'];

test('with remote disabled every request is allowed on both listeners, whatever the path', () => {
  for (const trust of ['local', 'remote']) {
    for (const authenticated of [true, false]) {
      for (const pathname of PATHS) {
        assert.deepEqual(
          decideRequestAccess({ remoteEnabled: false, trust, pathname, authenticated }),
          { allow: true, action: 'allow' },
          `${trust}/${authenticated}/${pathname}`
        );
      }
    }
  }
});

test('with remote enabled the local listener stays fully open (byte-identical to today)', () => {
  for (const authenticated of [true, false]) {
    for (const pathname of PATHS) {
      assert.deepEqual(
        decideRequestAccess({ remoteEnabled: true, trust: 'local', pathname, authenticated }),
        { allow: true, action: 'allow' },
        `${authenticated}/${pathname}`
      );
    }
  }
});

test('on the remote listener only /pair/* is reachable without a cookie', () => {
  assert.deepEqual(
    decideRequestAccess({ remoteEnabled: true, trust: 'remote', pathname: '/pair/tok', authenticated: false }),
    { allow: true, action: 'pair-page' }
  );
  for (const pathname of ['/', '/app.js', '/hook/abc/Stop']) {
    assert.deepEqual(
      decideRequestAccess({ remoteEnabled: true, trust: 'remote', pathname, authenticated: false }),
      { allow: false, action: 'unauthorized' },
      pathname
    );
  }
});

test('the hook ingress is NOT exempt on the remote listener', () => {
  const decision = decideRequestAccess({
    remoteEnabled: true, trust: 'remote', pathname: '/hook/session/Stop', authenticated: false,
  });
  assert.equal(decision.allow, false);
});

test('an authenticated remote device reaches every path', () => {
  for (const pathname of PATHS) {
    assert.equal(
      decideRequestAccess({ remoteEnabled: true, trust: 'remote', pathname, authenticated: true }).allow,
      true,
      pathname
    );
  }
});

test('authenticated must be strictly true', () => {
  const decision = decideRequestAccess({
    remoteEnabled: true, trust: 'remote', pathname: '/', authenticated: 'yes',
  });
  assert.equal(decision.allow, false);
});

test('upgrade: a refused origin loses on both listeners, before any auth consideration', () => {
  for (const remoteEnabled of [false, true]) {
    for (const trust of ['local', 'remote']) {
      assert.deepEqual(
        decideUpgradeAccess({
          remoteEnabled, trust, origin: 'https://evil.example', allowedOrigins: ['https://glissa.test'],
          authenticated: true,
        }),
        { allow: false, reason: 'origin' },
        `${remoteEnabled}/${trust}`
      );
    }
  }
});

test('upgrade: with remote disabled, an allowed origin passes without a cookie', () => {
  assert.deepEqual(
    decideUpgradeAccess({ remoteEnabled: false, trust: 'local', origin: 'http://localhost:3000', allowedOrigins: [], authenticated: false, listenerPorts: [3000] }),
    { allow: true, reason: null }
  );
});

test('upgrade: the local listener never needs a cookie even with remote enabled', () => {
  assert.deepEqual(
    decideUpgradeAccess({ remoteEnabled: true, trust: 'local', origin: 'http://localhost:3000', allowedOrigins: ['https://glissa.test'], authenticated: false, listenerPorts: [3000] }),
    { allow: true, reason: null }
  );
});

// The dashboard-only rules (2026-08 security pass). control and data carry them; every other route
// (the Visions editor relay) keeps the pre-existing shape, which is what lets a non-browser client
// still open one.
test('upgrade: a dashboard route needs an Origin and the page token', () => {
  const base = {
    remoteEnabled: false, trust: 'local', allowedOrigins: [], listenerPorts: [3000], dashboardRoute: true,
  };
  assert.deepEqual(
    decideUpgradeAccess({ ...base, origin: 'http://localhost:3000', tokenOk: true }),
    { allow: true, reason: null }
  );
  assert.deepEqual(
    decideUpgradeAccess({ ...base, origin: 'http://localhost:3000', tokenOk: false }),
    { allow: false, reason: 'token' }
  );
  assert.deepEqual(
    decideUpgradeAccess({ ...base, origin: undefined, tokenOk: true }),
    { allow: false, reason: 'origin' }
  );
  // tokenOk must be strictly true, like authenticated.
  assert.deepEqual(
    decideUpgradeAccess({ ...base, origin: 'http://localhost:3000', tokenOk: 'yes' }),
    { allow: false, reason: 'token' }
  );
});

test('upgrade: a non-dashboard route still accepts a tokenless client with no Origin', () => {
  assert.deepEqual(
    decideUpgradeAccess({ remoteEnabled: false, trust: 'local', origin: undefined, allowedOrigins: [], listenerPorts: [3000] }),
    { allow: true, reason: null }
  );
});

test('upgrade: a paired remote device needs no page token (its cookie is the credential)', () => {
  assert.deepEqual(
    decideUpgradeAccess({
      remoteEnabled: true, trust: 'remote', origin: 'https://glissa.test', allowedOrigins: ['https://glissa.test'],
      authenticated: true, dashboardRoute: true, tokenOk: false,
    }),
    { allow: true, reason: null }
  );
});

test('upgrade: a remote socket needs both an allowed origin and a cookie', () => {
  assert.deepEqual(
    decideUpgradeAccess({ remoteEnabled: true, trust: 'remote', origin: 'https://glissa.test', allowedOrigins: ['https://glissa.test'], authenticated: false }),
    { allow: false, reason: 'auth' }
  );
  assert.deepEqual(
    decideUpgradeAccess({ remoteEnabled: true, trust: 'remote', origin: 'https://glissa.test', allowedOrigins: ['https://glissa.test'], authenticated: true }),
    { allow: true, reason: null }
  );
});

test('upgrade: a remote socket with no Origin header still needs a cookie', () => {
  assert.deepEqual(
    decideUpgradeAccess({ remoteEnabled: true, trust: 'remote', origin: undefined, allowedOrigins: [], authenticated: false }),
    { allow: false, reason: 'auth' }
  );
  assert.deepEqual(
    decideUpgradeAccess({ remoteEnabled: true, trust: 'remote', origin: undefined, allowedOrigins: [], authenticated: true }),
    { allow: true, reason: null }
  );
});
