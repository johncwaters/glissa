'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// form-factor-core is ESM (.mjs); dynamic-import it from this CJS test file.
const importCore = () => import('../public/form-factor-core.mjs');

test('decideLayout: a coarse pointer on a narrow viewport is the phone layout', async () => {
  const { decideLayout } = await importCore();
  assert.equal(decideLayout({ coarse: true, narrowWidth: true }), 'phone');
});

test('decideLayout: a narrowed DESKTOP window keeps the desktop layout (it can be widened again)', async () => {
  const { decideLayout } = await importCore();
  assert.equal(decideLayout({ coarse: false, narrowWidth: true }), 'desktop');
});

test('decideLayout: a coarse-pointer tablet above the threshold keeps the desktop layout', async () => {
  const { decideLayout } = await importCore();
  assert.equal(decideLayout({ coarse: true, narrowWidth: false }), 'desktop');
});

test('decideLayout: a plain desktop is the desktop layout', async () => {
  const { decideLayout } = await importCore();
  assert.equal(decideLayout({ coarse: false, narrowWidth: false }), 'desktop');
});

test('decideLayout: missing or non-boolean inputs never guess phone', async () => {
  const { decideLayout } = await importCore();
  assert.equal(decideLayout(), 'desktop');
  assert.equal(decideLayout({}), 'desktop');
  assert.equal(decideLayout({ coarse: 1, narrowWidth: 1 }), 'desktop');
  assert.equal(decideLayout({ coarse: 'yes', narrowWidth: true }), 'desktop');
});

test('the media queries the shell evaluates are derived from the one width constant', async () => {
  const { COARSE_POINTER_QUERY, PHONE_MAX_WIDTH_PX, PHONE_NARROW_QUERY } = await importCore();
  assert.equal(PHONE_MAX_WIDTH_PX, 768);
  assert.equal(PHONE_NARROW_QUERY, '(max-width: 768px)');
  assert.equal(COARSE_POINTER_QUERY, '(pointer: coarse)');
});
