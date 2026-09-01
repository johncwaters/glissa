import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  hashSecret, mintPairingToken, decideRedemption, mintDeviceCredential, decideDeviceAuth,
  deviceNameFromUserAgent, DEFAULT_TOKEN_TTL_MS, DEFAULT_DEVICE_MAX_AGE_MS,
} from '../server/core/pairing-token.ts';

// Deterministic entropy so token/id/secret shapes are assertable without a real RNG.
function fakeRandomBytes(fill: number) {
  return (n: number) => Buffer.alloc(n, fill);
}

test('hashSecret is sha256 hex and stable', () => {
  const expected = crypto.createHash('sha256').update('abc', 'utf8').digest('hex');
  assert.equal(hashSecret('abc'), expected);
  assert.equal(hashSecret('abc').length, 64);
  assert.notEqual(hashSecret('abc'), hashSecret('abd'));
});

test('mintPairingToken produces a base64url token and only ever exposes its hash for storage', () => {
  const minted = mintPairingToken({ now: 1000, randomBytes: fakeRandomBytes(0x41) });
  assert.match(minted.token, /^[A-Za-z0-9_-]+$/);
  assert.equal(minted.tokenHash, hashSecret(minted.token));
  assert.equal(minted.createdAt, 1000);
  assert.equal(minted.expiresAt, 1000 + DEFAULT_TOKEN_TTL_MS);
});

test('mintPairingToken honors an explicit TTL', () => {
  const minted = mintPairingToken({ now: 0, ttlMs: 5000, randomBytes: fakeRandomBytes(1) });
  assert.equal(minted.expiresAt, 5000);
});

test('two real mints never collide', () => {
  const a = mintPairingToken({});
  const b = mintPairingToken({});
  assert.notEqual(a.token, b.token);
  assert.equal(a.token.length >= 40, true, 'at least 32 bytes of entropy');
});

test('redemption rejects unknown, used and expired tokens', () => {
  assert.deepEqual(decideRedemption({ record: null, now: 0 }), { ok: false, reason: 'unknown' });
  assert.deepEqual(
    decideRedemption({ record: { expiresAt: 100, usedAt: 50 }, now: 60 }),
    { ok: false, reason: 'used' }
  );
  assert.deepEqual(
    decideRedemption({ record: { expiresAt: 100, usedAt: null }, now: 101 }),
    { ok: false, reason: 'expired' }
  );
});

test('redemption accepts a fresh unused token, right up to its expiry instant', () => {
  assert.deepEqual(
    decideRedemption({ record: { expiresAt: 100, usedAt: null }, now: 100 }),
    { ok: true, reason: null }
  );
});

test('used beats expired: a replayed old token never reports a shape suggesting a retry helps', () => {
  const verdict = decideRedemption({ record: { expiresAt: 10, usedAt: 5 }, now: 1000 });
  assert.equal(verdict.reason, 'used');
});

test('mintDeviceCredential yields a dot-free id and secret so the cookie split is unambiguous', () => {
  const credential = mintDeviceCredential({ randomBytes: fakeRandomBytes(0x42) });
  assert.equal(credential.id.includes('.'), false);
  assert.equal(credential.secret.includes('.'), false);
  assert.equal(credential.cookieValue, `${credential.id}.${credential.secret}`);
  assert.equal(credential.secretHash, hashSecret(credential.secret));
});

test('real device credentials are unique', () => {
  const a = mintDeviceCredential({});
  const b = mintDeviceCredential({});
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.secret, b.secret);
});

test('device auth rejects unknown, revoked, aged-out and mismatched secrets', () => {
  const base = { id: 'd1', createdAt: 0, revokedAt: null };
  assert.equal(decideDeviceAuth({ record: null, now: 0, secretMatches: true }).reason, 'unknown');
  assert.equal(
    decideDeviceAuth({ record: { ...base, revokedAt: 5 }, now: 10, secretMatches: true }).reason,
    'revoked'
  );
  assert.equal(
    decideDeviceAuth({ record: base, now: DEFAULT_DEVICE_MAX_AGE_MS + 1, secretMatches: true }).reason,
    'expired'
  );
  assert.equal(decideDeviceAuth({ record: base, now: 10, secretMatches: false }).reason, 'bad-secret');
});

test('a matching secret on a live device authenticates', () => {
  const verdict = decideDeviceAuth({
    record: { id: 'd1', createdAt: 0, revokedAt: null }, now: 1000, secretMatches: true,
  });
  assert.deepEqual(verdict, { ok: true, reason: null });
});

test('secretMatches must be strictly true, so a truthy stand-in cannot authenticate', () => {
  const record = { id: 'd1', createdAt: 0, revokedAt: null };
  assert.equal(decideDeviceAuth({ record, now: 0, secretMatches: 'yes' }).ok, false);
  assert.equal(decideDeviceAuth({ record, now: 0, secretMatches: 1 }).ok, false);
});

test('revocation outranks a valid secret and a fresh clock', () => {
  const verdict = decideDeviceAuth({
    record: { id: 'd1', createdAt: 0, revokedAt: 1 }, now: 2, secretMatches: true,
  });
  assert.equal(verdict.ok, false);
});

test('deviceNameFromUserAgent labels the common devices and degrades gracefully', () => {
  assert.equal(deviceNameFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), 'iPhone');
  assert.equal(deviceNameFromUserAgent('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)'), 'iPad');
  assert.equal(deviceNameFromUserAgent('Mozilla/5.0 (Linux; Android 14)'), 'Android');
  assert.equal(deviceNameFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'Mac');
  assert.equal(deviceNameFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'Windows');
  assert.equal(deviceNameFromUserAgent(''), 'unnamed device');
  assert.equal(deviceNameFromUserAgent(undefined), 'unnamed device');
  assert.equal(deviceNameFromUserAgent('curl/8.0'), 'unnamed device');
});
