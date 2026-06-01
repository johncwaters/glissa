// Pure WebGL-context LRU eviction policy. The addon glue (dispose/create) lives
// in webgl-pool.js; this is the testable decision: given the current LRU key
// order (oldest first), the cap, and a key to spare, return the keys to evict so
// the live-context count stays under the cap. Mirrors the original
// `_evictWebglIfNeeded` loop (evict the oldest non-spared key while size >= cap).

export function pickEvictionVictims(lruKeys, cap, exceptKey) {
  const remaining = [...lruKeys];
  const victims = [];
  while (remaining.length >= cap) {
    const idx = remaining.findIndex((k) => k !== exceptKey);
    if (idx === -1) break;
    victims.push(remaining[idx]);
    remaining.splice(idx, 1);
  }
  return victims;
}
