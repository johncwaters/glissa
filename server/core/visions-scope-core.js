'use strict';

function collapseDotSegments(value) {
  const out = [];
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

function normalizeShapePath(input) {
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

function pathOfFileUri(uri) {
  if (typeof uri !== 'string' || !uri) return null;
  let parsed = null;
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

function isWithin(scopePath, uriPath) {
  if (!scopePath || !uriPath) return false;
  if (uriPath === scopePath) return true;
  const prefix = scopePath.endsWith('/') ? scopePath : `${scopePath}/`;
  return uriPath.startsWith(prefix);
}

function isUriInProjects(uri, normalizedProjectPaths) {
  if (!Array.isArray(normalizedProjectPaths) || normalizedProjectPaths.length === 0) return true;
  const uriPath = pathOfFileUri(uri);
  if (!uriPath) return false;
  return normalizedProjectPaths.some((scopePath) => isWithin(scopePath, uriPath));
}

// Nested roots resolve to the DEEPEST one that contains the uri: a project checked out inside another
// owns its own files, and the shallower root would otherwise claim every one of them.
function projectForUri(uri, scopeProjects) {
  if (!Array.isArray(scopeProjects) || scopeProjects.length === 0) return null;
  const uriPath = pathOfFileUri(uri);
  if (!uriPath) return null;
  let owner = null;
  for (const entry of scopeProjects) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) continue;
    const scopePath = normalizeShapePath(entry.path);
    if (!isWithin(scopePath, uriPath)) continue;
    if (owner && owner.path.length >= scopePath.length) continue;
    owner = { id: entry.id, path: scopePath };
  }
  return owner ? owner.id : null;
}

function scopePathsOf(scopeProjects) {
  if (!Array.isArray(scopeProjects) || scopeProjects.length === 0) return null;
  const paths = [];
  for (const entry of scopeProjects) {
    const scopePath = normalizeShapePath(entry?.path);
    if (!scopePath || paths.includes(scopePath)) continue;
    paths.push(scopePath);
  }
  return paths.length > 0 ? paths : null;
}

module.exports = {
  pathOfFileUri,
  normalizeShapePath,
  isUriInProjects,
  projectForUri,
  scopePathsOf,
};
