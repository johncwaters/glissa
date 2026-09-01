'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// roster-groups is ESM (.mjs); dynamic-import it from this CJS test file (mirrors frontend-diff-core).
const importCore = () => import('../public/focus-view/roster-groups.ts');

// Minimal row shape: orderRoster yields { id, ui, ... }; grouping reads row.ui.path and row.id.
const r = (id, path) => ({ id, ui: { path } });
const pathOf = (row) => row.ui.path;

// ── groupRoster ──────────────────────────────────────────────

test('1. empty input -> flat, no order, no groups', async () => {
  const { groupRoster } = await importCore();
  assert.deepEqual(groupRoster([], pathOf), { flat: true, order: [], groups: [] });
  assert.deepEqual(groupRoster(null, pathOf), { flat: true, order: [], groups: [] });
});

test('2. single session -> flat', async () => {
  const { groupRoster } = await importCore();
  const g = groupRoster([r('a', 'C:\\code\\proj')], pathOf);
  assert.equal(g.flat, true);
  assert.equal(g.order.length, 1);
});

test('3. multiple sessions on one path -> flat (no headers)', async () => {
  const { groupRoster } = await importCore();
  const g = groupRoster([r('a', 'C:\\code\\proj'), r('b', 'C:\\code\\proj'), r('c', 'C:\\code\\proj')], pathOf);
  assert.equal(g.flat, true);
  assert.equal(g.groups.length, 1);
  assert.deepEqual(g.groups[0].rows.map((x) => x.id), ['a', 'b', 'c']);
});

test('4. two paths -> not flat, two groups, order A->Z by basename', async () => {
  const { groupRoster } = await importCore();
  // Input deliberately zebra-before-alpha; group order must come out alpha-before-zebra.
  const g = groupRoster([r('z', 'C:\\code\\zebra'), r('a', 'C:\\code\\alpha')], pathOf);
  assert.equal(g.flat, false);
  assert.equal(g.groups.length, 2);
  assert.deepEqual(g.groups.map((x) => x.label), ['alpha', 'zebra']);
  assert.deepEqual(g.order, ['C:\\code\\alpha', 'C:\\code\\zebra']);
});

test('5. within-group order == input order (state changes never shuffle)', async () => {
  const { groupRoster } = await importCore();
  const g = groupRoster([
    r('a1', 'C:\\code\\alpha'),
    r('z1', 'C:\\code\\zebra'),
    r('a2', 'C:\\code\\alpha'),
    r('a3', 'C:\\code\\alpha'),
  ], pathOf);
  const alpha = g.groups.find((x) => x.label === 'alpha');
  assert.deepEqual(alpha.rows.map((x) => x.id), ['a1', 'a2', 'a3']);
});

test('6. group order is independent of input row order / state', async () => {
  const { groupRoster } = await importCore();
  const a = groupRoster([r('1', 'C:\\code\\beta'), r('2', 'C:\\code\\alpha')], pathOf);
  const b = groupRoster([r('2', 'C:\\code\\alpha'), r('1', 'C:\\code\\beta')], pathOf);
  assert.deepEqual(a.order, b.order);
  assert.deepEqual(a.order, ['C:\\code\\alpha', 'C:\\code\\beta']);
});

test('7. label = basename (original case) for Windows and POSIX; title = full path', async () => {
  const { groupRoster } = await importCore();
  const win = groupRoster([r('a', 'C:\\a\\b\\proj')], pathOf);
  assert.equal(win.groups[0].label, 'proj');
  assert.notEqual(win.groups[0].label, 'PROJ');
  assert.equal(win.groups[0].title, 'C:\\a\\b\\proj');
  const posix = groupRoster([r('a', '/home/u/proj')], pathOf);
  assert.equal(posix.groups[0].label, 'proj');
  assert.equal(posix.groups[0].title, '/home/u/proj');
});

test('8. two different paths sharing a basename -> two groups, deterministic tie-break by full key', async () => {
  const { groupRoster } = await importCore();
  const g = groupRoster([r('y', 'C:\\y\\app'), r('x', 'C:\\x\\app')], pathOf);
  assert.equal(g.groups.length, 2);
  assert.deepEqual(g.groups.map((x) => x.label), ['app', 'app']);
  // Tie broken by full key: C:\x\app sorts before C:\y\app.
  assert.deepEqual(g.order, ['C:\\x\\app', 'C:\\y\\app']);
});

test('9. missing/empty path -> stable (no path) fallback, no throw', async () => {
  const { groupRoster, NO_PATH_KEY } = await importCore();
  const g = groupRoster([r('a', ''), r('b', undefined), r('c', null)], pathOf);
  assert.equal(g.flat, true); // all collapse to the one fallback key
  assert.equal(g.order[0], NO_PATH_KEY);
  assert.equal(g.groups[0].label, NO_PATH_KEY);
  assert.deepEqual(g.groups[0].rows.map((x) => x.id), ['a', 'b', 'c']);
});

// ── groupRoster: kept (session-less) empty projects ──────────

