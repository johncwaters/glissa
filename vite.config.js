import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = require('./package.json');

// The browser's ESM view of shared/states.js, generated from the CJS module rather than kept as a
// hand-copied twin. Mirrors the /shared/states.mjs route in server/backend.js (the no-build path), and
// works only because that module exports nothing but constants.
const STATES_MODULE_ID = '/shared/states.mjs';
const STATES_VIRTUAL_ID = '\0glissa:shared-states';
const SETTINGS_RANGES_MODULE_ID = '/shared/settings-ranges.mjs';
const SETTINGS_RANGES_VIRTUAL_ID = '\0glissa:shared-settings-ranges';

function glissaSharedStatesPlugin() {
  return {
    name: 'glissa-shared-states',
    enforce: 'pre',
    resolveId(source) {
      return source === STATES_MODULE_ID ? STATES_VIRTUAL_ID : null;
    },
    load(id) {
      if (id !== STATES_VIRTUAL_ID) return null;
      const states = require('./shared/states');
      return Object.entries(states)
        .map(([key, val]) => `export const ${key} = ${JSON.stringify(val)};`)
        .join('\n');
    },
  };
}

function glissaSharedSettingsRangesPlugin() {
  return {
    name: 'glissa-shared-settings-ranges',
    enforce: 'pre',
    resolveId(source) {
      return source === SETTINGS_RANGES_MODULE_ID ? SETTINGS_RANGES_VIRTUAL_ID : null;
    },
    load(id) {
      if (id !== SETTINGS_RANGES_VIRTUAL_ID) return null;
      const ranges = require('./shared/settings-ranges');
      return Object.entries(ranges)
        .map(([key, val]) => `export const ${key} = ${JSON.stringify(val)};`)
        .join('\n');
    },
  };
}

function glissaBackendPlugin() {
  let backend = null;

  return {
    name: 'glissa-backend',
    configureServer(server) {
      const { createBackend } = require('./server/backend');
      backend = createBackend(server.httpServer, {
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
  plugins: [tailwindcss(), glissaSharedStatesPlugin(), glissaSharedSettingsRangesPlugin(), glissaBackendPlugin()],

  // Bake the package version in at build time so the dashboard's help surface can show what is running.
  // Replaced as a string literal in both dev and the dist bundle; the browser never reads package.json.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },

  root: 'public',

  resolve: {
    alias: {
      '/shared/client-trust.mjs': path.resolve(__dirname, 'shared/client-trust.esm.js'),
    },
  },

  publicDir: '../assets',

  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },

  server: {
    // Bind IPv4 loopback explicitly. Vite's default `localhost` resolves to ::1
    // (IPv6) on Windows, but settings-injector writes hook URLs as http://127.0.0.1
    // (IPv4) and server.js binds 127.0.0.1 in production. Without this, Glissa's
    // injected HTTP hooks hit IPv4 loopback with nothing listening -> ECONNREFUSED.
    host: '127.0.0.1',
    port: 5173,
  },
});
