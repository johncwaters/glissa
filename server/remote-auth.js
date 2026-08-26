'use strict';

// IO shell for remote-mode authentication. Every decision it makes comes from a pure core
// (request-trust, cookie, pairing-token, origin-policy); this file only does crypto compares, HTTP
// plumbing, and the pairing-store lookups.
//
// THREAT MODEL, stated once: a valid device cookie is equivalent to a shell on this machine. The
// control WebSocket accepts an arbitrary project path plus dangerouslySkipPermissions, so anyone who
// reaches the dashboard can run code as the server account. That is why the pairing URL is treated as
// a password (single use, 10 minute TTL, never logged, never echoed back into an error page) and why
// the remote listener refuses everything except /pair/* until a cookie proves prior pairing.

const crypto = require('node:crypto');

const {
  COOKIE_NAME, readDeviceCookie, serializeSetCookie, decideCookieFlags,
} = require('./core/cookie');
const {
  hashSecret, decideDeviceAuth, deviceNameFromUserAgent, DEFAULT_DEVICE_MAX_AGE_MS,
} = require('./core/pairing-token');
const { classifyRequestOrigin, decideRequestAccess, normalizePathname } = require('./core/request-trust');

const DEVICE_COOKIE_MAX_AGE_SECONDS = Math.floor(DEFAULT_DEVICE_MAX_AGE_MS / 1000);

/** @typedef {{ id: string, secretHash: string, name: string, createdAt: number, revokedAt: number | null }} PairedDevice */
/** @typedef {{ watch: (onChange: () => void) => () => void, findDevice: (id: string) => PairedDevice | null, redeem: (token: string, options: { fallbackName: string }) => { ok: boolean, reason: string | null, device: PairedDevice | null, cookieValue?: string } }} PairingsStore */
/** @typedef {{ touch: (deviceId: string) => void }} SeenStore */

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Self-contained: the remote listener refuses static assets to an unpaired device, so an error page
// that referenced a stylesheet would render bare anyway.
function htmlPage(title, message) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body { background:#12131a; color:#e6e6ee; font:16px/1.5 system-ui, sans-serif; margin:0;
  display:flex; align-items:center; justify-content:center; min-height:100vh; padding:24px; }
main { max-width:32rem; }
h1 { font-size:1.25rem; margin:0 0 .5rem; }
p { margin:0; color:#a0a0b2; }
</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

// Constant-time compare of two hex digests. Length is checked first because timingSafeEqual throws on
// a mismatch; both operands are sha256 hex here, so unequal length only happens with a corrupt record.
function hashesMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * @param {object} deps
 * @param {{ enabled: boolean, port: number|null, publicHost: string, allowedOrigins: string[] }} deps.remote
 * @param {PairingsStore} deps.pairingsStore  createPairingsStore(...)
 * @param {SeenStore} [deps.seenStore]    createSeenStore(...), display-only lastSeenAt
 * @param {() => number} [deps.now]
 * @param {number} [deps.deviceMaxAgeMs]
 * @param {(message: string) => void} [deps.log]
 */
function createRemoteAuth({
  remote,
  pairingsStore,
  seenStore = null,
  now = Date.now,
  deviceMaxAgeMs = DEFAULT_DEVICE_MAX_AGE_MS,
  log = console.log,
}) {
  const remoteListenerPort = remote?.enabled ? remote.port : null;
  const stopWatch = pairingsStore.watch(() => {
    log('[remote] pairings.json changed - device list reloaded');
  });

  /** Cookie -> device record. Snapshot-only, so this never touches the disk. */
  function authenticate(req) {
    const parsed = readDeviceCookie(req.headers?.cookie, COOKIE_NAME);
    if (!parsed) return { ok: false, reason: 'no-cookie', device: null };
    const device = pairingsStore.findDevice(parsed.id);
    const secretMatches = device ? hashesMatch(hashSecret(parsed.secret), device.secretHash) : false;
    const verdict = decideDeviceAuth({ record: device, now: now(), maxAgeMs: deviceMaxAgeMs, secretMatches });
    if (!verdict.ok) return { ok: false, reason: verdict.reason, device: null };
    if (seenStore) seenStore.touch(device.id);
    return { ok: true, reason: null, device };
  }

  function trustOf(req) {
    return classifyRequestOrigin({
      localPort: req.socket ? req.socket.localPort : null,
      remoteListenerPort,
    });
  }

  function httpMiddleware(req, res, next) {
    const trust = trustOf(req);
    // The crypto compare only runs for remote-classified sockets; the local listener keeps its
    // existing zero-overhead path.
    const authenticated = trust === 'remote' ? authenticate(req).ok : false;
    // The DECODED pathname, so the /pair/* exemption is judged on the same string express.static will
    // resolve; a traversal that survives the decode comes back suspicious and can never read as /pair/.
    const decision = decideRequestAccess({
      remoteEnabled: Boolean(remote?.enabled),
      trust,
      pathname: normalizePathname(req.url).pathname,
      authenticated,
    });
    if (decision.allow) {
      next();
      return;
    }
    res.status(401)
      .type('html')
      .send(htmlPage('Pairing required', 'This device is not paired with Glissa. Run "glissa pair" on the host machine and open the link it prints.'));
  }

  function isUpgradeAuthorized(req) {
    return authenticate(req).ok;
  }

  function mountPairRoutes(app) {
    app.get('/pair/:token', (req, res) => {
      const outcome = pairingsStore.redeem(req.params.token, {
        fallbackName: deviceNameFromUserAgent(req.headers['user-agent']),
      });
      if (!outcome.ok) {
        // The token is deliberately absent from the response and from every log line.
        log(`[remote] pairing rejected (${outcome.reason})`);
        res.status(403)
          .type('html')
          .send(htmlPage('Pairing link not valid', 'This link was already used, has expired, or is not recognized. Run "glissa pair" on the host machine for a fresh one.'));
        return;
      }
      const flags = decideCookieFlags({ forwardedProto: req.headers['x-forwarded-proto'] });
      log(`[remote] paired device ${outcome.device.id} (${outcome.device.name})`);
      res.setHeader('Set-Cookie', serializeSetCookie(COOKIE_NAME, outcome.cookieValue, {
        maxAgeSeconds: DEVICE_COOKIE_MAX_AGE_SECONDS,
        secure: flags.secure,
        sameSite: flags.sameSite,
        httpOnly: true,
        path: '/',
      }));
      res.redirect(303, '/');
    });
  }

  function stop() {
    stopWatch();
  }

  return { httpMiddleware, isUpgradeAuthorized, mountPairRoutes, authenticate, trustOf, stop };
}

module.exports = { createRemoteAuth, DEVICE_COOKIE_MAX_AGE_SECONDS };
