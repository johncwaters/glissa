'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { renderSharedCjsEsm } = require('./core/shared-cjs-esm-core');
const { BROWSER_MODULES, browserModuleById, renderConstantsModule, sharedContractSpecifier } = require('./core/browser-modules-core');

const repoRoot = path.join(__dirname, '..');

// The one renderer behind both delivery paths. The Express route and the Vite plugin used to hold a
// generator each, and a module reaching the browser on one path but not the other shipped; sharing this
// makes that divergence unrepresentable rather than merely tested.
function renderBrowserModule(moduleId, { zodSpecifier }) {
  const entry = browserModuleById(moduleId);
  if (!entry) throw new Error(`Unknown browser module ${moduleId}`);
  const absolute = path.join(repoRoot, entry.source);
  if (entry.kind === 'esm-file') return fs.readFileSync(absolute, 'utf8');
  if (entry.kind === 'constants') return renderConstantsModule(require(absolute));
  return renderSharedCjsEsm(fs.readFileSync(absolute, 'utf8'), (specifier) =>
    sharedContractSpecifier(specifier, { zodSpecifier }));
}

// Vite bundles zod from node_modules; the no-build server serves the package directory over HTTP, so
// that specifier is the only thing the two paths are allowed to disagree about.
const VITE_VIRTUAL_PREFIX = '\0glissa:browser-module:';

function browserModulesVitePlugin() {
  return {
    name: 'glissa-browser-modules',
    enforce: 'pre',
    resolveId(source) {
      return browserModuleById(source) ? `${VITE_VIRTUAL_PREFIX}${source}` : null;
    },
    load(id) {
      if (!id.startsWith(VITE_VIRTUAL_PREFIX)) return null;
      return renderBrowserModule(id.slice(VITE_VIRTUAL_PREFIX.length), { zodSpecifier: 'zod' });
    },
  };
}

function mountBrowserModuleRoutes(app) {
  for (const entry of BROWSER_MODULES) {
    app.get(entry.id, (_req, res) => {
      res.type('application/javascript');
      res.send(renderBrowserModule(entry.id, { zodSpecifier: '/zod/index.js' }));
    });
  }
}

module.exports = { browserModulesVitePlugin, mountBrowserModuleRoutes, renderBrowserModule };
