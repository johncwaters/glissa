'use strict';

// Pure Origin-header policy for WebSocket upgrades. Replaces the inline isAllowedOrigin that used to
// live in backend.js; with an empty allow-list it reproduces that function's decisions exactly, which
// is what keeps the default (remote-disabled) build behaving byte-identically.
//
// The Origin header is the ONE browser-supplied value that is load-bearing here, and only in the
// restrictive direction: a forged Origin can lose access, never gain it, because the device cookie is
// checked separately. A missing Origin is allowed because non-browser clients (curl, a ws CLI, the
// container test harness) never send one and cannot be CSRF'd.

const DEFAULT_PORT_BY_SCHEME = { http: '80', https: '443', ws: '80', wss: '443' };
const ORIGIN_RE = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)$/i;

function splitHostPort(authority) {
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close === -1) return { host: '', port: '' };
    const host = authority.slice(0, close + 1);
    const rest = authority.slice(close + 1);
    if (rest === '') return { host, port: '' };
    if (!rest.startsWith(':')) return { host: '', port: '' };
    return { host, port: rest.slice(1) };
  }
  const colon = authority.lastIndexOf(':');
  if (colon === -1) return { host: authority, port: '' };
  return { host: authority.slice(0, colon), port: authority.slice(colon + 1) };
}

/**
 * "https://Example.COM:443/" -> "https://example.com". Returns null for anything that is not a bare
 * origin (a path, userinfo, garbage), which the caller treats as a refusal. Hand-parsed rather than
 * via URL because a wildcard entry ("https://*.ts.net") is not a valid URL and must survive the same
 * normalization as the header it is compared against.
 */
function normalizeOrigin(str) {
  if (typeof str !== 'string') return null;
  const trimmed = str.trim().replace(/\/+$/, '');
  if (trimmed === '') return null;
  const match = ORIGIN_RE.exec(trimmed);
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  const authority = match[2].toLowerCase();
  if (authority.includes('@')) return null;
  const { host, port } = splitHostPort(authority);
  if (host === '') return null;
  if (port !== '' && !/^\d+$/.test(port)) return null;
  if (port === '' || port === DEFAULT_PORT_BY_SCHEME[scheme]) return `${scheme}://${host}`;
  return `${scheme}://${host}:${port}`;
}

function hostOf(normalized) {
  const authority = normalized.slice(normalized.indexOf('://') + 3);
  return splitHostPort(authority).host;
}

function schemeAndPortOf(normalized) {
  const idx = normalized.indexOf('://');
  const authority = normalized.slice(idx + 3);
  return { scheme: normalized.slice(0, idx), port: splitHostPort(authority).port };
}

// "https://*.ts.net" matches "https://box.ts.net" but never the bare apex, and never across a scheme
// or port change. A wildcard is only ever a host-label wildcard; there is deliberately no "*" alone.
function wildcardMatches(allowed, candidate) {
  const allowedHost = hostOf(allowed);
  if (!allowedHost.startsWith('*.')) return false;
  const suffix = allowedHost.slice(1);
  const candidateHost = hostOf(candidate);
  if (!candidateHost.endsWith(suffix) || candidateHost.length <= suffix.length) return false;
  const a = schemeAndPortOf(allowed);
  const c = schemeAndPortOf(candidate);
  return a.scheme === c.scheme && a.port === c.port;
}

/**
 * @param {string|undefined|null} originHeader raw Origin header
 * @param {string[]} allowedOrigins configured remote origins (may be empty)
 */
function decideOriginAllowed(originHeader, allowedOrigins) {
  if (originHeader == null || originHeader === '') return true;
  const candidate = normalizeOrigin(originHeader);
  if (!candidate) return false;
  const host = hostOf(candidate);
  // Preserved verbatim from the old isAllowedOrigin: the dashboard is a localhost app first.
  if (host === 'localhost' || host === '127.0.0.1') return true;
  const list = Array.isArray(allowedOrigins) ? allowedOrigins : [];
  for (const entry of list) {
    const allowed = normalizeOrigin(entry);
    if (!allowed) continue;
    if (allowed === candidate) return true;
    if (wildcardMatches(allowed, candidate)) return true;
  }
  return false;
}

module.exports = { normalizeOrigin, decideOriginAllowed };
