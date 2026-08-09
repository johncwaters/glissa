'use strict';

// The trust classifier. Every access decision in remote mode reduces to these two functions.
//
// INVARIANT: trust comes from the LISTENER a socket landed on (req.socket.localPort), never from the
// peer address, never from X-Forwarded-For, never from any other client-supplied header. A reverse
// proxy makes remote traffic look loopback at the IP level, so an IP-based rule would hand every
// remote visitor the unauthenticated local trust level. The listener port cannot be spoofed by a
// client: it is whichever socket the kernel accepted the connection on.

const { decideOriginAllowed } = require('./origin-policy');

const PAIR_PATH_PREFIX = '/pair/';

function classifyRequestOrigin({ localPort, remoteListenerPort }) {
  if (remoteListenerPort == null) return 'local';
  return localPort === remoteListenerPort ? 'remote' : 'local';
}

function isPairPath(pathname) {
  if (typeof pathname !== 'string') return false;
  return pathname === '/pair' || pathname.startsWith(PAIR_PATH_PREFIX);
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
 */
function decideUpgradeAccess({ remoteEnabled, trust, origin, allowedOrigins, authenticated }) {
  if (!decideOriginAllowed(origin, allowedOrigins)) return { allow: false, reason: 'origin' };
  if (!remoteEnabled) return { allow: true, reason: null };
  if (trust !== 'remote') return { allow: true, reason: null };
  if (authenticated !== true) return { allow: false, reason: 'auth' };
  return { allow: true, reason: null };
}

/**
 * Server-side side effects that only make sense ON the machine Glissa runs on. Opening a run
 * artifact spawns the configured editor there, so honoring the request for a remote-classified
 * control connection puts a window on a desk the operator is not sitting at and reports success. A
 * remote connection gets an explicit refusal instead; local connections are unchanged, and an
 * unclassified connection (remote mode off, so no trust was ever stamped) is local by definition.
 */
function decideEditorOpenAccess(trust) {
  if (trust === 'remote') return { allow: false, reason: 'remote' };
  return { allow: true, reason: null };
}

/**
 * Display metadata handed to a control-WS client so its UI can stop offering actions that only make
 * sense on the machine Glissa runs on. Same 'remote' test as every decision above, and an unstamped
 * connection (remote mode off) is local by definition. This is NOT a boundary: a paired device is
 * full-trust by design, so nothing may be enforced client-side on the strength of this label.
 */
function clientTrustLabel(trust) {
  return trust === 'remote' ? 'remote' : 'local';
}

module.exports = {
  classifyRequestOrigin, decideRequestAccess, decideUpgradeAccess, decideEditorOpenAccess, isPairPath,
  clientTrustLabel,
};
