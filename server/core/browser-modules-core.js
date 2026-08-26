'use strict';

// Every module id the browser can import from outside its own tree. The no-build server route table
// and the Vite plugin both derive from this list, so a module served by one and not the other cannot
// exist; tests/browser-modules.test.js pins that both honour every id.
const BROWSER_MODULES = Object.freeze([
  Object.freeze({ id: '/shared/control-messages.mjs', kind: 'cjs-esm', source: 'shared/contracts/control-messages.js' }),
  Object.freeze({ id: '/shared/session.mjs', kind: 'cjs-esm', source: 'shared/contracts/session.js' }),
  Object.freeze({ id: '/shared/states.mjs', kind: 'constants', source: 'shared/states.js' }),
  Object.freeze({ id: '/shared/settings-ranges.mjs', kind: 'constants', source: 'shared/settings-ranges.js' }),
  Object.freeze({ id: '/shared/client-trust.mjs', kind: 'esm-file', source: 'shared/client-trust.esm.mjs' }),
]);

const BROWSER_MODULE_IDS = Object.freeze(BROWSER_MODULES.map((entry) => entry.id));

function browserModuleById(moduleId) {
  return BROWSER_MODULES.find((entry) => entry.id === moduleId) || null;
}

// The CJS contracts reach the browser through renderSharedCjsEsm, which needs every bare require in
// them rewritten to something the browser can fetch. Vite bundles zod from node_modules; the no-build
// server serves the package directory itself, so only that one specifier differs between the two.
function sharedContractSpecifier(specifier, { zodSpecifier }) {
  if (specifier === 'zod') return zodSpecifier;
  if (specifier === './session') return '/shared/session.mjs';
  if (specifier === '../states') return '/shared/states.mjs';
  throw new Error(`Unsupported shared contract import ${specifier}`);
}

// states.js and settings-ranges.js may export constants only: both renderers serialize with
// JSON.stringify, so a function added there would reach the browser as undefined.
function renderConstantsModule(moduleExports) {
  return Object.entries(moduleExports)
    .map(([key, value]) => `export const ${key} = ${JSON.stringify(value)};`)
    .join('\n');
}

module.exports = {
  BROWSER_MODULES,
  BROWSER_MODULE_IDS,
  browserModuleById,
  renderConstantsModule,
  sharedContractSpecifier,
};
