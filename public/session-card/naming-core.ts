export function isAutoNameOf(name: string, baseName: string) {
  if (name === baseName) return true;
  const prefix = `${baseName} (`;
  if (!name.startsWith(prefix) || !name.endsWith(')')) return false;
  const inner = name.slice(prefix.length, -1);
  return /^\d+$/.test(inner);
}

export function countAutoNames(baseName: string, names: readonly string[]) {
  let n = 0;
  for (const name of names) {
    if (isAutoNameOf(name, baseName)) n++;
  }
  return n;
}

export function nextSuggestedName(baseName: string, names: readonly string[]) {
  const taken = new Set(names);
  if (!taken.has(baseName)) return baseName;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${baseName} (${i})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${baseName} (${Date.now()})`;
}
