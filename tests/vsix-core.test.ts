import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildVsix, buildZip, crc32, extensionIdOf, vsixManifestXml } from '../server/core/vsix-core.ts';

const MANIFEST = {
  name: 'glissa-visions',
  publisher: 'johnwaters',
  version: '0.2.0',
  displayName: 'Glissa Visions',
  description: 'Mirrors markdown buffers',
  engines: { vscode: '^1.85.0' },
};

function entryNames(zip: Buffer) {
  const names: string[] = [];
  let offset = 0;
  while (offset < zip.length - 4) {
    if (zip.readUInt32LE(offset) !== 0x04034b50) break;
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const size = zip.readUInt32LE(offset + 18);
    names.push(zip.subarray(offset + 30, offset + 30 + nameLength).toString('utf8'));
    offset += 30 + nameLength + extraLength + size;
  }
  return names;
}

test('crc32 matches the known check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('buildZip lays entries out in order and unzip accepts the archive', () => {
  const zip = buildZip([
    { path: 'a.txt', data: 'alpha' },
    { path: 'nested/b.txt', data: Buffer.from('beta') },
  ]);
  assert.deepEqual(entryNames(zip), ['a.txt', 'nested/b.txt']);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-zip-'));
  const archive = path.join(dir, 'out.zip');
  fs.writeFileSync(archive, zip);
  execFileSync('unzip', ['-o', '-q', archive, '-d', dir]);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'alpha');
  assert.equal(fs.readFileSync(path.join(dir, 'nested', 'b.txt'), 'utf8'), 'beta');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildVsix carries the OPC layout the editor CLI expects', () => {
  const vsix = buildVsix({ manifest: MANIFEST, extensionFiles: [{ path: 'extension.js', data: 'module.exports = {};' }] });
  assert.deepEqual(entryNames(vsix), ['extension.vsixmanifest', '[Content_Types].xml', 'extension/extension.js']);
});

test('the vsix manifest names the identity the editor installs under', () => {
  const xml = vsixManifestXml({
    id: MANIFEST.name,
    publisher: MANIFEST.publisher,
    version: MANIFEST.version,
    displayName: MANIFEST.displayName,
    description: MANIFEST.description,
    engine: MANIFEST.engines.vscode,
  });
  assert.match(xml, /Id="glissa-visions"/);
  assert.match(xml, /Publisher="johnwaters"/);
  assert.match(xml, /Version="0\.2\.0"/);
  assert.match(xml, /Microsoft\.VisualStudio\.Code\.Engine" Value="\^1\.85\.0"/);
  assert.equal(extensionIdOf(MANIFEST), 'johnwaters.glissa-visions');
});

test('escaping keeps a quote in the description from breaking the manifest', () => {
  const xml = vsixManifestXml({
    id: 'x', publisher: 'p', version: '1.0.0', displayName: 'X', description: 'a "quoted" <tag> & more', engine: '*',
  });
  assert.match(xml, /a &quot;quoted&quot; &lt;tag&gt; &amp; more/);
});

test('the packed extension is byte-identical across builds', () => {
  const first = buildVsix({ manifest: MANIFEST, extensionFiles: [{ path: 'extension.js', data: 'x' }] });
  const second = buildVsix({ manifest: MANIFEST, extensionFiles: [{ path: 'extension.js', data: 'x' }] });
  assert.deepEqual(first, second);
});
