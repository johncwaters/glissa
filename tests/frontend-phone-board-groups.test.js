'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const importBoardCore = () => import('../public/phone/board-groups-core.ts');
const importRosterCore = () => import('../public/focus-view/roster-groups.ts');

const row = (id, projectPath, state) => ({ id, projectPath, state });
const pathOf = (entry) => entry.projectPath;
const ids = (rows) => rows.map((entry) => entry.id);

test('groupSessionsForBoard keeps project order stable while attention reranks rows inside a group', async () => {
  const { groupSessionsForBoard } = await importBoardCore();
  const before = groupSessionsForBoard([
    row('alpha-one', '/work/alpha', 'RUNNING'),
    row('alpha-two', '/work/alpha', 'WAITING'),
    row('zebra-one', '/work/zebra', 'FAILED'),
  ], pathOf);
  const after = groupSessionsForBoard([
    row('alpha-one', '/work/alpha', 'WAITING'),
    row('alpha-two', '/work/alpha', 'RUNNING'),
    row('zebra-one', '/work/zebra', 'IDLE'),
  ], pathOf);

  assert.deepEqual(before.order, ['/work/alpha', '/work/zebra']);
  assert.deepEqual(after.order, before.order);
  assert.deepEqual(ids(before.groups[0].rows), ['alpha-two', 'alpha-one']);
  assert.deepEqual(ids(after.groups[0].rows), ['alpha-one', 'alpha-two']);
});

test('groupSessionsForBoard keeps empty projects and excludes them from visible ids', async () => {
  const { groupSessionsForBoard } = await importBoardCore();
  const grouped = groupSessionsForBoard([
    row('live', '/work/live', 'RUNNING'),
  ], pathOf, ['/work/empty']);

  const emptyGroup = grouped.groups.find((group) => group.key === '/work/empty');
  assert.deepEqual(emptyGroup.rows, []);
  assert.deepEqual(grouped.visibleIds, ['live']);
});

test('groupSessionsForBoard places the pathless group exactly where the desktop grouping does', async () => {
  const { groupSessionsForBoard } = await importBoardCore();
  const { groupRoster, NO_PATH_KEY } = await importRosterCore();
  const rows = [
    row('zebra', '/work/zebra', 'RUNNING'),
    row('pathless', '', 'WAITING'),
    row('alpha', '/work/alpha', 'FAILED'),
  ];
  const desktopGroups = groupRoster(rows, pathOf, ['/work/empty']);
  const boardGroups = groupSessionsForBoard(rows, pathOf, ['/work/empty']);

  assert.deepEqual(boardGroups.order, desktopGroups.order);
  assert.equal(boardGroups.order.indexOf(NO_PATH_KEY), desktopGroups.order.indexOf(NO_PATH_KEY));
});
