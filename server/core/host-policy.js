'use strict';

// Pure Host-header policy. Defense in depth against DNS rebinding, NOT the missing lock: the upgrade
// path already runs the Origin check unconditionally on both listeners, so a rebound page carrying
// "Origin: http://evil.com" loses its WebSocket regardless. What is left is HTTP only (static assets
// and the two token-gated write ingresses), and this closes that.
//
// An ABSENT Host is allowed. Rebinding works by pointing a name at 127.0.0.1 and letting the browser
// send that name, so an attack always carries one; refusing an absent header would only break
// HTTP/1.0 clients that cannot be the attacker.

// A Host header always brackets an IPv6 literal (RFC 7230), which is also the only form the port
// split below can read back unambiguously, so the bare "::1" spelling is deliberately absent.
const LOOPBACK_HOST_RE = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|\[::ffff:127(?:\.\d{1,3}){3}\])$/;

// "box.ts.net:8443" -> "box.ts.net". IPv6 literals keep their brackets, which is also how a Host
// header carries them, so the loopback pattern above matches "[::1]" directly.
function hostOnly(value) {
  const trimmed = String(value == null ? '' : value).trim().toLowerCase();
  if (trimmed === '') return '';
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    return close === -1 ? '' : trimmed.slice(0, close + 1);
  }
  const colon = trimmed.lastIndexOf(':');
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

// Same host-label wildcard the origin allow-list uses ("*.ts.net" matches "box.ts.net", never the
// apex), so one configured entry means the same thing to both checks.
function hostMatches(allowed, candidate) {
  if (allowed === '') return false;
  if (allowed === candidate) return true;
  if (!allowed.startsWith('*.')) return false;
  const suffix = allowed.slice(1);
  return candidate.endsWith(suffix) && candidate.length > suffix.length;
}

/**
 * @param {string|undefined|null} hostHeader raw Host header
 * @param {string[]} allowedHosts extra hostnames (remote.publicHost, allow-listed origin hosts)
 */
function decideHostAllowed(hostHeader, allowedHosts = []) {
  if (hostHeader == null || hostHeader === '') return true;
  const host = hostOnly(hostHeader);
  if (host === '') return false;
  if (LOOPBACK_HOST_RE.test(host)) return true;
  const list = Array.isArray(allowedHosts) ? allowedHosts : [allowedHosts];
  return list.some((entry) => hostMatches(hostOnly(entry), host));
}

module.exports = { decideHostAllowed, hostOnly };
