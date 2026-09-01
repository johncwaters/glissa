// Pure staleness rule for a session's delivered context packs.
//
// A session is pointed at a pack's built dir once, at spawn, and records the version it got. The mill
// keeps rebuilding, so the version the dashboard knows about can move past what a live session was
// handed. Only a pack the dashboard has a CURRENT version for can be judged: an unknown name means
// the server never reported one (auto-rebuild off, or a pack built before this dashboard connected),
// and guessing "stale" there would nag about every session forever.

export interface DeliveredPack {
  name?: unknown;
  version?: unknown;
}

// A null value is what the server sends for a pack it has never built, so it rides the wire and the
// unknown-name rule above has to cover it rather than a cast pretending it cannot arrive.
export type LatestPackVersions = Map<string, string | null> | Record<string, string | null>;

/** Delivered pack names whose current version differs, in delivery order. */
export function stalePackNames(deliveredPacks: readonly DeliveredPack[] | unknown, latestVersionsByName: LatestPackVersions | null | undefined): string[] {
  if (!Array.isArray(deliveredPacks) || !latestVersionsByName) return [];
  const versions = latestVersionsByName;
  const lookup = versions instanceof Map
    ? (name: string) => versions.get(name)
    : (name: string) => versions[name];

  const names: string[] = [];
  for (const pack of deliveredPacks as DeliveredPack[]) {
    if (!pack || typeof pack.name !== 'string') continue;
    const latest = lookup(pack.name);
    if (typeof latest !== 'string' || latest === pack.version) continue;
    names.push(pack.name);
  }
  return names;
}

/** True when at least one delivered pack has been rebuilt since this session was spawned. */
export function hasStalePack(deliveredPacks: readonly DeliveredPack[] | unknown, latestVersionsByName: LatestPackVersions | null | undefined) {
  return stalePackNames(deliveredPacks, latestVersionsByName).length > 0;
}
