import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ANIMALS, pickAnimalIndex } from '../public/nyan-animals.ts';

test('ANIMALS: 18 entries, all sprite/trail classes unique', () => {
  assert.equal(ANIMALS.length, 18);
  const sprites = ANIMALS.map((animal) => animal.sprite);
  const trails = ANIMALS.map((animal) => animal.trail);
  assert.equal(new Set(sprites).size, 18);
  assert.equal(new Set(trails).size, 18);
});

test('pickAnimalIndex: never returns prevIndex across a sweep of rng values', () => {
  const animalCount = ANIMALS.length;
  for (let prevIndex = 0; prevIndex < animalCount; prevIndex++) {
    const seen = new Set<number>();
    for (let step = 0; step < 1000; step++) {
      const picked = pickAnimalIndex(() => step / 1000, prevIndex);
      assert.notEqual(picked, prevIndex);
      seen.add(picked);
    }
    assert.equal(seen.size, animalCount - 1, `prevIndex ${prevIndex} should reach all other indices`);
  }
});

test('pickAnimalIndex: an absent or out-of-range prevIndex allows every index', () => {
  const animalCount = ANIMALS.length;
  for (const prevIndex of [-1, 999, -5, animalCount]) {
    const seen = new Set<number>();
    for (let step = 0; step < 1000; step++) seen.add(pickAnimalIndex(() => step / 1000, prevIndex));
    assert.equal(seen.size, animalCount, `prevIndex ${prevIndex} should allow all indices`);
  }
});

test('every roster sprite/trail class has a matching unicorn-theme CSS rule', () => {
  const css = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'style.css'), 'utf8');
  for (const animal of ANIMALS) {
    assert.ok(css.includes(`.nyan-sprite.${animal.sprite}`), `missing sprite rule for ${animal.sprite}`);
    assert.ok(css.includes(`.nyan-trail.${animal.trail}`), `missing trail rule for ${animal.trail}`);
  }
});
