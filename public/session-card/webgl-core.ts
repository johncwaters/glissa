export function pickEvictionVictims<Key>(lruKeys: readonly Key[], cap: number, protectedKeys: readonly Key[] | Key = []): Key[] {
  const protectedKeySet = new Set<Key>(Array.isArray(protectedKeys) ? protectedKeys : [protectedKeys as Key]);
  const remaining = [...lruKeys];
  const victims: Key[] = [];
  while (remaining.length >= cap) {
    const idx = remaining.findIndex((key) => !protectedKeySet.has(key));
    if (idx === -1) break;
    victims.push(remaining[idx]);
    remaining.splice(idx, 1);
  }
  return victims;
}
