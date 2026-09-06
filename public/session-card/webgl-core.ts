export function pickEvictionVictims<Key>(lruKeys: readonly Key[], cap: number, protectedKeys: readonly Key[] | Key = []): Key[] {
  const protectedKeySet = new Set<Key>(Array.isArray(protectedKeys) ? protectedKeys : [protectedKeys as Key]);
  const victims: Key[] = [];
  for (const key of lruKeys) {
    if (lruKeys.length - victims.length >= cap && !protectedKeySet.has(key)) victims.push(key);
  }
  return victims;
}
