'use strict';

// The browser can import five modules from outside public/. Each is served twice: by the Vite plugin
// for a bundled build, and by an Express route for the no-build path. They used to be two hand-written
// lists, and a contracts module reached the browser on one path and 404'd on the other. Both now derive
// from server/core/browser-modules-core.js; this pins that a public/ import cannot outrun either.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');

const { BROWSER_MODULES, BROWSER_MODULE_IDS } = require('../server/core/browser-modules-core');
const { browserModulesVitePlugin, renderBrowserModule } = require('../server/browser-modules');
const { mountDevRoutes } = require('../server/backend-http');

const repoRoot = path.join(__dirname, '..');
const publicDir = path.join(repoRoot, 'public');

function sourceFilesUnder(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFilesUnder(full));
      continue;
    }
    if (/\.(js|mjs)$/.test(entry.name)) found.push(full);
  }
  return found;
}

function bareImportSpecifiers(source) {
  const patterns = [/\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g];
  const specifiers = new Set();
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  return specifiers;
}

async function fetchModule(baseUrl, moduleId) {
  const response = await new Promise((resolve, reject) => {
    http.get(`${baseUrl}${moduleId}`, resolve).on('error', reject);
  });
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  return { status: response.statusCode, type: response.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') };
}

async function withDevRoutes(run) {
  const app = express();
  mountDevRoutes(app);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
    return;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('every /shared import in public is a declared browser module', () => {
  const offenders = [];
  for (const file of sourceFilesUnder(publicDir)) {
    for (const specifier of bareImportSpecifiers(fs.readFileSync(file, 'utf8'))) {
      if (!specifier.startsWith('/shared/')) continue;
      if (BROWSER_MODULE_IDS.includes(specifier)) continue;
      offenders.push(`${path.relative(repoRoot, file)} imports ${specifier}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('every declared browser module has a source file on disk', () => {
  for (const entry of BROWSER_MODULES) {
    assert.ok(fs.existsSync(path.join(repoRoot, entry.source)), `${entry.id} source ${entry.source} is missing`);
  }
});

test('the no-build server route table serves every declared browser module as javascript', async () => {
  await withDevRoutes(async (baseUrl) => {
    for (const entry of BROWSER_MODULES) {
      const served = await fetchModule(baseUrl, entry.id);
      assert.equal(served.status, 200, `${entry.id} did not serve 200`);
      assert.match(served.type, /javascript/, `${entry.id} served as ${served.type}`);
      assert.ok(served.body.includes('export'), `${entry.id} served no ESM exports`);
    }
  });
});

test('the vite plugin resolves and loads every declared browser module', () => {
  const plugin = browserModulesVitePlugin();
  for (const entry of BROWSER_MODULES) {
    const resolved = plugin.resolveId(entry.id);
    assert.ok(resolved, `${entry.id} was not resolved by the vite plugin`);
    const loaded = plugin.load(resolved);
    assert.ok(loaded?.includes('export'), `${entry.id} loaded no ESM exports in vite`);
  }
});

// Both delivery paths are the same renderer under different zod specifiers: Vite bundles the package,
// the no-build server serves node_modules/zod over HTTP. Pinning each against that renderer is what
// keeps a module from reaching the browser on one path and 404ing on the other.
test('both delivery paths serve exactly what the shared renderer produces', async () => {
  const plugin = browserModulesVitePlugin();
  await withDevRoutes(async (baseUrl) => {
    for (const entry of BROWSER_MODULES) {
      const served = await fetchModule(baseUrl, entry.id);
      assert.equal(served.body, renderBrowserModule(entry.id, { zodSpecifier: '/zod/index.js' }), `${entry.id} route body drifted`);
      assert.equal(plugin.load(plugin.resolveId(entry.id)), renderBrowserModule(entry.id, { zodSpecifier: 'zod' }), `${entry.id} vite body drifted`);
    }
  });
});
