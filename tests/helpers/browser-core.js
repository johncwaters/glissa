'use strict';

/*
 * A public/ ESM core that imports a declared browser module, loaded the way the browser gets it. Node
 * resolves a `/shared/...` specifier against the filesystem root, so the specifier is rewritten to a
 * data URL carrying exactly what the two delivery paths render (server/browser-modules.js).
 */

const fs = require('node:fs');
const path = require('node:path');

const { BROWSER_MODULE_IDS } = require('../../server/core/browser-modules-core');
const { renderBrowserModule } = require('../../server/browser-modules');

const repoRoot = path.join(__dirname, '..', '..');

function dataUrlOf(source) {
  return `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
}

function importBrowserCore(relativePath) {
  let source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
  for (const moduleId of BROWSER_MODULE_IDS) {
    if (!source.includes(moduleId)) continue;
    source = source.split(`'${moduleId}'`).join(`'${dataUrlOf(renderBrowserModule(moduleId, { zodSpecifier: 'zod' }))}'`);
  }
  return import(dataUrlOf(source));
}

module.exports = { importBrowserCore };
