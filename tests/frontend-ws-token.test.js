'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// A unique query defeats the ESM module cache so tests do not share token state; the .ts pathname is
// what Node keys its type stripping on, so the module still loads as source.
let freshModuleCounter = 0;

function importWsToken() {
  freshModuleCounter += 1;
  const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'public', 'ws-token.ts'));
  moduleUrl.searchParams.set('fresh', String(freshModuleCounter));
  return import(moduleUrl.href);
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
