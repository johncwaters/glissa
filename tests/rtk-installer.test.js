'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { execFileAsync } = require('../server/child-process-safe');
const { installRtk, MAX_DOWNLOAD_BYTES } = require('../server/rtk-installer');

const IS_WINDOWS = process.platform === 'win32';

async function makeTempHome(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'glissa-rtk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A real tar.gz holding a nested dummy rtk, so the extract path is exercised end to end.
async function buildFixture(t, { nested = true, symlink = false } = {}) {
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

function fakeFetch(bytes, { status = 200, contentLength = null } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => (name === 'content-length' && contentLength != null ? String(contentLength) : null) },
      body: (async function* () { yield bytes; })(),
    };
  };
  impl.calls = calls;
  return impl;
}

function assetFor(sha256) {
  return { file: 'fixture.tar.gz', sha256, version: '0.45.0', url: 'https://example.invalid/fixture.tar.gz' };
}

test('installRtk verifies the pinned digest, extracts and lands the binary in ~/.glissa/bin', { skip: IS_WINDOWS }, async (t) => {
  const homeDir = await makeTempHome(t);
  const fixture = await buildFixture(t);
  const fetchImpl = fakeFetch(fixture.bytes);

  const result = await installRtk({
    homeDir,
    platform: 'linux',
    arch: 'x64',
    fetchImpl,
    asset: assetFor(fixture.sha256),
    log: { log() {}, warn() {} },
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.path, path.join(homeDir, '.glissa', 'bin', 'rtk'));
  assert.equal(result.version, '0.45.0');
  const stat = await fsp.stat(result.path);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.mode & 0o777, 0o755);
  assert.deepEqual(fetchImpl.calls, ['https://example.invalid/fixture.tar.gz']);
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
    fetchImpl: fakeFetch(fixture.bytes),
    execFileImpl: async () => { extracted = true; },
    asset: assetFor('f'.repeat(64)),
    log: { log() {}, warn() {} },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /sha256 mismatch/);
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
    fetchImpl: fakeFetch(fixture.bytes),
    execFileImpl: async () => { throw enoent; },
    asset: assetFor(fixture.sha256),
    log: { log() {}, warn() {} },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /tar was not found on PATH/);
  assert.equal(fs.existsSync(path.join(homeDir, '.glissa', 'bin', 'rtk')), false);
});

test('a non-2xx response, an unsupported platform and an over-cap content-length all fail closed', async (t) => {
  const homeDir = await makeTempHome(t);
  const notFound = await installRtk({
    homeDir, platform: 'linux', arch: 'x64',
    fetchImpl: fakeFetch(Buffer.from('nope'), { status: 404 }),
    asset: assetFor('f'.repeat(64)), log: { log() {}, warn() {} },
  });
  assert.equal(notFound.ok, false);
  assert.match(notFound.reason, /HTTP 404/);

  const unsupported = await installRtk({ homeDir, platform: 'sunos', arch: 'x64', log: { log() {}, warn() {} } });
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.reason, /unsupported platform sunos-x64/);

  const oversize = await installRtk({
    homeDir, platform: 'linux', arch: 'x64',
    fetchImpl: fakeFetch(Buffer.from('x'), { contentLength: MAX_DOWNLOAD_BYTES + 1 }),
    asset: assetFor('f'.repeat(64)), log: { log() {}, warn() {} },
  });
  assert.equal(oversize.ok, false);
  assert.match(oversize.reason, /byte cap/);
});

test('installRtk refuses an archive whose rtk entry is a symlink and lands nothing in ~/.glissa/bin', { skip: IS_WINDOWS }, async (t) => {
  const homeDir = await makeTempHome(t);
  const fixture = await buildFixture(t, { symlink: true });

  const result = await installRtk({
    homeDir,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: fakeFetch(fixture.bytes),
    asset: assetFor(fixture.sha256),
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /no rtk binary inside/);
  assert.equal(fs.existsSync(path.join(homeDir, '.glissa', 'bin', 'rtk')), false);
});
