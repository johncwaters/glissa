import crypto from 'node:crypto';
import { hostOfOrigin } from './core/origin-policy.ts';
import { decideBindHost, normalizeRemoteConfig, validateRemoteConfig } from './core/remote-config.ts';
import type { RemoteConfig } from './core/remote-config.ts';
import { createPairingsStore, createSeenStore, defaultPairingsPath, defaultSeenPath } from './pairings-store.ts';
import { createRemoteAuth } from './remote-auth.ts';

interface BackendTrustDependencies {
  localPort: number;
  remoteConfig: unknown;
  configPath: string;
  env: NodeJS.ProcessEnv;
}

interface BackendTrust {
  remote: RemoteConfig;
  bindDecision: { host: string; allowed: boolean; reason: string | null };
  remoteListenerPort: number | null;
  pageToken: string;
  allowedHosts: string[];
  remoteAuth: ReturnType<typeof createRemoteAuth> | null;
  tokenMatches(presented: unknown): boolean;
  listenerPortsFor(socket: { localPort?: number | null } | null | undefined): number[];
}

function bootError(message: string): Error {
  return Object.assign(new Error(message), { glissaBoot: true });
}

function createBackendTrust(dependencies: BackendTrustDependencies): BackendTrust {
  const remote = normalizeRemoteConfig(dependencies.remoteConfig);
  const remoteCheck = validateRemoteConfig(remote, dependencies.localPort);
  if (!remoteCheck.ok) throw bootError(`[remote] invalid configuration: ${remoteCheck.error}`);
  const bindDecision = decideBindHost({
    envHost: dependencies.env.GLISSA_HOST,
    insecureBind: dependencies.env.GLISSA_INSECURE_BIND === '1',
  });
  const remoteListenerPort = remote.enabled ? remote.port : null;
  const pageToken = crypto.randomBytes(32).toString('hex');
  const pageTokenBuffer = Buffer.from(pageToken, 'utf8');
  const allowedHosts = (remote.enabled
    ? [remote.publicHost, ...remote.allowedOrigins.map(hostOfOrigin)]
    : []
  ).filter((host) => typeof host === 'string' && host !== '');
  const remoteAuth = remote.enabled
    ? createRemoteAuth({
      remote,
      pairingsStore: createPairingsStore({ filePath: defaultPairingsPath(dependencies.configPath) }),
      seenStore: createSeenStore({ filePath: defaultSeenPath(dependencies.configPath) }),
    })
    : null;

  function tokenMatches(presented: unknown): boolean {
    if (typeof presented !== 'string' || presented.length !== pageToken.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(presented, 'utf8'), pageTokenBuffer);
    } catch {
      return false;
    }
  }

  function listenerPortsFor(socket: { localPort?: number | null } | null | undefined): number[] {
    const listenerPort = socket && typeof socket.localPort === 'number' ? socket.localPort : null;
    return listenerPort == null ? [] : [listenerPort];
  }

  return {
    remote,
    bindDecision,
    remoteListenerPort,
    pageToken,
    allowedHosts,
    remoteAuth,
    tokenMatches,
    listenerPortsFor,
  };
}

export { createBackendTrust };
export type { BackendTrust, BackendTrustDependencies };
