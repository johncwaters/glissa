const DATA_PATH_PREFIX = '/terminals/';

function upgradePathname(rawUrl: unknown): string {
  if (typeof rawUrl !== 'string') return '';
  const queryOrFragmentAt = rawUrl.search(/[?#]/);
  if (queryOrFragmentAt === -1) return rawUrl;
  return rawUrl.slice(0, queryOrFragmentAt);
}

function classifyUpgradePath(rawUrl: unknown): 'control' | 'visions' | 'data' | 'unknown' {
  const pathname = upgradePathname(rawUrl);
  if (pathname === '/control') return 'control';
  if (pathname === '/visions') return 'visions';
  if (pathname.startsWith(DATA_PATH_PREFIX)) return 'data';
  return 'unknown';
}

function dataSessionIdFromUrl(rawUrl: unknown): string | null {
  const pathname = upgradePathname(rawUrl);
  if (!pathname.startsWith(DATA_PATH_PREFIX)) return null;
  const encodedId = pathname.slice(pathname.lastIndexOf('/') + 1);
  if (!encodedId) return null;
  try {
    return decodeURIComponent(encodedId);
  } catch {
    return null;
  }
}

function upgradeTokenFromUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string') return null;
  const queryAt = rawUrl.indexOf('?');
  if (queryAt === -1) return null;
  const query = rawUrl.slice(queryAt + 1).split('#')[0];
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq) !== 'token') continue;
    try {
      return decodeURIComponent(pair.slice(eq + 1));
    } catch {
      return null;
    }
  }
  return null;
}

export { upgradePathname, classifyUpgradePath, dataSessionIdFromUrl, upgradeTokenFromUrl };
