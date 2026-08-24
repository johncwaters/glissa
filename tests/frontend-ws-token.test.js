'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// data: URL import forces ESM despite the CJS package type; same as tests/frontend-client-trust.test.js.
let freshModuleCounter = 0;

function importWsToken() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'ws-token.js'), 'utf8');
  // The counter line defeats the ESM module cache so tests do not share token state.
  freshModuleCounter += 1;
  const uniqueSource = `${source}\nconst freshModuleId = ${freshModuleCounter};\nexport { freshModuleId };\n`;
  const dataUrl = `data:text/javascript;base64,${Buffer.from(uniqueSource).toString('base64')}`;
  return import(dataUrl);
}

function stubTokenFetch(tokensInOrder) {
  const fetchedUrls = [];
  globalThis.fetch = (url) => {
    fetchedUrls.push(url);
    const token = tokensInOrder.shift();
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ token }) });
  };
  return fetchedUrls;
}

test('loadPageToken caches: a second load refetches nothing', async () => {
  const { loadPageToken, pageToken } = await importWsToken();
  const fetchedUrls = stubTokenFetch(['first-token', 'second-token']);
  assert.equal(await loadPageToken(), 'first-token');
  assert.equal(await loadPageToken(), 'first-token');
  assert.equal(pageToken(), 'first-token');
  assert.equal(fetchedUrls.length, 1);
});

test('clearPageToken drops the cache so the next load mints the restarted server token', async () => {
  const { clearPageToken, loadPageToken, pageToken, withPageToken } = await importWsToken();
  const fetchedUrls = stubTokenFetch(['before-restart', 'after-restart']);
  await loadPageToken();
  clearPageToken();
  assert.equal(pageToken(), '');
  assert.equal(withPageToken('/control'), '/control');
  assert.equal(await loadPageToken(), 'after-restart');
  assert.equal(fetchedUrls.length, 2);
  assert.equal(withPageToken('/control?since=4'), '/control?since=4&token=after-restart');
});
