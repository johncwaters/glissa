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
  const uriPath = pathOfFileUri(uri);
  if (!uriPath) return false;
  return (Array.isArray(normalizedProjectPaths) ? normalizedProjectPaths : []).some((scopePath) => isWithin(scopePath, uriPath));
}

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

function scopePathsOf(scopeProjects: ScopeProject[] | null | undefined): string[] {
  const paths: string[] = [];
  for (const entry of Array.isArray(scopeProjects) ? scopeProjects : []) {
    const scopePath = normalizeShapePath(entry?.path);
    if (!scopePath || paths.includes(scopePath)) continue;
    paths.push(scopePath);
  }
  return paths;
}

function resolveVisionsScopeProjects({ configuredIds, projects, warn }: {
  configuredIds: unknown;
  projects: unknown;
  warn: (message: string) => void;
}): { id: string; path: string }[] {
  const usable: { id: string; path: string }[] = [];
  const seenPaths = new Set<string>();
  for (const project of Array.isArray(projects) ? projects : []) {
    if (!project || typeof project.id !== 'string' || project.id === '') continue;
    const normalizedPath = normalizeShapePath(project.path);
    if (!normalizedPath || seenPaths.has(normalizedPath)) continue;
    seenPaths.add(normalizedPath);
    usable.push({ id: project.id, path: normalizedPath });
  }
  const ids = Array.isArray(configuredIds) ? configuredIds.filter((id): id is string => typeof id === 'string' && id !== '') : [];
  if (ids.length === 0) return usable;
  const wanted = new Set(ids);
  for (const id of ids) {
    if (!usable.some((project) => project.id === id)) warn(`[visions] configured project id not found or has no usable path: ${id}`);
  }
  return usable.filter((project) => wanted.has(project.id));
}

export { deepestRootFor, pathOfFileUri, normalizeShapePath, isUriInProjects, projectForUri, resolveVisionsScopeProjects, scopePathsOf };
