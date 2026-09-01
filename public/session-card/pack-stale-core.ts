export interface DeliveredPack {
  name?: unknown;
  version?: unknown;
}

export type LatestPackVersions = Map<string, string | null> | Record<string, string | null>;

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

export function hasStalePack(deliveredPacks: readonly DeliveredPack[] | unknown, latestVersionsByName: LatestPackVersions | null | undefined) {
  return stalePackNames(deliveredPacks, latestVersionsByName).length > 0;
}
