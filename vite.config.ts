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
        // Dev sessions are the ones being debugged, so the debug button and health panel default
        // on here. Fallback only: nothing is written to config.json, and an explicit debugMode key
        // (or a settings save from the dashboard) still wins.
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

      // Defensive: ensure PTY cleanup even if Vite exits abruptly
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

  // Bake the package version in at build time so the dashboard's help surface can show what is running.
  // Replaced as a string literal in both dev and the dist bundle; the browser never reads package.json.
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
    // The dashboard imports shared/ through the package imports map (#shared/*), which lives
    // outside the Vite root (public/), so the repo root must be servable in dev.
    fs: {
      allow: [__dirname],
    },
    // Bind IPv4 loopback explicitly. Vite's default `localhost` resolves to ::1
    // (IPv6) on Windows, but settings-injector writes hook URLs as http://127.0.0.1
    // (IPv4) and server/main.ts binds 127.0.0.1 in production. Without this, Glissa's
    // injected HTTP hooks hit IPv4 loopback with nothing listening -> ECONNREFUSED.
    host: '127.0.0.1',
    port: 5173,
  },
});
