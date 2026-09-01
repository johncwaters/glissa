import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeRemoteConfig, validateRemoteConfig, isLoopbackHost, decideBindHost,
} from '../server/core/remote-config.ts';

test('an absent remote block normalizes to the inert default', () => {
  for (const raw of [undefined, null, 'nonsense', 42, []]) {
    assert.deepEqual(normalizeRemoteConfig(raw), {
      enabled: false, port: null, publicHost: '', allowedOrigins: [],
    });
  }
});

test('enabled is strictly boolean true, never truthy coercion', () => {
  assert.equal(normalizeRemoteConfig({ enabled: 'yes' }).enabled, false);
  assert.equal(normalizeRemoteConfig({ enabled: 1 }).enabled, false);
  assert.equal(normalizeRemoteConfig({ enabled: true }).enabled, true);
});

test('port accepts an integer or a numeric string, else null', () => {
  assert.equal(normalizeRemoteConfig({ port: 3001 }).port, 3001);
  assert.equal(normalizeRemoteConfig({ port: ' 3001 ' }).port, 3001);
  assert.equal(normalizeRemoteConfig({ port: 'abc' }).port, null);
  assert.equal(normalizeRemoteConfig({ port: 3001.5 }).port, null);
});

test('allowedOrigins defaults to https://<publicHost> when a host is set and the list is empty', () => {
  const remote = normalizeRemoteConfig({ enabled: true, port: 3001, publicHost: 'glissa.test' });
  assert.deepEqual(remote.allowedOrigins, ['https://glissa.test']);
  assert.deepEqual(normalizeRemoteConfig({ publicHost: '  glissa.test  ' }).publicHost, 'glissa.test');
});

test('an explicit allowedOrigins list wins over the publicHost default', () => {
  const remote = normalizeRemoteConfig({ enabled: true, port: 3001, publicHost: 'glissa.test', allowedOrigins: ['https://other.test'] });
  assert.deepEqual(remote.allowedOrigins, ['https://other.test']);
});

test('allowedOrigins drops non-string and blank entries', () => {
  const remote = normalizeRemoteConfig({ enabled: true, port: 3001, allowedOrigins: ['https://a.test', '', '  ', 7, null] });
  assert.deepEqual(remote.allowedOrigins, ['https://a.test']);
});

test('a disabled remote block contributes no allowed origins at all', () => {
  assert.deepEqual(normalizeRemoteConfig({ enabled: false, publicHost: 'glissa.test' }).allowedOrigins, []);
  assert.deepEqual(
    normalizeRemoteConfig({ enabled: false, publicHost: 'glissa.test', allowedOrigins: ['https://other.test'] }).allowedOrigins,
    []
  );
  assert.equal(normalizeRemoteConfig({ enabled: false, publicHost: 'glissa.test' }).publicHost, 'glissa.test',
    'the host itself is still reported, it just grants nothing');
});

test('no publicHost and no list means no allowed origins (localhost still passes in origin-policy)', () => {
  assert.deepEqual(normalizeRemoteConfig({ enabled: true, port: 3001 }).allowedOrigins, []);
});

test('validation passes trivially while remote is disabled, whatever else is set', () => {
  assert.deepEqual(validateRemoteConfig({ enabled: false, port: null }, 3000), { ok: true, error: null });
  assert.deepEqual(validateRemoteConfig({ enabled: false, port: 3000 }, 3000), { ok: true, error: null });
});

test('enabled without a port is a boot error', () => {
  const result = validateRemoteConfig({ enabled: true, port: null }, 3000);
  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.match(result.error, /remote\.port is not set/);
});

test('a remote port equal to the local port is a boot error (it would erase the trust split)', () => {
  const result = validateRemoteConfig({ enabled: true, port: 3000 }, 3000);
  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.match(result.error, /must differ/);
});

test('out-of-range ports are boot errors', () => {
  assert.equal(validateRemoteConfig({ enabled: true, port: 0 }, 3000).ok, false);
  assert.equal(validateRemoteConfig({ enabled: true, port: 70000 }, 3000).ok, false);
  assert.equal(validateRemoteConfig({ enabled: true, port: 3001 }, 3000).ok, true);
});

test('isLoopbackHost recognizes the loopback spellings and nothing else', () => {
  for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]', '0:0:0:0:0:0:0:1']) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ['0.0.0.0', '192.168.1.5', 'glissa.test', '', null, undefined, '128.0.0.1']) {
    assert.equal(isLoopbackHost(host), false, String(host));
  }
});

test('no GLISSA_HOST binds loopback', () => {
  assert.deepEqual(decideBindHost({}), { host: '127.0.0.1', allowed: true, reason: null });
  assert.deepEqual(decideBindHost({ envHost: '   ' }), { host: '127.0.0.1', allowed: true, reason: null });
});

test('a loopback GLISSA_HOST is honored as-is', () => {
  assert.deepEqual(decideBindHost({ envHost: '::1' }), { host: '::1', allowed: true, reason: null });
});

test('a non-loopback GLISSA_HOST is refused unless insecure bind is explicit', () => {
  const refused = decideBindHost({ envHost: '0.0.0.0' });
  assert.equal(refused.allowed, false);
  assert.equal(refused.reason, 'non-loopback');
  const allowed = decideBindHost({ envHost: '0.0.0.0', insecureBind: true });
  assert.deepEqual(allowed, { host: '0.0.0.0', allowed: true, reason: 'insecure-bind' });
});

test('insecureBind must be strictly true, so a stray truthy env string cannot open the bind', () => {
  assert.equal(decideBindHost({ envHost: '0.0.0.0', insecureBind: 'yes' }).allowed, false);
  assert.equal(decideBindHost({ envHost: '0.0.0.0', insecureBind: 1 }).allowed, false);
});
