// Pure WebGL-context LRU eviction policy. The addon glue (dispose/create) lives
// in webgl-pool.js; this is the testable decision: given the current LRU key
// order (oldest first), the cap, and keys to spare, return the keys to evict so
// the live-context count stays under the cap.

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
