'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyRequestOrigin, decideRequestAccess, decideUpgradeAccess, decideEditorOpenAccess, isPairPath,
  normalizeClientTrust,
} = require('../server/core/request-trust');

test('normalizeClientTrust collapses an unstamped connection to local', () => {
  assert.equal(normalizeClientTrust('remote'), 'remote');
  assert.equal(normalizeClientTrust('local'), 'local');
  assert.equal(normalizeClientTrust(undefined), 'local',
    'remote mode off stamps no trust, and the client must read that as local');
  assert.equal(normalizeClientTrust(null), 'local');
  assert.equal(normalizeClientTrust('anything-else'), 'local');
});

// Opening a run artifact spawns the configured editor on the SERVER machine, so a paired phone must
// be refused explicitly rather than told a window opened somewhere it cannot see.
test('decideEditorOpenAccess refuses remote connections and nothing else', () => {
  assert.deepEqual(decideEditorOpenAccess('remote'), { allow: false, reason: 'remote' });
  assert.deepEqual(decideEditorOpenAccess('local'), { allow: true, reason: null });
  assert.deepEqual(decideEditorOpenAccess(undefined), { allow: true, reason: null },
    'remote mode off stamps no trust, which is local by definition');
  assert.deepEqual(decideEditorOpenAccess(null), { allow: true, reason: null });
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
    decideUpgradeAccess({ remoteEnabled: false, trust: 'local', origin: 'http://localhost:3000', allowedOrigins: [], authenticated: false }),
    { allow: true, reason: null }
  );
});

test('upgrade: the local listener never needs a cookie even with remote enabled', () => {
  assert.deepEqual(
    decideUpgradeAccess({ remoteEnabled: true, trust: 'local', origin: 'http://localhost:3000', allowedOrigins: ['https://glissa.test'], authenticated: false }),
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
