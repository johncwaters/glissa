import crypto from 'node:crypto';
import path from 'node:path';

// PINNED release plus PINNED digests. Never resolve "latest" and never read a checksums file served
// beside the binary: one compromised release page would then swap both halves and verify clean.
const RTK_VERSION = '0.45.0';
const RTK_RELEASE_BASE_URL = 'https://github.com/rtk-ai/rtk/releases/download/v0.45.0/';

export interface RtkAsset {
  file: string;
  sha256: string;
}

const RTK_ASSETS: Record<string, RtkAsset> = {
  'linux-x64': {
    file: 'rtk-x86_64-unknown-linux-musl.tar.gz',
    sha256: 'c4c036fbf181fc55ef329786c8c17e0d427972b053b825944d968a6aafef1ba4',
  },
  'linux-arm64': {
    file: 'rtk-aarch64-unknown-linux-gnu.tar.gz',
    sha256: '80a746dd305ef944ff50ef011ae4ce3878dd5ba88dfe35d859d05498191637c3',
  },
  'win32-x64': {
    file: 'rtk-x86_64-pc-windows-msvc.zip',
    sha256: '34cea9009a8099acdaf85147b971d95f65efabfa63fb3aea7d3e2b73e6f517c3',
  },
  'darwin-x64': {
    file: 'rtk-x86_64-apple-darwin.tar.gz',
    sha256: '9ea02f889d5a2779e4fb700df4587824303c5a57cda22e903e30058079fca0ef',
  },
  'darwin-arm64': {
    file: 'rtk-aarch64-apple-darwin.tar.gz',
    sha256: '064151cfc2d50b24d810b06a0af2e41b9c945e83534e4c438c3d3eae607fc3f4',
  },
};

const INSTALL_FAILURE_COOLDOWN_MS = 10 * 60 * 1000;

function assetForPlatform(platform: string, arch: string): (RtkAsset & { version: string; url: string }) | null {
  const entry = RTK_ASSETS[`${platform}-${arch}`];
  if (!entry) return null;
  return { ...entry, version: RTK_VERSION, url: `${RTK_RELEASE_BASE_URL}${entry.file}` };
}

function decideRtkInstall({
  rtkEnabled,
  resolvedPath,
  platform,
  arch,
  inFlight = false,
  lastFailureAt = null,
  nowMs = 0,
  cooldownMs = INSTALL_FAILURE_COOLDOWN_MS,
}: {
  rtkEnabled?: boolean;
  resolvedPath?: string | null;
  platform?: string;
  arch?: string;
  inFlight?: boolean;
  lastFailureAt?: number | null;
  nowMs?: number;
  cooldownMs?: number;
} = {}) {
  if (!rtkEnabled) return { action: 'skip', reason: 'rtk-disabled' };
  if (resolvedPath) return { action: 'skip', reason: 'already-resolved' };
  if (inFlight) return { action: 'skip', reason: 'install-in-flight' };
  const asset = assetForPlatform(String(platform), String(arch));
  if (!asset) return { action: 'skip', reason: `unsupported-platform:${platform}-${arch}` };
  if (typeof lastFailureAt === 'number' && nowMs - lastFailureAt < cooldownMs) {
    return { action: 'skip', reason: 'failure-cooldown' };
  }
  return { action: 'install', reason: 'missing-binary', asset };
}

function verifyDigest(expectedHex: unknown, actualHex: unknown): boolean {
  if (typeof expectedHex !== 'string' || typeof actualHex !== 'string') return false;
  if (expectedHex.length !== actualHex.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expectedHex, 'utf8'), Buffer.from(actualHex, 'utf8'));
}

function installTargetPath(homeDir: string, platform: string): string {
  const binaryName = platform === 'win32' ? 'rtk.exe' : 'rtk';
  return path.join(homeDir, '.glissa', 'bin', binaryName);
}

function isRtkBinaryName(name: string, platform: string): boolean {
  const wanted = platform === 'win32' ? 'rtk.exe' : 'rtk';
  return name.toLowerCase() === wanted;
}

function findEscapingArchiveMember(listingText: unknown): string | null {
  const members = String(listingText || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const member of members) {
    const segments = member.split(/[\\/]+/);
    if (segments.includes('..')) return member;
    if (member.startsWith('/') || member.startsWith('\\') || /^[A-Za-z]:/.test(member)) return member;
  }
  return null;
}

export { findEscapingArchiveMember, RTK_VERSION, RTK_RELEASE_BASE_URL, RTK_ASSETS, INSTALL_FAILURE_COOLDOWN_MS, assetForPlatform, decideRtkInstall, verifyDigest, installTargetPath, isRtkBinaryName };
