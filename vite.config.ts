import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import type { Plugin, ViteDevServer } from 'vite';

type GlissaBackend = ReturnType<typeof import('./server/backend.ts').createBackend>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = require('./package.json') as { version: string };

function glissaBackendPlugin(): Plugin {
  let backend: GlissaBackend | null = null;

  return {
    name: 'glissa-backend',
    configureServer(server: ViteDevServer) {
      const httpServer = server.httpServer;
      if (!(httpServer instanceof http.Server)) throw new Error('The Glissa dev backend needs Vite\'s plain HTTP server; middleware mode and HTTP/2 have none.');
      const { createBackend } = require('./server/backend.ts') as typeof import('./server/backend.ts');
      backend = createBackend(httpServer, {
        staticDir: null,
        settingsDefaults: { debugMode: true },
        onRestart: () => {
          console.log('Restart requested - restarting Vite server...');
          server.restart();
        },
      });
      server.middlewares.use(backend.app);

      httpServer.on('close', () => {
        if (backend) backend.shutdown();
      });

      process.on('SIGINT', () => {
        if (backend) backend.shutdown();
      });
    },
  };
}

export default defineConfig({
  plugins: [
    tailwindcss(),
    glissaBackendPlugin(),
  ],

  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },

  root: 'public',

  publicDir: '../assets',

  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
  },

  server: {
    fs: {
      allow: [__dirname],
    },
    host: '127.0.0.1',
    port: 5173,
  },
});
