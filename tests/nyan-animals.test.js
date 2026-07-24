'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// nyan-animals is ESM (.mjs); dynamic-import it from this CJS test file.
const importCore = () => import('../public/nyan-animals.mjs');

test('ANIMALS: 18 entries, all sprite/trail classes unique', async () => {
  const { ANIMALS } = await importCore();
  assert.equal(ANIMALS.length, 18);
  const sprites = ANIMALS.map((a) => a.sprite);
  const trails = ANIMALS.map((a) => a.trail);
  assert.equal(new Set(sprites).size, 18);
  assert.equal(new Set(trails).size, 18);
});

test('pickAnimalIndex: never returns prevIndex across a sweep of rng values', async () => {
  const { ANIMALS, pickAnimalIndex } = await importCore();
  const n = ANIMALS.length;
  for (let prevIndex = 0; prevIndex < n; prevIndex++) {
    const seen = new Set();
    for (let i = 0; i < 1000; i++) {
      const rng = () => i / 1000;
      const picked = pickAnimalIndex(rng, prevIndex);
      assert.notEqual(picked, prevIndex);
      seen.add(picked);
    }
    assert.equal(seen.size, n - 1, `prevIndex ${prevIndex} should reach all other indices`);
  }
});

test('pickAnimalIndex: returns valid indices for full rng range 0..0.999', async () => {
  const { ANIMALS, pickAnimalIndex } = await importCore();
  const n = ANIMALS.length;
  for (let i = 0; i < 1000; i++) {
    const rng = () => i / 1000;
    const picked = pickAnimalIndex(rng, 3);
    assert.ok(picked >= 0 && picked < n, `index ${picked} out of range`);
  }
});

test('pickAnimalIndex: out-of-range prevIndex behaves like no previous flight', async () => {
  const { ANIMALS, pickAnimalIndex } = await importCore();
  const n = ANIMALS.length;
  for (const prevIndex of [999, -5, n]) {
    const seen = new Set();
    for (let i = 0; i < 1000; i++) {
      const rng = () => i / 1000;
      seen.add(pickAnimalIndex(rng, prevIndex));
    }
    assert.equal(seen.size, n, `prevIndex ${prevIndex} should allow all indices`);
  }
});

test('every roster sprite/trail class has a matching unicorn-theme CSS rule', async () => {
  const { ANIMALS } = await importCore();
  const fs = require('node:fs');
  const path = require('node:path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  for (const animal of ANIMALS) {
    assert.ok(css.includes(`.nyan-sprite.${animal.sprite}`), `missing sprite rule for ${animal.sprite}`);
    assert.ok(css.includes(`.nyan-trail.${animal.trail}`), `missing trail rule for ${animal.trail}`);
  }
});

test('pickAnimalIndex: prevIndex -1 allows all indices', async () => {
  const { ANIMALS, pickAnimalIndex } = await importCore();
  const n = ANIMALS.length;
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    const rng = () => i / 1000;
    seen.add(pickAnimalIndex(rng, -1));
  }
  assert.equal(seen.size, n);
  for (let idx = 0; idx < n; idx++) assert.ok(seen.has(idx));
});
