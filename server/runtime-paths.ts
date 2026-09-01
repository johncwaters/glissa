// The one fs probe behind server/core/runtime-paths.ts, resolved once per process.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeRuntimePaths } from './core/runtime-paths.ts';
import type { RuntimePaths } from './core/runtime-paths.ts';

// A manifest, not just a file: dist/ carries a bare {"type":"module"} so Node reads the bundle as ESM,
// and stopping the walk there would make dist/ look like the package root.
function hasPackageManifest(directory: string): boolean {
  try {
    const doc: unknown = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    if (typeof doc !== 'object' || doc === null || !('name' in doc)) return false;
    return typeof doc.name === 'string';
  } catch {
    return false;
  }
}

const runtimePaths: RuntimePaths = computeRuntimePaths({
  moduleFile: fileURLToPath(import.meta.url),
  hasPackageJson: hasPackageManifest,
});

const { assetRoot, bundled, cliPath, clientDir, extensionDir, packageRoot, packsDir, relayPath } = runtimePaths;

export { assetRoot, bundled, cliPath, clientDir, extensionDir, packageRoot, packsDir, relayPath, runtimePaths };
