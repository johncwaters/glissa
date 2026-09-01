import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const extensionSourceDir = path.join(repoRoot, 'tools', 'vscode-visions');

const PACKED_SIBLING_ENTRIES = new Set(['./lsp-convert.js', './visions-lsp-core.js']);

function isExternal(id: string): boolean {
  if (PACKED_SIBLING_ENTRIES.has(id)) return true;
  if (id.startsWith('.')) return false;
  return !path.isAbsolute(id);
}

function copyExtensionManifest(): Plugin {
  return {
    name: 'glissa-copy-extension-manifest',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'package.json',
        source: fs.readFileSync(path.join(extensionSourceDir, 'package.json'), 'utf8'),
      });
    },
  };
}

export default defineConfig({
  root: repoRoot,
  publicDir: false,
  plugins: [copyExtensionManifest()],
  build: {
    ssr: true,
    target: 'node18',
    outDir: path.join('dist', 'tools', 'vscode-visions'),
    emptyOutDir: false,
    minify: false,
    sourcemap: false,
    rollupOptions: {
      external: isExternal,
      input: {
        extension: path.join(extensionSourceDir, 'extension.ts'),
        'lsp-convert': path.join(extensionSourceDir, 'lsp-convert.ts'),
        'visions-lsp-core': path.join(repoRoot, 'server', 'core', 'visions-lsp-core.ts'),
      },
      output: {
        format: 'cjs',
        exports: 'auto',
        esModule: false,
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        experimentalMinChunkSize: 0,
      },
    },
  },
});
