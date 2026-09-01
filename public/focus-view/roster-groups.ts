export const NO_PATH_KEY = '(no path)';

export interface RosterGroup<Row> {
  key: string;
  label: string;
  title: string;
  rows: Row[];
}

export interface GroupedRoster<Row> {
  flat: boolean;
  order: string[];
  groups: RosterGroup<Row>[];
}

function basename(p: unknown): string {
  if (!p) return NO_PATH_KEY;
  const s = String(p).replace(/[/\\]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  const tail = i === -1 ? s : s.slice(i + 1);
  return tail || NO_PATH_KEY;
}

export function groupRoster<Row extends { id: string }>(
  orderedRows: readonly Row[] | null | undefined,
  pathOf: (row: Row) => unknown,
  emptyKeys?: Iterable<unknown> | null,
): GroupedRoster<Row> {
  const rows = Array.isArray(orderedRows) ? orderedRows : [];
  const byKey = new Map<string, RosterGroup<Row>>();
  for (const row of rows) {
    const raw = pathOf(row);
    const key = raw ? String(raw) : NO_PATH_KEY;
    let g = byKey.get(key);
    if (!g) {
      g = { key, label: key === NO_PATH_KEY ? NO_PATH_KEY : basename(key), title: key, rows: [] };
      byKey.set(key, g);
    }
    g.rows.push(row);
  }
  if (emptyKeys) {
    for (const raw of emptyKeys) {
      if (!raw) continue;
      const key = String(raw);
      if (key === NO_PATH_KEY || byKey.has(key)) continue;
      byKey.set(key, { key, label: basename(key), title: key, rows: [] });
    }
  }
  const groups = [...byKey.values()];

  groups.sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' })
    || a.key.localeCompare(b.key));
  return { flat: byKey.size <= 1, order: groups.map((g) => g.key), groups };
}

export function visibleOrder<Row extends { id: string }>(
  groups: GroupedRoster<Row> | null | undefined,
  collapsedSet?: ReadonlySet<string> | null,
): string[] {
  if (!groups || !Array.isArray(groups.groups)) return [];
  const collapsed = collapsedSet || new Set<string>();
  const ids: string[] = [];

  if (groups.flat) {
    for (const g of groups.groups) for (const row of g.rows) ids.push(row.id);
    return ids;
  }
  const byKey = new Map(groups.groups.map((g) => [g.key, g]));
  for (const key of groups.order) {
    if (collapsed.has(key)) continue;
    const g = byKey.get(key);
    if (g) for (const row of g.rows) ids.push(row.id);
  }
  return ids;
}
