import test from 'node:test';
import assert from 'node:assert/strict';

// naming-core is ESM (.mjs); dynamic-import it so the suite drives the shipped module.
const importCore = () => import('../public/session-card/naming-core.ts');

test('isAutoNameOf: exact match, numbered suffix, and non-matches', async () => {
  const { isAutoNameOf } = await importCore();
  assert.equal(isAutoNameOf('Foo', 'Foo'), true);
  assert.equal(isAutoNameOf('Foo (2)', 'Foo'), true);
  assert.equal(isAutoNameOf('Foo (legacy)', 'Foo'), false);
  assert.equal(isAutoNameOf('Bar', 'Foo'), false);
});

test('nextSuggestedName: returns base when free', async () => {
  const { nextSuggestedName } = await importCore();
  assert.equal(nextSuggestedName('Foo', []), 'Foo');
});

test('nextSuggestedName: returns "base (2)" when base is taken', async () => {
  const { nextSuggestedName } = await importCore();
  assert.equal(nextSuggestedName('Foo', ['Foo']), 'Foo (2)');
});

test('nextSuggestedName: gap-fills the sequence', async () => {
  const { nextSuggestedName } = await importCore();
  assert.equal(nextSuggestedName('Foo', ['Foo', 'Foo (2)']), 'Foo (3)');
});

test('nextSuggestedName: timestamp fallback past 999', async () => {
  const { nextSuggestedName } = await importCore();
  const names = ['Foo'];
  for (let i = 2; i < 1000; i++) names.push(`Foo (${i})`);
  const r = nextSuggestedName('Foo', names);
  assert.match(r, /^Foo \(\d+\)$/);
  assert.ok(!names.includes(r));
});

test('countAutoNames: counts base and numbered, ignores unrelated parentheticals', async () => {
  const { countAutoNames } = await importCore();
  assert.equal(countAutoNames('Foo', ['Foo', 'Foo (2)', 'Foo (legacy)', 'Bar']), 2);
});
