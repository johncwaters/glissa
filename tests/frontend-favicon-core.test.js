'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const importCore = () => import('../public/favicon-core.mjs');

test('decideFaviconVariant: waiting takes priority over complete', async () => {
  const { decideFaviconVariant } = await importCore();
  assert.equal(decideFaviconVariant([{ state: 'COMPLETE' }, { state: 'WAITING' }]), 'waiting');
  assert.equal(decideFaviconVariant([{ state: 'WAITING' }, { state: 'COMPLETE' }]), 'waiting');
  assert.equal(decideFaviconVariant([{ state: 'COMPLETE' }, { state: 'RUNNING' }]), 'complete');
});

test('decideFaviconVariant: an empty list is idle', async () => {
  const { decideFaviconVariant } = await importCore();
  assert.equal(decideFaviconVariant([]), 'idle');
});

test('renderFaviconSvg: idle retains the existing glyph and variants carry their colours', async () => {
  const { renderFaviconSvg } = await importCore();
  assert.match(renderFaviconSvg('idle'), /<path d="M10 8 L22 16 L10 24Z" fill="#c084fc"\/>/);
  assert.match(renderFaviconSvg('complete'), /#4ade80/);
  assert.match(renderFaviconSvg('waiting'), /#fbbf24/);
});
