import { normalizeClientTrust } from '../../shared/client-trust.ts';
import { decideOriginAllowed } from './origin-policy.ts';

const PAIR_PATH_PREFIX = '/pair/';

export type RequestTrust = 'local' | 'remote';

function classifyRequestOrigin({ localPort, remoteListenerPort }: {
  localPort?: number | null;
  remoteListenerPort?: number | null;
}): RequestTrust {
  if (remoteListenerPort == null) return 'local';
  return localPort === remoteListenerPort ? 'remote' : 'local';
}

function normalizePathname(url: unknown): { pathname: string; suspicious: boolean } {
  const raw = typeof url === 'string' ? url : '';
  const cut = raw.search(/[?#]/);
  const pathOnly = cut === -1 ? raw : raw.slice(0, cut);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    return { pathname: pathOnly, suspicious: true };
  }
  const suspicious = decoded.split('/').some((segment) => (
    segment === '.' || segment === '..' || /%2e/i.test(segment)
  ));
  return { pathname: decoded, suspicious };
}

function isPairPath(pathname: unknown): boolean {
  if (typeof pathname !== 'string') return false;
  const normalized = normalizePathname(pathname);
  if (normalized.suspicious) return false;
  return normalized.pathname === '/pair' || normalized.pathname.startsWith(PAIR_PATH_PREFIX);
}

function decideRequestAccess({ remoteEnabled, trust, pathname, authenticated }: {
  remoteEnabled?: boolean;
  trust?: string;
  pathname?: unknown;
  authenticated?: unknown;
}): { allow: boolean; action: string } {
  if (!remoteEnabled) return { allow: true, action: 'allow' };
  if (trust !== 'remote') return { allow: true, action: 'allow' };
  if (isPairPath(pathname)) return { allow: true, action: 'pair-page' };
  if (authenticated === true) return { allow: true, action: 'allow' };
  return { allow: false, action: 'unauthorized' };
}

function decideUpgradeAccess({
  remoteEnabled, trust, origin, authenticated, allowedOrigins = [],
  listenerPorts = [], dashboardRoute = false, tokenOk = false,
}: {
  remoteEnabled?: boolean;
  trust?: string;
  origin?: string | null;
  allowedOrigins?: unknown[];
  authenticated?: unknown;
  listenerPorts?: number[];
  dashboardRoute?: boolean;
  tokenOk?: unknown;
}): { allow: boolean; reason: string | null } {
  const originOk = decideOriginAllowed(origin, allowedOrigins, {
    listenerPorts,
    requireOrigin: dashboardRoute,
  });
  if (!originOk) return { allow: false, reason: 'origin' };
  if (remoteEnabled && trust === 'remote') {
    if (authenticated !== true) return { allow: false, reason: 'auth' };
    return { allow: true, reason: null };
  }
  if (dashboardRoute && tokenOk !== true) return { allow: false, reason: 'token' };
  return { allow: true, reason: null };
}

export {
  classifyRequestOrigin,
  decideRequestAccess,
  decideUpgradeAccess,
  isPairPath,
  normalizePathname,
  normalizeClientTrust,
};
