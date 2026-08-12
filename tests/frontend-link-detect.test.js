'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// link-detect-core is ESM (.mjs); dynamic-import it from this CJS test file.
const importCore = () => import('../public/session-card/link-detect-core.mjs');

test('findUrls: bare URL in prose, offsets cover exactly the URL', async () => {
  const { findUrls } = await importCore();
  const text = 'see https://example.com/docs for details';
  assert.deepEqual(findUrls(text), [
    { start: 4, end: 28, url: 'https://example.com/docs' },
  ]);
  assert.equal(text.slice(4, 28), 'https://example.com/docs');
});

test('findUrls: http and https both match, other schemes do not', async () => {
  const { findUrls } = await importCore();
  assert.equal(findUrls('http://example.com').length, 1);
  assert.equal(findUrls('ftp://example.com file:///etc/passwd').length, 0);
});

test('findUrls: multiple URLs on one line', async () => {
  const { findUrls } = await importCore();
  const urls = findUrls('a https://one.dev b https://two.dev c').map((f) => f.url);
  assert.deepEqual(urls, ['https://one.dev', 'https://two.dev']);
});

test('findUrls: trailing sentence punctuation is not part of the URL', async () => {
  const { findUrls } = await importCore();
  assert.equal(findUrls('go to https://example.com/a.')[0].url, 'https://example.com/a');
  assert.equal(findUrls('really? https://example.com/a?!')[0].url, 'https://example.com/a');
  assert.equal(findUrls('"https://example.com/a"')[0].url, 'https://example.com/a');
});

test('findUrls: wrapping parens stripped, balanced parens kept', async () => {
  const { findUrls } = await importCore();
  assert.equal(findUrls('(https://example.com/a)')[0].url, 'https://example.com/a');
  assert.equal(
    findUrls('https://en.wikipedia.org/wiki/Foo_(bar)')[0].url,
    'https://en.wikipedia.org/wiki/Foo_(bar)',
  );
});

test('findUrls: query strings and fragments survive', async () => {
  const { findUrls } = await importCore();
  const url = 'https://github.com/owner/repo/pull/12#issuecomment-9?x=1&y=2';
  assert.equal(findUrls(`PR: ${url}`)[0].url, url);
});

test('findUrls: a bare scheme is not a link', async () => {
  const { findUrls } = await importCore();
  assert.deepEqual(findUrls('the https:// prefix means TLS'), []);
});

test('findUrls: no URLs means empty result', async () => {
  const { findUrls } = await importCore();
  assert.deepEqual(findUrls(''), []);
  assert.deepEqual(findUrls('plain text only'), []);
});

test('isHttpUrl: accepts http(s) only', async () => {
  const { isHttpUrl } = await importCore();
  assert.equal(isHttpUrl('https://example.com'), true);
  assert.equal(isHttpUrl('HTTP://EXAMPLE.COM'), true);
  assert.equal(isHttpUrl('javascript:alert(1)'), false);
  assert.equal(isHttpUrl('file:///etc/passwd'), false);
});

test('trimTrailingPunctuation: strips stacked punctuation', async () => {
  const { trimTrailingPunctuation } = await importCore();
  assert.equal(trimTrailingPunctuation('https://x.dev/a).,'), 'https://x.dev/a');
  assert.equal(trimTrailingPunctuation('https://x.dev/(a)'), 'https://x.dev/(a)');
});
