const LOOPBACK_ORIGIN_HOSTS = new Set(['localhost', '127.0.0.1']);

const DEFAULT_PORT_BY_SCHEME: Record<string, string | undefined> = { http: '80', https: '443', ws: '80', wss: '443' };
const ORIGIN_RE = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)$/i;

function splitHostPort(authority: string): { host: string; port: string } {
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

function normalizeOrigin(str: unknown): string | null {
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

function hostOf(normalized: string): string {
  const authority = normalized.slice(normalized.indexOf('://') + 3);
  return splitHostPort(authority).host;
}

function schemeAndPortOf(normalized: string): { scheme: string; port: string } {
  const idx = normalized.indexOf('://');
  const authority = normalized.slice(idx + 3);
  return { scheme: normalized.slice(0, idx), port: splitHostPort(authority).port };
}

function wildcardMatches(allowed: string, candidate: string): boolean {
  const allowedHost = hostOf(allowed);
  if (!allowedHost.startsWith('*.')) return false;
  const suffix = allowedHost.slice(1);
  const candidateHost = hostOf(candidate);
  if (!candidateHost.endsWith(suffix) || candidateHost.length <= suffix.length) return false;
  const a = schemeAndPortOf(allowed);
  const c = schemeAndPortOf(candidate);
  return a.scheme === c.scheme && a.port === c.port;
}

function portNumberOf(normalized: string): number | null {
  const { scheme, port } = schemeAndPortOf(normalized);
  const effective = port === '' ? DEFAULT_PORT_BY_SCHEME[scheme] : port;
  if (!effective) return null;
  return Number.parseInt(effective, 10);
}

function isListenerPort(listenerPorts: number[] | number, port: number | null): boolean {
  if (port == null) return false;
  const list = Array.isArray(listenerPorts) ? listenerPorts : [listenerPorts];
  return list.some((candidate) => Number(candidate) === port);
}

function decideOriginAllowed(
  originHeader: string | undefined | null,
  allowedOrigins: unknown[],
  { listenerPorts = [], requireOrigin = false }: { listenerPorts?: number[] | number; requireOrigin?: boolean } = {},
): boolean {
  if (originHeader == null || originHeader === '') return !requireOrigin;
  const candidate = normalizeOrigin(originHeader);
  if (!candidate) return false;
  const host = hostOf(candidate);

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

function hostOfOrigin(str: unknown): string {
  const normalized = normalizeOrigin(str);
  if (!normalized) return '';
  return hostOf(normalized);
}

export { normalizeOrigin, decideOriginAllowed, hostOfOrigin };
