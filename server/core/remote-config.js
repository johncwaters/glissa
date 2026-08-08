'use strict';

// Pure core for remote-mode configuration: normalization, validation, and the bind-host decision.
// No IO, no requires beyond this file's own logic, so the boot-refusal rules are unit-testable.
//
// Remote mode is a SECOND listener. The local listener stays 127.0.0.1 and unauthenticated; the
// remote listener is the one a reverse proxy (tailscale serve) fronts, and every request on it needs
// a paired device cookie. Trust is decided by which listener a socket landed on, never by a client
// header, so the only thing that can widen the trust boundary is a bind address change - which is
// exactly what decideBindHost gates.

const DEFAULT_REMOTE = { enabled: false, port: null, publicHost: '', allowedOrigins: [] };

function toPort(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

/**
 * Coerce whatever config.json holds under `remote` into the exact shape the rest of the code reads.
 * An absent/garbage key yields the inert default, so a config without `remote` behaves as before.
 * allowedOrigins defaults to the publicHost over https when the operator set a host but no list:
 * the common tailscale-serve deployment has exactly one browser origin and re-typing it is a
 * footgun (an empty list would silently fall back to localhost-only and reject the real dashboard).
 *
 * DISABLED MEANS EMPTY. allowedOrigins feeds the WebSocket origin check on BOTH listeners, so a
 * leftover publicHost in a switched-off remote block would widen the local listener's allow-list for
 * a feature that is not even running. Off is off: the origin policy then behaves exactly as it did
 * before remote mode existed.
 */
function normalizeRemoteConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const enabled = src.enabled === true;
  const port = toPort(src.port);
  const publicHost = typeof src.publicHost === 'string' ? src.publicHost.trim() : '';
  if (!enabled) return { enabled, port, publicHost, allowedOrigins: [] };
  const listed = Array.isArray(src.allowedOrigins)
    ? src.allowedOrigins.filter((o) => typeof o === 'string' && o.trim() !== '').map((o) => o.trim())
    : [];
  if (listed.length === 0 && publicHost !== '') {
    return { enabled, port, publicHost, allowedOrigins: [`https://${publicHost}`] };
  }
  return { enabled, port, publicHost, allowedOrigins: listed };
}

/**
 * Boot gate for a remote block. Anything wrong here is fatal at boot rather than degraded at
 * runtime: a remote listener that silently failed to come up looks identical to a proxy outage,
 * and a remote listener sharing the local port would classify authenticated traffic as trusted.
 */
function validateRemoteConfig(remote, localPort) {
  if (!remote || remote.enabled !== true) return { ok: true, error: null };
  if (remote.port == null) {
    return { ok: false, error: 'remote.enabled is true but remote.port is not set' };
  }
  if (!Number.isInteger(remote.port) || remote.port < 1 || remote.port > 65535) {
    return { ok: false, error: `remote.port must be an integer 1-65535 (got ${JSON.stringify(remote.port)})` };
  }
  if (remote.port === localPort) {
    return { ok: false, error: `remote.port (${remote.port}) must differ from the local port (${localPort})` };
  }
  return { ok: true, error: null };
}

function isLoopbackHost(host) {
  if (typeof host !== 'string') return false;
  const bare = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (bare === '' || bare === 'localhost') return bare === 'localhost';
  if (bare === '::1' || bare === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/**
 * Which address the listeners bind. Default and only safe answer is loopback: Glissa's control WS
 * accepts an arbitrary project path plus dangerouslySkipPermissions, so a listener reachable off-box
 * is remote code execution as the server account. A non-loopback GLISSA_HOST is therefore refused
 * unless GLISSA_INSECURE_BIND=1 states the intent out loud; the shell turns allowed:false into a
 * boot refusal rather than quietly falling back, so nobody thinks they are bound wide when they are not.
 */
function decideBindHost({ envHost, insecureBind } = {}) {
  const host = typeof envHost === 'string' ? envHost.trim() : '';
  if (host === '') return { host: '127.0.0.1', allowed: true, reason: null };
  if (isLoopbackHost(host)) return { host, allowed: true, reason: null };
  if (insecureBind === true) return { host, allowed: true, reason: 'insecure-bind' };
  return { host, allowed: false, reason: 'non-loopback' };
}

module.exports = {
  DEFAULT_REMOTE,
  normalizeRemoteConfig,
  validateRemoteConfig,
  isLoopbackHost,
  decideBindHost,
};
