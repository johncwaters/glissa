'use strict';

// Pure Origin-header policy for WebSocket upgrades. Replaces the inline isAllowedOrigin that used to
// live in backend.js.
//
// The Origin header is the ONE browser-supplied value that is load-bearing here, and only in the
// restrictive direction: a forged Origin can lose access, never gain it, because the device cookie is
// checked separately.
//
// TWO DELIBERATE DIVERGENCES from the original isAllowedOrigin, both from the 2026-08 security pass:
//
// 1. A loopback origin is admitted only on a LISTENER port. The old rule admitted any localhost or
//    127.0.0.1 origin whatever its port, so any other web app on the machine (a dev server, a
//    notebook, Grafana) or an XSS in one could open /control and spawn a permissionless session. That
//    is not the accepted "any local process is trusted" tradeoff: it extends it to any page the
//    operator visits on another local port. The caller passes the port the socket actually landed on.
// 2. A missing Origin can be refused. Non-browser clients (curl, a ws CLI, the editor relay) never
//    send one, so the caller opts in per route: the dashboard channels (control, data) require it,
//    while the HTTP ingresses and the Visions relay keep accepting an absent Origin.

const LOOPBACK_ORIGIN_HOSTS = new Set(['localhost', '127.0.0.1']);

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

// The port a browser actually connected to, with the scheme's default filled in for an origin that
// carries none ("http://localhost" is port 80, and is a listener origin only on a server bound there).
function portNumberOf(normalized) {
  const { scheme, port } = schemeAndPortOf(normalized);
  const effective = port === '' ? DEFAULT_PORT_BY_SCHEME[scheme] : port;
  if (!effective) return null;
  return Number.parseInt(effective, 10);
}

function isListenerPort(listenerPorts, port) {
  if (port == null) return false;
  const list = Array.isArray(listenerPorts) ? listenerPorts : [listenerPorts];
  return list.some((candidate) => Number(candidate) === port);
}

/**
 * @param {string|undefined|null} originHeader raw Origin header
 * @param {string[]} allowedOrigins configured remote origins (may be empty)
 * @param {object} [options]
 * @param {number[]|number} [options.listenerPorts] ports this server is reachable on; a loopback
 *   origin on any other port falls through to the allow-list instead of being admitted outright
 * @param {boolean} [options.requireOrigin] refuse a request that carries no Origin at all
 */
function decideOriginAllowed(originHeader, allowedOrigins, { listenerPorts = [], requireOrigin = false } = {}) {
  if (originHeader == null || originHeader === '') return !requireOrigin;
  const candidate = normalizeOrigin(originHeader);
  if (!candidate) return false;
  const host = hostOf(candidate);
  // Port-exact, and a mismatch falls through rather than refusing: an operator may legitimately list
  // "http://localhost:8080" for a local reverse proxy, and that entry must still win.
  if (LOOPBACK_ORIGIN_HOSTS.has(host) && isListenerPort(listenerPorts, portNumberOf(candidate))) return true;
  const list = Array.isArray(allowedOrigins) ? allowedOrigins : [];
  for (const entry of list) {
    const allowed = normalizeOrigin(entry);
    if (!allowed) continue;
    if (allowed === candidate) return true;
    if (wildcardMatches(allowed, candidate)) return true;
  }
  return false;
}

// The host an allow-list entry names, for the Host policy: one configured "https://*.ts.net" then
// means the same thing to both checks instead of being restated as a bare hostname somewhere else.
function hostOfOrigin(str) {
  const normalized = normalizeOrigin(str);
  return normalized ? hostOf(normalized) : '';
}

module.exports = { normalizeOrigin, decideOriginAllowed, hostOfOrigin };
