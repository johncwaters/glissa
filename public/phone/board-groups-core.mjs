import { groupRoster, visibleOrder } from '../focus-view/roster-groups.mjs';
import { orderSessionsForTriage } from './triage-core.mjs';

const NO_COLLAPSED_GROUPS = new Set();

export function groupSessionsForBoard(orderedRows, pathOf, emptyKeys) {
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
