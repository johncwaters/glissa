import { groupRoster, visibleOrder } from '../focus-view/roster-groups.ts';
import { orderSessionsForTriage } from './triage-core.ts';

const NO_COLLAPSED_GROUPS = new Set<string>();

export function groupSessionsForBoard<Row extends { id: string; state?: unknown }>(
  orderedRows: readonly Row[] | null | undefined,
  pathOf: (row: Row) => unknown,
  emptyKeys?: Iterable<unknown> | null,
) {
  const groupedRoster = groupRoster(orderedRows, pathOf, emptyKeys);
  const groups = groupedRoster.groups.map((group) => ({
    ...group,
    rows: orderSessionsForTriage(group.rows),
  }));
  const boardGroups = { ...groupedRoster, groups };
  return {
    ...boardGroups,
    visibleIds: visibleOrder(boardGroups, NO_COLLAPSED_GROUPS),
  };
}