test('16. emptyKeys default omitted -> unchanged (no empty groups)', async () => {
  const { groupRoster } = await importCore();
  const g = groupRoster([r('a', 'C:\\code\\proj')], pathOf);
  assert.equal(g.groups.length, 1);
  assert.equal(g.groups[0].rows.length, 1);
});

test('17. kept path with no session -> empty group (rows: []), header data present', async () => {
  const { groupRoster } = await importCore();
  const g = groupRoster([], pathOf, ['C:\\code\\ghost']);
  assert.equal(g.groups.length, 1);
  assert.equal(g.flat, true); // single group
  const only = g.groups[0];
  assert.equal(only.key, 'C:\\code\\ghost');
  assert.equal(only.label, 'ghost');
  assert.equal(only.title, 'C:\\code\\ghost');
  assert.deepEqual(only.rows, []);
});

test('18. kept path that also has a live session -> one real group, NOT duplicated', async () => {
  const { groupRoster } = await importCore();
  const g = groupRoster([r('a', 'C:\\code\\live')], pathOf, ['C:\\code\\live']);
  assert.equal(g.groups.length, 1);
  assert.equal(g.groups[0].rows.length, 1); // the real session group wins; no empty twin
});

test('19. live + kept-empty groups sort together A->Z by basename', async () => {
  const { groupRoster } = await importCore();
  const g = groupRoster([r('m', 'C:\\code\\mid')], pathOf, ['C:\\code\\alpha', 'C:\\code\\zebra']);
  assert.deepEqual(g.groups.map((x) => x.label), ['alpha', 'mid', 'zebra']);
  assert.equal(g.groups.find((x) => x.label === 'alpha').rows.length, 0);
  assert.equal(g.groups.find((x) => x.label === 'mid').rows.length, 1);
  assert.equal(g.groups.find((x) => x.label === 'zebra').rows.length, 0);
});

test('20. NO_PATH_KEY and falsy entries in emptyKeys are ignored (no spawnable path)', async () => {
  const { groupRoster, NO_PATH_KEY } = await importCore();
  const g = groupRoster([], pathOf, [NO_PATH_KEY, '', null, undefined]);
  assert.deepEqual(g.groups, []);
});

test('21. kept-empty groups contribute no navigable ids to visibleOrder', async () => {
  const { groupRoster, visibleOrder } = await importCore();
  const g = groupRoster([r('a', 'C:\\code\\live')], pathOf, ['C:\\code\\ghost']);
  assert.deepEqual(visibleOrder(g, new Set()), ['a']); // ghost adds no pill
});

// ── visibleOrder ─────────────────────────────────────────────

test('10. visibleOrder flat -> all ids in input order, collapsedSet ignored', async () => {
  const { groupRoster, visibleOrder } = await importCore();
  const g = groupRoster([r('a', 'C:\\code\\proj'), r('b', 'C:\\code\\proj')], pathOf);
  assert.deepEqual(visibleOrder(g, new Set(['C:\\code\\proj'])), ['a', 'b']);
});

test('11. two groups, none collapsed -> all ids, group A before group B', async () => {
  const { groupRoster, visibleOrder } = await importCore();
  const g = groupRoster([r('z', 'C:\\code\\zebra'), r('a', 'C:\\code\\alpha')], pathOf);
  assert.deepEqual(visibleOrder(g, new Set()), ['a', 'z']);
});

test('12. two groups, FIRST collapsed -> only second group ids', async () => {
  const { groupRoster, visibleOrder } = await importCore();
  const g = groupRoster([r('a', 'C:\\code\\alpha'), r('z', 'C:\\code\\zebra')], pathOf);
  assert.deepEqual(visibleOrder(g, new Set(['C:\\code\\alpha'])), ['z']);
});

test('13. two groups, SECOND collapsed -> only first group ids', async () => {
  const { groupRoster, visibleOrder } = await importCore();
  const g = groupRoster([r('a', 'C:\\code\\alpha'), r('z', 'C:\\code\\zebra')], pathOf);
  assert.deepEqual(visibleOrder(g, new Set(['C:\\code\\zebra'])), ['a']);
});

test('14. three groups, MIDDLE collapsed -> first then third (gap closed)', async () => {
  const { groupRoster, visibleOrder } = await importCore();
  const g = groupRoster([
    r('a', 'C:\\code\\alpha'),
    r('m', 'C:\\code\\mid'),
    r('z', 'C:\\code\\zebra'),
  ], pathOf);
  assert.deepEqual(visibleOrder(g, new Set(['C:\\code\\mid'])), ['a', 'z']);
});

test('15. all groups collapsed -> [] (no navigable pill)', async () => {
  const { groupRoster, visibleOrder } = await importCore();
  const g = groupRoster([r('a', 'C:\\code\\alpha'), r('z', 'C:\\code\\zebra')], pathOf);
  assert.deepEqual(visibleOrder(g, new Set(['C:\\code\\alpha', 'C:\\code\\zebra'])), []);
});
