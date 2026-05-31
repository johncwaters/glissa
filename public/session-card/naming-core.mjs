// Pure session-name helpers. The sessionUIs-backed wrappers
// (countSessionsByName / suggestSessionName) live in naming.js and pass the list
// of current display names into these functions.

// True when `name` is exactly `baseName` or matches `baseName (N)` where N is a
// positive integer suffix produced by nextSuggestedName. Excludes unrelated
// parenthetical names like `Foo (legacy)`.
export function isAutoNameOf(name, baseName) {
  if (name === baseName) return true;
  const prefix = `${baseName} (`;
  if (!name.startsWith(prefix) || !name.endsWith(')')) return false;
  const inner = name.slice(prefix.length, -1);
  return /^\d+$/.test(inner);
}

// Count names that are `baseName` or `baseName (N)`.
export function countAutoNames(baseName, names) {
  let n = 0;
  for (const name of names) {
    if (isAutoNameOf(name, baseName)) n++;
  }
  return n;
}

// First free name in the sequence `baseName`, `baseName (2)`, `baseName (3)`, ...
// `names` is the set of existing display names. Bounded by 999 to keep the suffix
// within the 64-char server name limit; falls back to a timestamped suffix.
export function nextSuggestedName(baseName, names) {
  const taken = new Set(names);
  if (!taken.has(baseName)) return baseName;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${baseName} (${i})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${baseName} (${Date.now()})`;
}
