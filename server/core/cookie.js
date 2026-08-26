'use strict';

// Hand-rolled cookie parse/serialize. Glissa takes no dependency for this: the whole surface is one
// header in and one header out, and the auth path must not grow a supply chain.

const COOKIE_NAME = 'glissa_device';

function parseCookieHeader(header) {
  const out = {};
  if (typeof header !== 'string' || header === '') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === '') continue;
    const value = part.slice(eq + 1).trim();
    if (name in out) continue; // first wins, so a trailing forged duplicate cannot override
    out[name] = value;
  }
  return out;
}

function serializeSetCookie(name, value, opts = {}) {
  const {
    maxAgeSeconds = null,
    secure = false,
    sameSite = 'Lax',
    path = '/',
    httpOnly = true,
  } = opts;
  const parts = [`${name}=${value}`];
  parts.push(`Path=${path}`);
  if (maxAgeSeconds != null) parts.push(`Max-Age=${Math.floor(maxAgeSeconds)}`);
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  if (sameSite) parts.push(`SameSite=${sameSite}`);
  return parts.join('; ');
}

/**
 * Cookie value is "<deviceId>.<secret>". The id is the lookup key; the secret is compared against a
 * stored hash. Split on the FIRST dot only, so a secret containing one cannot shift the boundary.
 */
function readDeviceCookie(header, cookieName = COOKIE_NAME) {
  const jar = parseCookieHeader(header);
  const raw = jar[cookieName];
  if (typeof raw !== 'string' || raw === '') return null;
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return null;
  return { id: raw.slice(0, dot), secret: raw.slice(dot + 1) };
}

/**
 * Secure comes from X-Forwarded-Proto because the remote listener itself speaks plain http behind
 * tailscale serve; forging that header can only ADD Secure, which locks the forger out rather than
 * in. The proxy's word WINS whenever it speaks, GLISSA_INSECURE_BIND included: a browser genuinely
 * on TLS must get a Secure cookie, and letting a wider bind veto that would strip the flag from
 * every proxied request. With no header the listener is itself what the browser reached, and it
 * serves plain http in both the loopback and the insecure-bind case, so Secure is off either way -
 * which is why the bind mode is not an input here at all.
 */
/** @param {any} options */
function decideCookieFlags({ forwardedProto } = /** @type {any} */ ({})) {
  const first = typeof forwardedProto === 'string' ? forwardedProto.split(',')[0].trim().toLowerCase() : '';
  return { secure: first === 'https', sameSite: 'Lax' };
}

module.exports = { COOKIE_NAME, parseCookieHeader, serializeSetCookie, readDeviceCookie, decideCookieFlags };
