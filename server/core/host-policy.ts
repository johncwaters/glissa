const LOOPBACK_HOST_RE = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|\[::ffff:127(?:\.\d{1,3}){3}\])$/;

function hostOnly(value: unknown): string {
  const trimmed = String(value == null ? '' : value).trim().toLowerCase();
  if (trimmed === '') return '';
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    if (close === -1) return '';
    return trimmed.slice(0, close + 1);
  }
  const colon = trimmed.lastIndexOf(':');
  if (colon === -1) return trimmed;
  return trimmed.slice(0, colon);
}

function hostMatches(allowed: string, candidate: string): boolean {
  if (allowed === '') return false;
  if (allowed === candidate) return true;
  if (!allowed.startsWith('*.')) return false;
  const suffix = allowed.slice(1);
  return candidate.endsWith(suffix) && candidate.length > suffix.length;
}

function decideHostAllowed(hostHeader: string | undefined | null, allowedHosts: string[] | string = []): boolean {
  if (hostHeader == null || hostHeader === '') return true;
  const host = hostOnly(hostHeader);
  if (host === '') return false;
  if (LOOPBACK_HOST_RE.test(host)) return true;
  const list = Array.isArray(allowedHosts) ? allowedHosts : [allowedHosts];
  return list.some((entry) => hostMatches(hostOnly(entry), host));
}

export { decideHostAllowed, hostOnly };
