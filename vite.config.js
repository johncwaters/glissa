import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function glissaBackendPlugin() {
  let backend = null;

  return {
    name: 'glissa-backend',
    configureServer(server) {
      const { createBackend } = require('./backend');
      backend = createBackend(server.httpServer, {
        staticDir: null,
        onRestart: () => {
          console.log('Restart requested — restarting Vite server...');
          server.restart();
        },
      });
      server.middlewares.use(backend.app);

      server.httpServer.on('close', () => {
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
  plugins: [tailwindcss(), glissaBackendPlugin()],

  root: 'public',

  resolve: {
    alias: {
      '/shared/states.mjs': path.resolve(__dirname, 'shared/states.esm.js'),
    },
  },

  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },

  server: {
    port: 5173,
  },
});
