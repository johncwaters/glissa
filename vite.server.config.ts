// The node half of the build: every process the published package starts (the server, the CLI, the four
// relays, the postinstall notice) becomes one bundled ES module under dist/, because Node refuses to
// strip types inside node_modules and an installed package is nothing but node_modules.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

// Anything not resolved out of this repo stays a runtime import: node builtins, node-pty's native
// binding, and every dependency npm already installed beside the package.
function isExternal(id: string): boolean {
  if (id.startsWith('#')) return false;
  if (id.startsWith('.')) return false;
  return !path.isAbsolute(id);
}

function copyPackSpecs(): Plugin {
  const specsDir = path.join(repoRoot, 'packs', 'specs');
  return {
    name: 'glissa-copy-pack-specs',
    generateBundle() {
      for (const entry of fs.readdirSync(specsDir)) {
        if (!entry.endsWith('.pack.json')) continue;
        this.emitFile({
          type: 'asset',
          fileName: path.posix.join('packs', 'specs', entry),
          source: fs.readFileSync(path.join(specsDir, entry), 'utf8'),
        });
      }
    },
  };
}

export default defineConfig({
  root: repoRoot,
  publicDir: false,
  plugins: [copyPackSpecs()],
  resolve: {
    alias: [{ find: /^#shared\//, replacement: `${path.join(repoRoot, 'shared')}/` }],
  },
  build: {
    ssr: true,
    target: 'node22',
    outDir: 'dist',
    emptyOutDir: false,
    minify: false,
    sourcemap: false,
    rollupOptions: {
      external: isExternal,
      input: {
        'server/index': path.join(repoRoot, 'server', 'main.ts'),
        'bin/glissa': path.join(repoRoot, 'bin', 'glissa.ts'),
        'session/hook-relay': path.join(repoRoot, 'session', 'hook-relay.ts'),
        'session/statusline-relay': path.join(repoRoot, 'session', 'statusline-relay.ts'),
        'session/rtk-relay': path.join(repoRoot, 'session', 'rtk-relay.ts'),
        'session/visions-relay': path.join(repoRoot, 'session', 'visions-relay.ts'),
        'scripts/postinstall-path-check': path.join(repoRoot, 'scripts', 'postinstall-path-check.ts'),
      },
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        // A relay is run once per hook and must stay cheap to load, so nothing gets merged into it.
        experimentalMinChunkSize: 0,
      },
    },
  },
});
