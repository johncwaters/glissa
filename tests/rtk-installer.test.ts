import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { PathLike } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';

import { execFileAsync } from '../server/child-process-safe.ts';
import { installRtk, MAX_DOWNLOAD_BYTES } from '../server/rtk-installer.ts';
import type { InstallResult } from '../server/rtk-installer.ts';

const IS_WINDOWS = process.platform === 'win32';
const SILENT = { log() {}, warn() {} };

function refusal(result: InstallResult): string {
  if (result.ok) throw new Error('expected a refusal, the install succeeded');
  return result.reason;
}

async function makeTempHome(t: TestContext): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'glissa-rtk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A real tar.gz holding a nested dummy rtk, so the extract path is exercised end to end.
async function buildFixture(
  t: TestContext,
  { nested = true, symlink = false }: { nested?: boolean; symlink?: boolean } = {},
): Promise<{ bytes: Buffer; sha256: string }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'glissa-rtk-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const payloadRoot = path.join(dir, 'payload');
  const binaryDir = nested ? path.join(payloadRoot, 'rtk-0.45.0') : payloadRoot;
  await fsp.mkdir(binaryDir, { recursive: true });
  if (symlink) await fsp.symlink('/etc/passwd', path.join(binaryDir, 'rtk'));
  if (!symlink) await fsp.writeFile(path.join(binaryDir, 'rtk'), '#!/bin/sh\necho "rtk 0.45.0"\n');
  const archivePath = path.join(dir, 'fixture.tar.gz');
  await execFileAsync('tar', ['-czf', archivePath, '-C', payloadRoot, '.']);
  const bytes = await fsp.readFile(archivePath);
  return { bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

// A real Response, so the installer's stream read, status check and header probe run against the shape
// globalThis.fetch actually hands it.
function fakeFetch(
  bytes: Buffer,
  { status = 200, contentLength = null }: { status?: number; contentLength?: number | null } = {},
): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl: typeof fetch = async (input) => {
    calls.push(String(input));
    const headers = new Headers();
    if (contentLength != null) headers.set('content-length', String(contentLength));
    return new Response(status === 204 || status === 304 ? null : new Uint8Array(bytes), { status, headers });
  };
  return { impl, calls };
}

function assetFor(sha256: string) {
  return { file: 'fixture.tar.gz', sha256, version: '0.45.0', url: 'https://example.invalid/fixture.tar.gz' };
}

test('installRtk verifies the pinned digest, extracts and lands the binary in ~/.glissa/bin', { skip: IS_WINDOWS }, async (t) => {
  const homeDir = await makeTempHome(t);
  const fixture = await buildFixture(t);
  const { impl, calls } = fakeFetch(fixture.bytes);

  const result = await installRtk({
    homeDir,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: impl,
    asset: assetFor(fixture.sha256),
    log: SILENT,
  });

  assert.ok(result.ok, 'the install succeeded');
  assert.equal(result.path, path.join(homeDir, '.glissa', 'bin', 'rtk'));
  assert.equal(result.version, '0.45.0');
  const stat = await fsp.stat(result.path);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.mode & 0o777, 0o755);
  assert.deepEqual(calls, ['https://example.invalid/fixture.tar.gz']);
  assert.equal(fs.existsSync(path.join(homeDir, '.glissa', 'tmp')), true);
  assert.deepEqual(await fsp.readdir(path.join(homeDir, '.glissa', 'tmp')), []);
});

test('a digest mismatch lands nothing in bin and never extracts', { skip: IS_WINDOWS }, async (t) => {
  const homeDir = await makeTempHome(t);
  const fixture = await buildFixture(t);
  let extracted = false;

  const result = await installRtk({
    homeDir,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: fakeFetch(fixture.bytes).impl,
    execFileImpl: async () => {
      extracted = true;
      return { stdout: '', stderr: '' };
    },
    asset: assetFor('f'.repeat(64)),
    log: SILENT,
  });

  assert.equal(result.ok, false);
  assert.match(refusal(result), /sha256 mismatch/);
  assert.equal(extracted, false);
  assert.equal(fs.existsSync(path.join(homeDir, '.glissa', 'bin', 'rtk')), false);
  assert.deepEqual(await fsp.readdir(path.join(homeDir, '.glissa', 'tmp')), []);
});

