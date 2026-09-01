'use strict';

// The trust classifier. Every access decision in remote mode reduces to these two functions.
//
// INVARIANT: trust comes from the LISTENER a socket landed on (req.socket.localPort), never from the
// peer address, never from X-Forwarded-For, never from any other client-supplied header. A reverse
// proxy makes remote traffic look loopback at the IP level, so an IP-based rule would hand every
// remote visitor the unauthenticated local trust level. The listener port cannot be spoofed by a
// client: it is whichever socket the kernel accepted the connection on.

const { normalizeClientTrust } = require('../../shared/client-trust.ts');
const { decideOriginAllowed } = require('./origin-policy.ts');

const PAIR_PATH_PREFIX = '/pair/';

function classifyRequestOrigin({ localPort, remoteListenerPort }) {
  if (remoteListenerPort == null) return 'local';
  return localPort === remoteListenerPort ? 'remote' : 'local';
}

/**
 * Request target -> the pathname express.static will actually resolve. The guard below has to see the
 * SAME string express does, or it guards a different resource than the one served: express.static
 * percent-decodes and resolves dot segments, so the raw "/pair/%2e%2e/index.html" reads as a pair path
 * to a naive prefix check while serving /index.html to an unpaired remote device (reproduced in the
 * 2026-08 review pass). Decoding once matches express; a dot segment surviving that decode, a second
 * layer of encoding, or a decode that throws all come back `suspicious`, which no allow decision may
 * be built on.
 */
function normalizePathname(url) {
  const raw = typeof url === 'string' ? url : '';
  const cut = raw.search(/[?#]/);
  const pathOnly = cut === -1 ? raw : raw.slice(0, cut);
  let decoded;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    return { pathname: pathOnly, suspicious: true };
  }
  const suspicious = decoded.split('/').some((segment) => (
    segment === '.' || segment === '..' || /%2e/i.test(segment)
  ));
  return { pathname: decoded, suspicious };
}

function isPairPath(pathname) {
  if (typeof pathname !== 'string') return false;
  const normalized = normalizePathname(pathname);
  if (normalized.suspicious) return false;
  return normalized.pathname === '/pair' || normalized.pathname.startsWith(PAIR_PATH_PREFIX);
}

/**
 * HTTP access. /pair/* is the ONLY unauthenticated surface on the remote listener - the redemption
 * page has to be reachable by a device that has no cookie yet. /hook/ is deliberately NOT exempt:
 * Claude Code hooks are posted by a locally spawned process on the local listener, so a
 * remote-classified hook POST is refused before it reaches the route (strictly tighter than today).
 */
function decideRequestAccess({ remoteEnabled, trust, pathname, authenticated }) {
  if (!remoteEnabled) return { allow: true, action: 'allow' };
  if (trust !== 'remote') return { allow: true, action: 'allow' };
  if (isPairPath(pathname)) return { allow: true, action: 'pair-page' };
  if (authenticated === true) return { allow: true, action: 'allow' };
  return { allow: false, action: 'unauthorized' };
}

/**
 * WebSocket upgrade access. Origin is checked on BOTH listeners (it is the CSRF guard for the control
 * channel, which mutates state); the cookie is required only for remote-classified sockets.
 *
 * `dashboardRoute` marks the two channels only the dashboard page ever opens (control and data). They
 * carry the two extra layers the 2026-08 security pass added: an Origin is mandatory (a browser always
 * sends one, so this costs only non-browser clients, which have no business on these paths) and a
 * local socket must present the page token. Every other route (the Visions editor relay) keeps the
 * old rules, which is what lets a non-browser client still use it.
 *
 * A REMOTE socket is exempt from the token: its credential is the pairing cookie, and that path is
 * deliberately left exactly as it was.
 */
function decideUpgradeAccess({
  remoteEnabled, trust, origin, allowedOrigins, authenticated,
  listenerPorts = [], dashboardRoute = false, tokenOk = false,
}) {
  const originOk = decideOriginAllowed(origin, allowedOrigins, {
    listenerPorts,
    requireOrigin: dashboardRoute,
  });
  if (!originOk) return { allow: false, reason: 'origin' };
  if (remoteEnabled && trust === 'remote') {
    if (authenticated !== true) return { allow: false, reason: 'auth' };
    return { allow: true, reason: null };
  }
  if (dashboardRoute && tokenOk !== true) return { allow: false, reason: 'token' };
  return { allow: true, reason: null };
}

module.exports = {
  classifyRequestOrigin, decideRequestAccess, decideUpgradeAccess, isPairPath, normalizePathname,
  // The label handed to a control-WS client so its UI can stop offering actions that only make sense
  // on the machine Glissa runs on. It lives in shared/ because the browser applies the same rule to
  // the label it receives, and re-exports here so this module stays the one-stop trust API. This is
  // NOT a boundary: a paired device is full-trust by design, so nothing may be enforced client-side
  // on the strength of it.
  normalizeClientTrust,
};
