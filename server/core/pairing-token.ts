import crypto from 'node:crypto';

const DEFAULT_TOKEN_TTL_MS = 10 * 60 * 1000;
const DEFAULT_DEVICE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

export type RandomBytes = (size: number) => Buffer;

export interface RedeemableRecord {
  usedAt?: number | null;
  expiresAt?: number;
  [key: string]: unknown;
}

export interface DeviceRecord {
  revokedAt?: number | null;
  createdAt?: number;
  [key: string]: unknown;
}

export interface PairingToken {
  token: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
}

export interface DeviceCredential {
  id: string;
  secret: string;
  secretHash: string;
  cookieValue: string;
}

export interface AuthDecision {
  ok: boolean;
  reason: string | null;
}

function hashSecret(value: unknown): string {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function mintPairingToken({
  now = Date.now(),
  ttlMs = DEFAULT_TOKEN_TTL_MS,
  randomBytes = crypto.randomBytes,
}: { now?: number; ttlMs?: number; randomBytes?: RandomBytes } = {}): PairingToken {
  const token = Buffer.from(randomBytes(32)).toString('base64url');
  return { token, tokenHash: hashSecret(token), createdAt: now, expiresAt: now + ttlMs };
}

function decideRedemption({
  record,
  now = Date.now(),
}: { record?: RedeemableRecord | null; now?: number }): AuthDecision {
  if (!record) return { ok: false, reason: 'unknown' };
  if (record.usedAt) return { ok: false, reason: 'used' };
  if (typeof record.expiresAt === 'number' && now > record.expiresAt) return { ok: false, reason: 'expired' };
  return { ok: true, reason: null };
}

function mintDeviceCredential({ randomBytes = crypto.randomBytes }: { randomBytes?: RandomBytes } = {}): DeviceCredential {
  const id = Buffer.from(randomBytes(8)).toString('base64url');
  const secret = Buffer.from(randomBytes(32)).toString('base64url');
  return { id, secret, secretHash: hashSecret(secret), cookieValue: `${id}.${secret}` };
}

function decideDeviceAuth({
  record,
  now = Date.now(),
  maxAgeMs = DEFAULT_DEVICE_MAX_AGE_MS,
  secretMatches,
}: {
  record?: DeviceRecord | null;
  now?: number;
  maxAgeMs?: number;
  secretMatches?: unknown;
} = {}): AuthDecision {
  if (!record) return { ok: false, reason: 'unknown' };
  if (record.revokedAt) return { ok: false, reason: 'revoked' };
  if (typeof record.createdAt === 'number' && maxAgeMs > 0 && now - record.createdAt > maxAgeMs) {
    return { ok: false, reason: 'expired' };
  }
  if (secretMatches !== true) return { ok: false, reason: 'bad-secret' };
  return { ok: true, reason: null };
}

const UA_PATTERNS: [RegExp, string][] = [
  [/iphone/i, 'iPhone'],
  [/ipad/i, 'iPad'],
  [/android/i, 'Android'],
  [/mac os x|macintosh/i, 'Mac'],
  [/windows/i, 'Windows'],
  [/cros/i, 'ChromeOS'],
  [/linux/i, 'Linux'],
];

function deviceNameFromUserAgent(ua: unknown): string {
  if (typeof ua !== 'string' || ua.trim() === '') return 'unnamed device';
  for (const [pattern, label] of UA_PATTERNS) {
    if (pattern.test(ua)) return label;
  }
  return 'unnamed device';
}

export {
  DEFAULT_TOKEN_TTL_MS,
  DEFAULT_DEVICE_MAX_AGE_MS,
  hashSecret,
  mintPairingToken,
  decideRedemption,
  mintDeviceCredential,
  decideDeviceAuth,
  deviceNameFromUserAgent,
};
