// Pure staleness rule for a session's delivered context packs.
//
// A session is pointed at a pack's built dir once, at spawn, and records the version it got. The mill
// keeps rebuilding, so the version the dashboard knows about can move past what a live session was
// handed. Only a pack the dashboard has a CURRENT version for can be judged: an unknown name means
// the server never reported one (auto-rebuild off, or a pack built before this dashboard connected),
// and guessing "stale" there would nag about every session forever.

/** @returns {string[]} delivered pack names whose current version differs, in delivery order */
export function stalePackNames(deliveredPacks, latestVersionsByName) {
  if (!Array.isArray(deliveredPacks) || !latestVersionsByName) return [];
  const lookup = latestVersionsByName instanceof Map
    ? (name) => latestVersionsByName.get(name)
    : (name) => latestVersionsByName[name];

  const names = [];
  for (const pack of deliveredPacks) {
    if (!pack || typeof pack.name !== 'string') continue;
    const latest = lookup(pack.name);
    if (typeof latest !== 'string' || latest === pack.version) continue;
    names.push(pack.name);
  }
  return names;
}

/** True when at least one delivered pack has been rebuilt since this session was spawned. */
export function hasStalePack(deliveredPacks, latestVersionsByName) {
  return stalePackNames(deliveredPacks, latestVersionsByName).length > 0;
}

/** "N read"/"N reads" for a pack snapshot entry; the one owner of that coercion and pluralization. */
export function readCountText(pack) {
  const reads = Number(pack?.reads) || 0;
  return `${reads} ${reads === 1 ? 'read' : 'reads'}`;
}

/** Reads since the last staleness notice, or null when no notice was ever taken. */
export function sinceNoticeCount(pack) {
  if (!pack || pack.readsSinceNotice == null) return null;
  return Number(pack.readsSinceNotice) || 0;
}
