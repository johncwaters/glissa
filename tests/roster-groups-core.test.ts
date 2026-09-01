import test from 'node:test';
import assert from 'node:assert/strict';

import { NO_PATH_KEY, groupRoster, visibleOrder } from '../public/focus-view/roster-groups.ts';

interface RosterRow {
  id: string;
  ui: { path: string | null | undefined };
}

const row = (id: string, path: string | null | undefined): RosterRow => ({ id, ui: { path } });
const pathOf = (candidate: RosterRow): unknown => candidate.ui.path;
const idsOf = (rows: RosterRow[]): string[] => rows.map((candidate) => candidate.id);

test('1. empty input -> flat, no order, no groups', () => {
  assert.deepEqual(groupRoster<RosterRow>([], pathOf), { flat: true, order: [], groups: [] });
  assert.deepEqual(groupRoster<RosterRow>(null, pathOf), { flat: true, order: [], groups: [] });
});

test('2. single session -> flat', () => {
  const grouped = groupRoster([row('a', 'C:\\code\\proj')], pathOf);
  assert.equal(grouped.flat, true);
  assert.equal(grouped.order.length, 1);
});

test('3. multiple sessions on one path -> flat (no headers)', () => {
  const grouped = groupRoster([row('a', 'C:\\code\\proj'), row('b', 'C:\\code\\proj'), row('c', 'C:\\code\\proj')], pathOf);
  assert.equal(grouped.flat, true);
  assert.equal(grouped.groups.length, 1);
  assert.deepEqual(idsOf(grouped.groups[0].rows), ['a', 'b', 'c']);
});

test('4. two paths -> not flat, two groups, order A->Z by basename', () => {
  const grouped = groupRoster([row('z', 'C:\\code\\zebra'), row('a', 'C:\\code\\alpha')], pathOf);
  assert.equal(grouped.flat, false);
  assert.equal(grouped.groups.length, 2);
  assert.deepEqual(grouped.groups.map((group) => group.label), ['alpha', 'zebra']);
  assert.deepEqual(grouped.order, ['C:\\code\\alpha', 'C:\\code\\zebra']);
});

test('5. within-group order == input order (state changes never shuffle)', () => {
  const grouped = groupRoster([
    row('a1', 'C:\\code\\alpha'),
    row('z1', 'C:\\code\\zebra'),
    row('a2', 'C:\\code\\alpha'),
    row('a3', 'C:\\code\\alpha'),
  ], pathOf);
  const alpha = grouped.groups.find((group) => group.label === 'alpha');
  assert.ok(alpha, 'the alpha group exists');
  assert.deepEqual(idsOf(alpha.rows), ['a1', 'a2', 'a3']);
});

test('6. group order is independent of input row order / state', () => {
  const first = groupRoster([row('1', 'C:\\code\\beta'), row('2', 'C:\\code\\alpha')], pathOf);
  const second = groupRoster([row('2', 'C:\\code\\alpha'), row('1', 'C:\\code\\beta')], pathOf);
  assert.deepEqual(first.order, second.order);
  assert.deepEqual(first.order, ['C:\\code\\alpha', 'C:\\code\\beta']);
});

test('7. label = basename (original case) for Windows and POSIX; title = full path', () => {
  const win = groupRoster([row('a', 'C:\\a\\b\\proj')], pathOf);
  assert.equal(win.groups[0].label, 'proj');
  assert.notEqual(win.groups[0].label, 'PROJ');
  assert.equal(win.groups[0].title, 'C:\\a\\b\\proj');
  const posix = groupRoster([row('a', '/home/u/proj')], pathOf);
  assert.equal(posix.groups[0].label, 'proj');
  assert.equal(posix.groups[0].title, '/home/u/proj');
});

test('8. two different paths sharing a basename -> two groups, deterministic tie-break by full key', () => {
  const grouped = groupRoster([row('y', 'C:\\y\\app'), row('x', 'C:\\x\\app')], pathOf);
  assert.equal(grouped.groups.length, 2);
  assert.deepEqual(grouped.groups.map((group) => group.label), ['app', 'app']);

  assert.deepEqual(grouped.order, ['C:\\x\\app', 'C:\\y\\app']);
});

test('9. missing/empty path -> stable (no path) fallback, no throw', () => {
  const grouped = groupRoster([row('a', ''), row('b', undefined), row('c', null)], pathOf);
  assert.equal(grouped.flat, true);
  assert.equal(grouped.order[0], NO_PATH_KEY);
  assert.equal(grouped.groups[0].label, NO_PATH_KEY);
  assert.deepEqual(idsOf(grouped.groups[0].rows), ['a', 'b', 'c']);
});

