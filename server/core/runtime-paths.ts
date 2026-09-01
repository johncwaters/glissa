// One derivation of "where do my own files live", because the same module runs from two layouts: a dev
// checkout (source .ts beside the package root) and the published package (bundled .js under dist/).

import path from 'node:path';

export interface RuntimePaths {
  packageRoot: string;
  bundled: boolean;
  assetRoot: string;
  clientDir: string;
  extensionDir: string;
  packsDir: string;
  cliPath: string;
  relayPath: (relayName: string) => string;
}

export interface RuntimePathsInput {
  moduleFile: string;
  hasPackageJson: (directory: string) => boolean;
}

function isUnder(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  if (relative === '' || relative.startsWith('..')) return false;
  return !path.isAbsolute(relative);
}

function findPackageRoot(startDirectory: string, hasPackageJson: (directory: string) => boolean): string {
  let directory = startDirectory;
  for (;;) {
    if (hasPackageJson(directory)) return directory;
    const parent = path.dirname(directory);
    // No package.json anywhere above: fall back to the source-layout guess every call site used before.
    if (parent === directory) return path.resolve(startDirectory, '..');
    directory = parent;
  }
}

function computeRuntimePaths({ moduleFile, hasPackageJson }: RuntimePathsInput): RuntimePaths {
  const packageRoot = findPackageRoot(path.dirname(path.resolve(moduleFile)), hasPackageJson);
  const distDir = path.join(packageRoot, 'dist');
  const bundled = isUnder(path.resolve(moduleFile), distDir);
  const assetRoot = bundled ? distDir : packageRoot;
  const sourceExtension = bundled ? '.js' : '.ts';
  return {
    packageRoot,
    bundled,
    assetRoot,
    clientDir: path.join(distDir, 'client'),
    extensionDir: path.join(assetRoot, 'tools', 'vscode-visions'),
    packsDir: path.join(assetRoot, 'packs'),
    cliPath: path.join(assetRoot, 'bin', `glissa${sourceExtension}`),
    relayPath: (relayName: string) => path.join(assetRoot, 'session', `${relayName}${sourceExtension}`),
  };
}

export { computeRuntimePaths, findPackageRoot, isUnder };
