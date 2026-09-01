import test from 'node:test';
import assert from 'node:assert/strict';

// settings-projects-core is ESM (.mjs); dynamic-import it so the suite drives the shipped module.
const load = () => import('../public/settings-projects-core.ts');

test('a checked box is the selection when every stored id was rendered', async () => {
  const { unionProjectSelection } = await load();
  assert.deepEqual(
    unionProjectSelection({ checked: ['a'], stored: ['a', 'b'], rendered: ['a', 'b'] }),
    ['a'],
  );
});

// The fail-open case: visions resolves an empty list to UNSCOPED, so dropping the one id the picker
// could not render would widen a restricted lane to every project on an unrelated tab's save.
test('a stored id the picker never rendered survives a save', async () => {
  const { unionProjectSelection } = await load();
  assert.deepEqual(
    unionProjectSelection({ checked: [], stored: ['gone'], rendered: ['a'] }),
    ['gone'],
  );
});

test('an unrendered id is never duplicated, and a blank entry is dropped', async () => {
  const { unionProjectSelection } = await load();
  assert.deepEqual(
    unionProjectSelection({ checked: ['gone'], stored: ['gone', '', '  ', 7], rendered: [] }),
    ['gone'],
  );
});

test('an empty call is an empty selection, so an unconfigured lane stays unscoped', async () => {
  const { unionProjectSelection } = await load();
  assert.deepEqual(unionProjectSelection(), []);
  assert.deepEqual(unionProjectSelection({ checked: [], stored: [], rendered: [] }), []);
});
