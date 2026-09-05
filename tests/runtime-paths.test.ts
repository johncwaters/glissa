import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.join(import.meta.dirname, '..');
import test from 'node:test';

import { computeRuntimePaths } from '../server/core/runtime-paths.ts';

const PACKAGE_ROOT = path.join(path.sep, 'opt', 'glissa');

function onlyRootHasPackageJson(directory: string): boolean {
  return directory === PACKAGE_ROOT;
}

test('a source checkout resolves relays, packs and the CLI as .ts beside the package root', () => {
  const paths = computeRuntimePaths({
    moduleFile: path.join(PACKAGE_ROOT, 'server', 'runtime-paths.ts'),
    hasPackageJson: onlyRootHasPackageJson,
  });

  assert.equal(paths.packageRoot, PACKAGE_ROOT);
  assert.equal(paths.bundled, false);
  assert.equal(paths.assetRoot, PACKAGE_ROOT);
  assert.equal(paths.packsDir, path.join(PACKAGE_ROOT, 'packs'));
  assert.equal(paths.extensionDir, path.join(PACKAGE_ROOT, 'tools', 'vscode-visions'));
  assert.equal(paths.cliPath, path.join(PACKAGE_ROOT, 'bin', 'glissa.ts'));
  assert.equal(paths.relayPath('hook-relay'), path.join(PACKAGE_ROOT, 'session', 'hook-relay.ts'));
});

test('a bundled install resolves the same assets as .js under dist', () => {
  const paths = computeRuntimePaths({
    moduleFile: path.join(PACKAGE_ROOT, 'dist', 'server', 'index.js'),
    hasPackageJson: onlyRootHasPackageJson,
  });

  assert.equal(paths.packageRoot, PACKAGE_ROOT);
  assert.equal(paths.bundled, true);
  assert.equal(paths.assetRoot, path.join(PACKAGE_ROOT, 'dist'));
  assert.equal(paths.packsDir, path.join(PACKAGE_ROOT, 'dist', 'packs'));
  assert.equal(paths.extensionDir, path.join(PACKAGE_ROOT, 'dist', 'tools', 'vscode-visions'));
  assert.equal(paths.cliPath, path.join(PACKAGE_ROOT, 'dist', 'bin', 'glissa.js'));
  assert.equal(paths.relayPath('visions-relay'), path.join(PACKAGE_ROOT, 'dist', 'session', 'visions-relay.js'));
});

test('the dashboard build is always read from dist/client, bundled or not', () => {
  const fromSource = computeRuntimePaths({
    moduleFile: path.join(PACKAGE_ROOT, 'server', 'backend-http.ts'),
    hasPackageJson: onlyRootHasPackageJson,
  });
  const fromBundle = computeRuntimePaths({
    moduleFile: path.join(PACKAGE_ROOT, 'dist', 'chunks', 'shared-abc123.js'),
    hasPackageJson: onlyRootHasPackageJson,
  });

  assert.equal(fromSource.clientDir, path.join(PACKAGE_ROOT, 'dist', 'client'));
  assert.equal(fromBundle.clientDir, path.join(PACKAGE_ROOT, 'dist', 'client'));
  assert.equal(fromBundle.bundled, true, 'a shared chunk under dist is still a bundled layout');
});

test('a module with no package.json above it falls back to the parent of its own directory', () => {
  const paths = computeRuntimePaths({
    moduleFile: path.join(path.sep, 'tmp', 'loose', 'server', 'runtime-paths.ts'),
    hasPackageJson: () => false,
  });

  assert.equal(paths.packageRoot, path.join(path.sep, 'tmp', 'loose'));
  assert.equal(paths.bundled, false);
});

test('the emitted dist manifest never carries a name, which would hijack the package-root walk', () => {
  const buildSource = fs.readFileSync(path.join(repoRoot, 'scripts', 'build.mjs'), 'utf8');
  const manifestWrite = buildSource.match(/writeFileSync\([^;]*dist[^;]*package\.json[^;]*;/);
  assert.ok(manifestWrite, 'scripts/build.mjs writes dist/package.json');
  assert.ok(!manifestWrite[0].includes('name'), 'the dist manifest stays nameless so findPackageRoot cannot stop at dist/');
  const distManifestPath = path.join(repoRoot, 'dist', 'package.json');
  if (!fs.existsSync(distManifestPath)) return;
  const distManifest = JSON.parse(fs.readFileSync(distManifestPath, 'utf8')) as { name?: string; type?: string };
  assert.equal(distManifest.name, undefined);
  assert.equal(distManifest.type, 'module');
});

test('the built server entry recovers a half-finished handoff before any dependency loads', () => {
  const entrySource = fs.readFileSync(path.join(repoRoot, 'server', 'index.ts'), 'utf8');
  assert.match(entrySource, /^import \{ recoverHandoff \} from '\.\.\/scripts\/recover-handoff\.mjs';$/m);
  assert.match(entrySource, /recoverHandoff\(packageRoot\);/);
  assert.match(entrySource, /await import\('\.\/main\.ts'\);/);
  assert.ok(!/^import .* from '\.\/main\.ts';$/m.test(entrySource), 'the real server loads only after recovery, so it cannot be a static import');

  const buildConfig = fs.readFileSync(path.join(repoRoot, 'vite.server.config.ts'), 'utf8');
  assert.match(buildConfig, /'server\/index': path\.join\(repoRoot, 'server', 'index\.ts'\)/);

  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
    files: string[];
  };
  assert.equal(manifest.scripts.start, 'node dist/server/index.js');
  assert.ok(manifest.files.includes('scripts/recover-handoff.mjs'), 'the shim ships with the package');
});

test('the shipped launcher starts the server through the recovering bootstrap', () => {
  const launcherSource = fs.readFileSync(path.join(repoRoot, 'bin', 'glissa.ts'), 'utf8');
  assert.match(launcherSource, /await import\('\.\.\/server\/index\.ts'\);/);
  assert.ok(!/['"]\.\.\/server\/main\.ts['"]/.test(launcherSource), 'the launcher never reaches main ahead of recovery');
});

