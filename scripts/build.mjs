import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(repoRoot, 'dist');

const REQUIRED_OUTPUTS = [
  'client/index.html',
  'server/index.js',
  'bin/glissa.js',
  'session/hook-relay.js',
  'session/statusline-relay.js',
  'session/rtk-relay.js',
  'session/visions-relay.js',
  'scripts/postinstall-path-check.js',
  'tools/vscode-visions/extension.js',
  'tools/vscode-visions/lsp-convert.js',
  'tools/vscode-visions/visions-lsp-core.js',
  'tools/vscode-visions/package.json',
  'packs/specs/memory.pack.json',
];

function fail(message) {
  console.error(`build: ${message}`);
  process.exit(1);
}

function nodeOutputFiles(directory, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'client') nodeOutputFiles(absolutePath, found);
      continue;
    }
    if (entry.name.endsWith('.js')) found.push(absolutePath);
  }
  return found;
}

function assertImportMetaSurvived() {
  const resolvers = nodeOutputFiles(distDir)
    .map((filePath) => ({ filePath, source: fs.readFileSync(filePath, 'utf8') }))
    .filter((file) => file.source.includes('computeRuntimePaths('));
  if (resolvers.length === 0) fail('no dist/ output calls computeRuntimePaths: the runtime path resolver was tree-shaken away');
  for (const resolver of resolvers) {
    if (resolver.source.includes('import.meta.url')) continue;
    fail(`${path.relative(distDir, resolver.filePath)} calls computeRuntimePaths with no import.meta.url left: the ES-format SSR output rewrote it`);
  }
}

fs.rmSync(distDir, { recursive: true, force: true });

await build({ configFile: path.join(repoRoot, 'vite.config.ts') });
await build({ configFile: path.join(repoRoot, 'vite.server.config.ts') });
assertImportMetaSurvived();
await build({ configFile: path.join(repoRoot, 'vite.extension.config.ts') });

fs.writeFileSync(path.join(distDir, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`);

const missing = REQUIRED_OUTPUTS.filter((relativePath) => !fs.existsSync(path.join(distDir, relativePath)));
if (missing.length > 0) fail(`missing from dist/: ${missing.join(', ')}`);

console.log(`build: dist/ complete (${REQUIRED_OUTPUTS.length} load-bearing outputs present)`);
