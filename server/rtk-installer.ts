import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execFileAsync } from './child-process-safe.ts';
import {
  assetForPlatform,
  findEscapingArchiveMember,
  installTargetPath,
  isRtkBinaryName,
  verifyDigest,
} from './core/rtk-install-core.ts';
import type { RtkAsset } from './core/rtk-install-core.ts';

const DOWNLOAD_TIMEOUT_MS = 60000;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

type ResolvedAsset = RtkAsset & { version: string; url: string };

type DownloadResult = { ok: true; bytes: Buffer } | { ok: false; reason: string };

type InstallResult =
  | { ok: true; path: string; version: string }
  | { ok: false; reason: string };

interface InstallRtkOptions {
  homeDir?: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  fetchImpl?: typeof fetch;
  execFileImpl?: typeof execFileAsync;
  renameImpl?: typeof fsp.rename;
  timeoutMs?: number;
  log?: Pick<Console, 'log' | 'warn'> | null;
  asset?: ResolvedAsset | null;
}

function errorText(err: unknown): string {
  const failure = (err ?? {}) as { message?: unknown };
  return failure.message ? String(failure.message) : String(err);
}

function errorCode(err: unknown): unknown {
  return (err as { code?: unknown } | null)?.code;
}

async function downloadCapped(
  url: string,
  { fetchImpl, timeoutMs = DOWNLOAD_TIMEOUT_MS }: { fetchImpl: typeof fetch; timeoutMs?: number },
): Promise<DownloadResult> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: abort.signal, redirect: 'follow' });
    if (!response.ok) return { ok: false, reason: `download failed: HTTP ${response.status}` };
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
      return { ok: false, reason: `download failed: asset is ${declared} bytes, over the ${MAX_DOWNLOAD_BYTES} byte cap` };
    }
    if (!response.body) return { ok: false, reason: 'download failed: response had no body' };
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of response.body) {
      const buf = Buffer.from(chunk);
      total += buf.length;
      if (total > MAX_DOWNLOAD_BYTES) {
        return { ok: false, reason: `download failed: asset exceeded the ${MAX_DOWNLOAD_BYTES} byte cap` };
      }
      chunks.push(buf);
    }
    return { ok: true, bytes: Buffer.concat(chunks, total) };
  } catch (err) {
    const detail = (err as { name?: unknown } | null)?.name === 'AbortError'
      ? `timed out after ${timeoutMs}ms`
      : errorText(err);
    return { ok: false, reason: `download failed: ${detail}` };
  } finally {
    clearTimeout(timer);
  }
}

async function findBinary(dir: string, platform: string): Promise<string | null> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const nested: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      nested.push(full);
      continue;
    }
    if (entry.isFile() && isRtkBinaryName(entry.name, platform)) return full;
  }
  for (const child of nested) {
    const found = await findBinary(child, platform);
    if (found) return found;
  }
  return null;
}

async function removeQuietly(target: string): Promise<void> {
  try {
    await fsp.rm(target, { recursive: true, force: true });
  } catch {
  }
}

async function moveIntoPlace(
  source: string,
  target: string,
  renameImpl: typeof fsp.rename = fsp.rename,
): Promise<void> {
  try {
    await renameImpl(source, target);
    return;
  } catch (err) {
    if (errorCode(err) !== 'EXDEV') throw err;
  }
  const partial = `${target}.partial`;
  try {
    await fsp.copyFile(source, partial);
    await renameImpl(partial, target);
  } catch (err) {
    await removeQuietly(partial);
    throw err;
  }
  await fsp.unlink(source);
}

async function installRtk({
  homeDir = os.homedir(),
  platform = process.platform,
  arch = process.arch,
  fetchImpl = globalThis.fetch,
  execFileImpl = execFileAsync,
  renameImpl = fsp.rename,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
  log = console,
  asset = assetForPlatform(platform, arch),
}: InstallRtkOptions = {}): Promise<InstallResult> {
  if (!asset) return { ok: false, reason: `unsupported platform ${platform}-${arch}` };
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'no fetch implementation available' };

  const stagingDir = path.join(homeDir, '.glissa', 'tmp', `rtk-${crypto.randomBytes(6).toString('hex')}`);
  try {
    await fsp.mkdir(stagingDir, { recursive: true });
  } catch (err) {
    return { ok: false, reason: `could not create staging dir: ${errorText(err)}` };
  }

  try {
    log?.log?.(`[rtk] installing rtk ${asset.version} from ${asset.url}`);
    const downloaded = await downloadCapped(asset.url, { fetchImpl, timeoutMs });
    if (!downloaded.ok) return { ok: false, reason: downloaded.reason };

    const actualHex = crypto.createHash('sha256').update(downloaded.bytes).digest('hex');
    if (!verifyDigest(asset.sha256, actualHex)) {
      return { ok: false, reason: `sha256 mismatch for ${asset.file}: expected ${asset.sha256}, got ${actualHex}` };
    }

    const archivePath = path.join(stagingDir, asset.file);
    await fsp.writeFile(archivePath, downloaded.bytes);

    const extractDir = path.join(stagingDir, 'extract');
    await fsp.mkdir(extractDir, { recursive: true });
    try {
      const listing = await execFileImpl('tar', ['-tf', archivePath]);
      const escaping = findEscapingArchiveMember(listing.stdout);
      if (escaping) return { ok: false, reason: `extract refused: archive member escapes the staging dir: ${escaping}` };
      await execFileImpl('tar', ['-xf', archivePath, '-C', extractDir]);
    } catch (err) {
      const detail = errorCode(err) === 'ENOENT' ? 'tar was not found on PATH' : errorText(err);
      return { ok: false, reason: `extract failed: ${detail}` };
    }

    const extracted = await findBinary(extractDir, platform);
    if (!extracted) return { ok: false, reason: `extract failed: no rtk binary inside ${asset.file}` };

    const extractedStat = await fsp.lstat(extracted);
    if (!extractedStat.isFile()) return { ok: false, reason: `extract failed: rtk inside ${asset.file} is not a regular file` };
    if (platform !== 'win32') await fsp.chmod(extracted, 0o755);

    const target = installTargetPath(homeDir, platform);
    await fsp.mkdir(path.dirname(target), { recursive: true });

    await removeQuietly(target);
    await moveIntoPlace(extracted, target, renameImpl);

    log?.log?.(`[rtk] installed rtk ${asset.version} at ${target}`);
    return { ok: true, path: target, version: asset.version };
  } catch (err) {
    return { ok: false, reason: errorText(err) };
  } finally {
    await removeQuietly(stagingDir);
  }
}

export { DOWNLOAD_TIMEOUT_MS, MAX_DOWNLOAD_BYTES, installRtk };
export type { InstallResult, InstallRtkOptions };