test('a missing tar fails with a reason instead of crashing', { skip: IS_WINDOWS }, async (t) => {
  const homeDir = await makeTempHome(t);
  const fixture = await buildFixture(t);
  const enoent = Object.assign(new Error('spawn tar ENOENT'), { code: 'ENOENT' });

  const result = await installRtk({
    homeDir,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: fakeFetch(fixture.bytes).impl,
    execFileImpl: async () => { throw enoent; },
    asset: assetFor(fixture.sha256),
    log: SILENT,
  });

  assert.equal(result.ok, false);
  assert.match(refusal(result), /tar was not found on PATH/);
  assert.equal(fs.existsSync(path.join(homeDir, '.glissa', 'bin', 'rtk')), false);
});

test('a non-2xx response, an unsupported platform and an over-cap content-length all fail closed', async (t) => {
  const homeDir = await makeTempHome(t);
  const notFound = await installRtk({
    homeDir,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: fakeFetch(Buffer.from('nope'), { status: 404 }).impl,
    asset: assetFor('f'.repeat(64)),
    log: SILENT,
  });
  assert.equal(notFound.ok, false);
  assert.match(refusal(notFound), /HTTP 404/);

  const unsupported = await installRtk({ homeDir, platform: 'sunos', arch: 'x64', log: SILENT });
  assert.equal(unsupported.ok, false);
  assert.match(refusal(unsupported), /unsupported platform sunos-x64/);

  const oversize = await installRtk({
    homeDir,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: fakeFetch(Buffer.from('x'), { contentLength: MAX_DOWNLOAD_BYTES + 1 }).impl,
    asset: assetFor('f'.repeat(64)),
    log: SILENT,
  });
  assert.equal(oversize.ok, false);
  assert.match(refusal(oversize), /byte cap/);
});

test('installRtk refuses an archive whose rtk entry is a symlink and lands nothing in ~/.glissa/bin', { skip: IS_WINDOWS }, async (t) => {
  const homeDir = await makeTempHome(t);
  const fixture = await buildFixture(t, { symlink: true });

  const result = await installRtk({
    homeDir,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: fakeFetch(fixture.bytes).impl,
    asset: assetFor(fixture.sha256),
  });

  assert.equal(result.ok, false);
  assert.match(refusal(result), /no rtk binary inside/);
  assert.equal(fs.existsSync(path.join(homeDir, '.glissa', 'bin', 'rtk')), false);
});

test('installRtk refuses an archive listing a member outside the staging dir before extracting', async (t) => {
  const homeDir = await makeTempHome(t);
  const fixture = await buildFixture(t);
  let extracted = false;
  const execFileImpl = async (_file: string, ...rest: unknown[]) => {
    const args = rest[0];
    if (Array.isArray(args) && args[0] === '-tf') return { stdout: './rtk\n../escape\n', stderr: '' };
    extracted = true;
    return { stdout: '', stderr: '' };
  };

  const result = await installRtk({
    homeDir,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: fakeFetch(fixture.bytes).impl,
    execFileImpl,
    asset: assetFor(fixture.sha256),
  });

  assert.equal(result.ok, false);
  assert.match(refusal(result), /escapes the staging dir: \.\.\/escape/);
  assert.equal(extracted, false);
  assert.equal(fs.existsSync(path.join(homeDir, '.glissa', 'bin', 'rtk')), false);
});

test('installRtk completes through the copy path when the cross-device rename is refused', { skip: IS_WINDOWS }, async (t) => {
  const homeDir = await makeTempHome(t);
  const fixture = await buildFixture(t);
  let refusedOnce = false;
  const renameImpl = async (source: PathLike, target: PathLike) => {
    if (!refusedOnce && !String(source).endsWith('.partial')) {
      refusedOnce = true;
      throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
    }
    return fsp.rename(source, target);
  };

  const result = await installRtk({
    homeDir,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: fakeFetch(fixture.bytes).impl,
    renameImpl,
    asset: assetFor(fixture.sha256),
  });

  assert.equal(result.ok, true);
  const target = path.join(homeDir, '.glissa', 'bin', 'rtk');
  assert.equal(refusedOnce, true);
  assert.equal(fs.existsSync(target), true);
  assert.equal(fs.existsSync(`${target}.partial`), false);
  assert.equal(await fsp.readFile(target, 'utf8'), '#!/bin/sh\necho "rtk 0.45.0"\n');
});
