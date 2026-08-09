'use strict';

/*
 * Pure classification of a WebSocket upgrade request target.
 *
 * The dashboard reconnects with `/control?since=<seq>` (public/control-ws.js), so matching the raw
 * request URL against '/control' by equality sent every in-page reconnect into the unknown-path
 * bucket: destroyed on the remote listener, stranded on the local one. Only a full page reload (which
 * has no cursor yet, so it asks for bare '/control') ever reconnected. Classification therefore runs
 * on the PATHNAME, never the raw URL.
 *
 * No IO and no throwing: the upgrade handler runs with no uncaughtException handler above it, so a
 * request target too malformed to read is 'unknown', never an exception.
 */

const DATA_PATH_PREFIX = '/terminals/';

// Query and fragment are cut with plain string slicing rather than WHATWG URL parsing: `new URL` also
// reinterprets an authority ('//host/control') and collapses dot segments, widening what counts as
// the control path for no benefit here.
function upgradePathname(rawUrl) {
  if (typeof rawUrl !== 'string') return '';
  const queryOrFragmentAt = rawUrl.search(/[?#]/);
  if (queryOrFragmentAt === -1) return rawUrl;
  return rawUrl.slice(0, queryOrFragmentAt);
}

function classifyUpgradePath(rawUrl) {
  const pathname = upgradePathname(rawUrl);
  if (pathname === '/control') return 'control';
  if (pathname.startsWith(DATA_PATH_PREFIX)) return 'data';
  return 'unknown';
}

// The session id a data-WS target addresses, or null when there is none to read: a non-data path, an
// empty last segment, or an undecodable one (a lone '%' throws in decodeURIComponent).
function dataSessionIdFromUrl(rawUrl) {
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

module.exports = { upgradePathname, classifyUpgradePath, dataSessionIdFromUrl };
