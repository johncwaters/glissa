import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let freshModuleCounter = 0;

type WsTokenModule = typeof import('../public/ws-token.ts');

function importWsToken(): Promise<WsTokenModule> {
  freshModuleCounter += 1;
  const moduleUrl = pathToFileURL(path.join(import.meta.dirname, '..', 'public', 'ws-token.ts'));
  moduleUrl.searchParams.set('fresh', String(freshModuleCounter));
  return import(moduleUrl.href);
}

function stubTokenFetch(tokensInOrder: string[]): string[] {
  const fetchedUrls: string[] = [];
  globalThis.fetch = (input) => {
    fetchedUrls.push(String(input));
    const token = tokensInOrder.shift() ?? '';
    return Promise.resolve(new Response(JSON.stringify({ token })));
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
