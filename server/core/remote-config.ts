export interface RemoteConfig {
  enabled: boolean;
  port: number | null;
  publicHost: string;
  allowedOrigins: string[];
}

function toPort(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

function normalizeRemoteConfig(raw: unknown): RemoteConfig {
  const src: Record<string, unknown> = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  const enabled = src.enabled === true;
  const port = toPort(src.port);
  const publicHost = typeof src.publicHost === 'string' ? src.publicHost.trim() : '';
  if (!enabled) return { enabled, port, publicHost, allowedOrigins: [] };
  const listed = Array.isArray(src.allowedOrigins)
    ? src.allowedOrigins.filter((o): o is string => typeof o === 'string' && o.trim() !== '').map((o) => o.trim())
    : [];
  if (listed.length === 0 && publicHost !== '') {
    return { enabled, port, publicHost, allowedOrigins: [`https://${publicHost}`] };
  }
  return { enabled, port, publicHost, allowedOrigins: listed };
}

function validateRemoteConfig(
  remote: { enabled?: boolean; port?: number | null } | null | undefined,
  localPort: number,
): { ok: boolean; error: string | null } {
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

function isLoopbackHost(host: unknown): boolean {
  if (typeof host !== 'string') return false;
  const bare = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (bare === '' || bare === 'localhost') return bare === 'localhost';
  if (bare === '::1' || bare === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

function decideBindHost({ envHost, insecureBind }: { envHost?: unknown; insecureBind?: unknown } = {}): {
  host: string;
  allowed: boolean;
  reason: string | null;
} {
  const host = typeof envHost === 'string' ? envHost.trim() : '';
  if (host === '') return { host: '127.0.0.1', allowed: true, reason: null };
  if (isLoopbackHost(host)) return { host, allowed: true, reason: null };
  if (insecureBind === true) return { host, allowed: true, reason: 'insecure-bind' };
  return { host, allowed: false, reason: 'non-loopback' };
}

export { normalizeRemoteConfig, validateRemoteConfig, isLoopbackHost, decideBindHost };
