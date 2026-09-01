interface ScopeProject {
  id?: unknown;
  path?: unknown;
}

function collapseDotSegments(value: string): string {
  const out: string[] = [];
  for (const part of value.split('/')) {
    if (part === '.') continue;
    if (part === '..' && out.length > 0 && out[out.length - 1] !== '..' && out[out.length - 1] !== '') {
      out.pop();
      continue;
    }
    if (part === '..' && out.length === 1 && out[0] === '') continue;
    out.push(part);
  }
  return out.join('/');
}

function normalizeShapePath(input: unknown): string {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return '';
  let normalized = raw.replace(/\\/g, '/');
  const isUnc = normalized.startsWith('//');
  normalized = collapseDotSegments(normalized.replace(/\/{2,}/g, '/'));
  if (isUnc) normalized = `/${normalized}`;
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, '');
  const isWindowsShaped = isUnc || /^[a-zA-Z]:($|\/)/.test(normalized);
  if (isWindowsShaped) return normalized.toLowerCase();
  return normalized;
}

function pathOfFileUri(uri: unknown): string | null {
  if (typeof uri !== 'string' || !uri) return null;
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'file:') return null;
  let pathname = '';
  try {
    pathname = decodeURIComponent(parsed.pathname || '');
  } catch {
    return null;
  }
  if (parsed.hostname) return normalizeShapePath(`//${parsed.hostname}${pathname}`);
  const drivePath = pathname.match(/^\/([a-zA-Z]:)(\/.*|$)/);
  if (drivePath) return normalizeShapePath(`${drivePath[1]}${drivePath[2]}`);
  return normalizeShapePath(pathname);
}

function isWithin(scopePath: string, uriPath: string): boolean {
  if (!scopePath || !uriPath) return false;
  if (uriPath === scopePath) return true;
  const prefix = scopePath.endsWith('/') ? scopePath : `${scopePath}/`;
  return uriPath.startsWith(prefix);
}

function isUriInProjects(uri: unknown, normalizedProjectPaths: string[] | null | undefined): boolean {
  if (!Array.isArray(normalizedProjectPaths) || normalizedProjectPaths.length === 0) return true;
  const uriPath = pathOfFileUri(uri);
  if (!uriPath) return false;
  return normalizedProjectPaths.some((scopePath) => isWithin(scopePath, uriPath));
}

// Nested roots resolve to the DEEPEST one that contains the path: a project checked out inside another
// owns its own files, and the shallower root would otherwise claim every one of them.
function deepestRootFor(normalizedPath: string, roots: unknown): string | null {
  let owner: string | null = null;
  for (const raw of Array.isArray(roots) ? roots : []) {
    const root = normalizeShapePath(raw);
    if (!isWithin(root, normalizedPath)) continue;
    if (owner && owner.length >= root.length) continue;
    owner = root;
  }
  return owner;
}

function projectForUri(uri: unknown, scopeProjects: ScopeProject[] | null | undefined): string | null {
  if (!Array.isArray(scopeProjects) || scopeProjects.length === 0) return null;
  const uriPath = pathOfFileUri(uri);
  if (!uriPath) return null;
  const owned = scopeProjects
    .filter((entry): entry is { id: string; path?: unknown } => Boolean(entry) && typeof entry.id === 'string' && entry.id !== '')
    .map((entry) => ({ id: entry.id, path: normalizeShapePath(entry.path) }));
  const root = deepestRootFor(uriPath, owned.map((entry) => entry.path));
  const owner = owned.find((entry) => entry.path === root);
  return owner ? owner.id : null;
}

function scopePathsOf(scopeProjects: ScopeProject[] | null | undefined): string[] | null {
  if (!Array.isArray(scopeProjects) || scopeProjects.length === 0) return null;
  const paths: string[] = [];
  for (const entry of scopeProjects) {
    const scopePath = normalizeShapePath(entry?.path);
    if (!scopePath || paths.includes(scopePath)) continue;
    paths.push(scopePath);
  }
  return paths.length > 0 ? paths : null;
}

export { deepestRootFor, pathOfFileUri, normalizeShapePath, isUriInProjects, projectForUri, scopePathsOf };
