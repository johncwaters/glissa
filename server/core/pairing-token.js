'use strict';

// Pairing tokens and device credentials. Deterministic given an injected randomBytes, so every
// lifetime rule (single use, TTL, revocation, max device age) is unit-testable without a clock or a
// filesystem. node:crypto is used only for hashing and entropy - no IO.
//
// INVARIANT: only HASHES are ever persisted or logged. A pairing URL is a bearer password that grants
// a device cookie, and that cookie is remote code execution as the server account (the control WS
// accepts an arbitrary project path plus dangerouslySkipPermissions). Nothing here returns a shape
// that tempts a caller to store or print the plaintext.

const crypto = require('node:crypto');

const DEFAULT_TOKEN_TTL_MS = 10 * 60 * 1000;
const DEFAULT_DEVICE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

/** @typedef {(size: number) => Buffer} RandomBytes */
/** @typedef {{ usedAt?: number | null, expiresAt?: number }} RedeemableRecord */
/** @typedef {{ revokedAt?: number | null, createdAt?: number }} DeviceRecord */

function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/** @param {{ now?: number, ttlMs?: number, randomBytes?: RandomBytes }} [options] */
function mintPairingToken({ now = Date.now(), ttlMs = DEFAULT_TOKEN_TTL_MS, randomBytes = crypto.randomBytes } = {}) {
  const token = Buffer.from(randomBytes(32)).toString('base64url');
  return { token, tokenHash: hashSecret(token), createdAt: now, expiresAt: now + ttlMs };
}

/** @param {{ record?: RedeemableRecord | null, now?: number }} options */
function decideRedemption({ record, now = Date.now() }) {
  if (!record) return { ok: false, reason: 'unknown' };
  if (record.usedAt) return { ok: false, reason: 'used' };
  if (typeof record.expiresAt === 'number' && now > record.expiresAt) return { ok: false, reason: 'expired' };
  return { ok: true, reason: null };
}

/** @param {{ randomBytes?: RandomBytes }} [options] */
function mintDeviceCredential({ randomBytes = crypto.randomBytes } = {}) {
  // base64url so neither half can contain the "." that separates them in the cookie value.
  const id = Buffer.from(randomBytes(8)).toString('base64url');
  const secret = Buffer.from(randomBytes(32)).toString('base64url');
  return { id, secret, secretHash: hashSecret(secret), cookieValue: `${id}.${secret}` };
}

/** @param {{ record?: DeviceRecord | null, now?: number, maxAgeMs?: number, secretMatches?: boolean }} [options] */
function decideDeviceAuth({ record, now = Date.now(), maxAgeMs = DEFAULT_DEVICE_MAX_AGE_MS, secretMatches } = {}) {
  if (!record) return { ok: false, reason: 'unknown' };
  if (record.revokedAt) return { ok: false, reason: 'revoked' };
  if (typeof record.createdAt === 'number' && maxAgeMs > 0 && now - record.createdAt > maxAgeMs) {
    return { ok: false, reason: 'expired' };
  }
  if (secretMatches !== true) return { ok: false, reason: 'bad-secret' };
  return { ok: true, reason: null };
}

/** @type {Array<[RegExp, string]>} */
const UA_PATTERNS = [
  [/iphone/i, 'iPhone'],
  [/ipad/i, 'iPad'],
  [/android/i, 'Android'],
  [/mac os x|macintosh/i, 'Mac'],
  [/windows/i, 'Windows'],
  [/cros/i, 'ChromeOS'],
  [/linux/i, 'Linux'],
];

function deviceNameFromUserAgent(ua) {
  if (typeof ua !== 'string' || ua.trim() === '') return 'unnamed device';
  for (const [pattern, label] of UA_PATTERNS) {
    if (pattern.test(ua)) return label;
  }
  return 'unnamed device';
}

module.exports = {
  DEFAULT_TOKEN_TTL_MS,
  DEFAULT_DEVICE_MAX_AGE_MS,
  hashSecret,
  mintPairingToken,
  decideRedemption,
  mintDeviceCredential,
  decideDeviceAuth,
  deviceNameFromUserAgent,
};
