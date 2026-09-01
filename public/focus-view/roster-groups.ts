// Pure grouping + visible-order resolution for the Focus rail's project organization level.
// No DOM, no window, no localStorage, no node:path - this runs in the browser AND in node:test.
//
// groupRoster partitions an ALREADY-SORTED roster (orderRoster output) into project groups keyed by
// the session's repo path. The partition is STABLE, so within-group order is exactly the input order
// (today's non-dormant-first-then-name). Groups themselves sort A->Z by basename label and never
// depend on row state, so a state change never reorders a group (the rail's stable-map rule, P1).
//
// visibleOrder flattens the groups into the session ids the keyboard can reach (Alt+1..9, Arrow),
// excluding collapsed groups. It is the SINGLE source of truth for rail navigability; the DOM never
// re-derives visibility.

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

// Basename of a path, splitting on both POSIX '/' and Windows '\'. Trailing separators are ignored
// (e.g. 'C:\\a\\proj\\' -> 'proj'). Hand-rolled so this stays browser-safe (no node:path).
function basename(p: unknown): string {
  if (!p) return NO_PATH_KEY;
  const s = String(p).replace(/[/\\]+$/, ''); // drop trailing separators
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  const tail = i === -1 ? s : s.slice(i + 1);
  return tail || NO_PATH_KEY;
}

// orderedRows: rows from orderRoster, each at least { id, ui }. pathOf(row) -> the group key (path).
// emptyKeys (optional): project paths KEPT in the rail after their last session closed. Each becomes a
// session-less group (rows: []) so the operator re-adds a session via the header "+" without re-picking
// the folder. A kept path that already owns a real group (a live session) is skipped; NO_PATH_KEY is
// never kept (it has no spawnable path). Consumers identify a kept group by rows.length === 0 (a real
// group always holds >= 1 row).
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
  // A->Z by label (case-insensitive, numeric-aware), tie-broken by full key for determinism. Never
  // depends on row state, so groups never reorder when a session changes state.
  groups.sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' })
    || a.key.localeCompare(b.key));
  return { flat: byKey.size <= 1, order: groups.map((g) => g.key), groups };
}

// groups: the object returned by groupRoster. collapsedSet: a Set<string> of collapsed group keys.
// Returns session ids in VISIBLE rail order (collapsed groups contribute nothing). Pure.
export function visibleOrder<Row extends { id: string }>(
  groups: GroupedRoster<Row> | null | undefined,
  collapsedSet?: ReadonlySet<string> | null,
): string[] {
  if (!groups || !Array.isArray(groups.groups)) return [];
  const collapsed = collapsedSet || new Set<string>();
  const ids: string[] = [];
  // Flat (single project / 0-1 rows): nothing is collapsible -> every id in input order.
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
