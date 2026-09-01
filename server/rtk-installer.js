'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { execFileAsync } = require('./child-process-safe');
const {
  assetForPlatform,
  installTargetPath,
  isRtkBinaryName,
  verifyDigest,
  findEscapingArchiveMember,
} = require('./core/rtk-install-core.ts');

const DOWNLOAD_TIMEOUT_MS = 60000;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

async function downloadCapped(url, { fetchImpl, timeoutMs = DOWNLOAD_TIMEOUT_MS }) {
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
    /** @type {Buffer[]} */
    const chunks = [];
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
    const detail = err?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : (err?.message || String(err));
    return { ok: false, reason: `download failed: ${detail}` };
  } finally {
    clearTimeout(timer);
  }
}

async function findBinary(dir, platform) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const nested = [];
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

async function moveIntoPlace(source, target, renameImpl = fsp.rename) {
  try {
    await renameImpl(source, target);
    return;
  } catch (err) {
    if (err?.code !== 'EXDEV') throw err;
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

async function removeQuietly(target) {
  try {
    await fsp.rm(target, { recursive: true, force: true });
  } catch {
    // best-effort temp cleanup: a leftover file must never turn a successful install into a failure
  }
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
} = {}) {
  if (!asset) return { ok: false, reason: `unsupported platform ${platform}-${arch}` };
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'no fetch implementation available' };

  const stagingDir = path.join(homeDir, '.glissa', 'tmp', `rtk-${crypto.randomBytes(6).toString('hex')}`);
  try {
    await fsp.mkdir(stagingDir, { recursive: true });
  } catch (err) {
    return { ok: false, reason: `could not create staging dir: ${err?.message || String(err)}` };
  }

  try {
    log?.log?.(`[rtk] installing rtk ${asset.version} from ${asset.url}`);
    const downloaded = await downloadCapped(asset.url, { fetchImpl, timeoutMs });
    if (!downloaded.ok || !downloaded.bytes) return { ok: false, reason: downloaded.reason };

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
      const detail = err?.code === 'ENOENT' ? 'tar was not found on PATH' : (err?.message || String(err));
      return { ok: false, reason: `extract failed: ${detail}` };
    }

    const extracted = await findBinary(extractDir, platform);
    if (!extracted) return { ok: false, reason: `extract failed: no rtk binary inside ${asset.file}` };

    const extractedStat = await fsp.lstat(extracted);
    if (!extractedStat.isFile()) return { ok: false, reason: `extract failed: rtk inside ${asset.file} is not a regular file` };
    if (platform !== 'win32') await fsp.chmod(extracted, 0o755);

    const target = installTargetPath(homeDir, platform);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    // Windows rename refuses an existing destination, so clear it first.
    await removeQuietly(target);
    await moveIntoPlace(extracted, target, renameImpl);

    log?.log?.(`[rtk] installed rtk ${asset.version} at ${target}`);
    return { ok: true, path: target, version: asset.version };
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) };
  } finally {
    await removeQuietly(stagingDir);
  }
}

module.exports = { installRtk, DOWNLOAD_TIMEOUT_MS, MAX_DOWNLOAD_BYTES };