test('16. emptyKeys default omitted -> unchanged (no empty groups)', () => {
  const grouped = groupRoster([row('a', 'C:\\code\\proj')], pathOf);
  assert.equal(grouped.groups.length, 1);
  assert.equal(grouped.groups[0].rows.length, 1);
});

test('17. kept path with no session -> empty group (rows: []), header data present', () => {
  const grouped = groupRoster<RosterRow>([], pathOf, ['C:\\code\\ghost']);
  assert.equal(grouped.groups.length, 1);
  assert.equal(grouped.flat, true);
  const only = grouped.groups[0];
  assert.equal(only.key, 'C:\\code\\ghost');
  assert.equal(only.label, 'ghost');
  assert.equal(only.title, 'C:\\code\\ghost');
  assert.deepEqual(only.rows, []);
});

test('18. kept path that also has a live session -> one real group, NOT duplicated', () => {
  const grouped = groupRoster([row('a', 'C:\\code\\live')], pathOf, ['C:\\code\\live']);
  assert.equal(grouped.groups.length, 1);
  assert.equal(grouped.groups[0].rows.length, 1);
});

test('19. live + kept-empty groups sort together A->Z by basename', () => {
  const grouped = groupRoster([row('m', 'C:\\code\\mid')], pathOf, ['C:\\code\\alpha', 'C:\\code\\zebra']);
  assert.deepEqual(grouped.groups.map((group) => group.label), ['alpha', 'mid', 'zebra']);
  assert.equal(grouped.groups.find((group) => group.label === 'alpha')?.rows.length, 0);
  assert.equal(grouped.groups.find((group) => group.label === 'mid')?.rows.length, 1);
  assert.equal(grouped.groups.find((group) => group.label === 'zebra')?.rows.length, 0);
});

test('20. NO_PATH_KEY and falsy entries in emptyKeys are ignored (no spawnable path)', () => {
  const grouped = groupRoster<RosterRow>([], pathOf, [NO_PATH_KEY, '', null, undefined]);
  assert.deepEqual(grouped.groups, []);
});

test('21. kept-empty groups contribute no navigable ids to visibleOrder', () => {
  const grouped = groupRoster([row('a', 'C:\\code\\live')], pathOf, ['C:\\code\\ghost']);
  assert.deepEqual(visibleOrder(grouped, new Set()), ['a']);
});

test('10. visibleOrder flat -> all ids in input order, collapsedSet ignored', () => {
  const grouped = groupRoster([row('a', 'C:\\code\\proj'), row('b', 'C:\\code\\proj')], pathOf);
  assert.deepEqual(visibleOrder(grouped, new Set(['C:\\code\\proj'])), ['a', 'b']);
});

test('11. two groups, none collapsed -> all ids, group A before group B', () => {
  const grouped = groupRoster([row('z', 'C:\\code\\zebra'), row('a', 'C:\\code\\alpha')], pathOf);
  assert.deepEqual(visibleOrder(grouped, new Set()), ['a', 'z']);
});

test('12. two groups, FIRST collapsed -> only second group ids', () => {
  const grouped = groupRoster([row('a', 'C:\\code\\alpha'), row('z', 'C:\\code\\zebra')], pathOf);
  assert.deepEqual(visibleOrder(grouped, new Set(['C:\\code\\alpha'])), ['z']);
});

test('13. two groups, SECOND collapsed -> only first group ids', () => {
  const grouped = groupRoster([row('a', 'C:\\code\\alpha'), row('z', 'C:\\code\\zebra')], pathOf);
  assert.deepEqual(visibleOrder(grouped, new Set(['C:\\code\\zebra'])), ['a']);
});

test('14. three groups, MIDDLE collapsed -> first then third (gap closed)', () => {
  const grouped = groupRoster([
    row('a', 'C:\\code\\alpha'),
    row('m', 'C:\\code\\mid'),
    row('z', 'C:\\code\\zebra'),
  ], pathOf);
  assert.deepEqual(visibleOrder(grouped, new Set(['C:\\code\\mid'])), ['a', 'z']);
});

test('15. all groups collapsed -> [] (no navigable pill)', () => {
  const grouped = groupRoster([row('a', 'C:\\code\\alpha'), row('z', 'C:\\code\\zebra')], pathOf);
  assert.deepEqual(visibleOrder(grouped, new Set(['C:\\code\\alpha', 'C:\\code\\zebra'])), []);
});
