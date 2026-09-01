import os from 'node:os';

import { decideRtkInstall } from './core/rtk-install-core.ts';
import type { RtkInstallDecision } from './core/rtk-install-core.ts';
import { installRtk } from './rtk-installer.ts';
import type { InstallResult } from './rtk-installer.ts';
import { getRtkPath } from './rtk-resolver.ts';

type RtkInstallStatus = {
  status: string;
  path?: string;
  reason?: string;
};

interface RtkInstallWiringOptions {
  config?: { rtk?: boolean } | null;
  homeDir?: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  log?: Pick<Console, 'log' | 'warn'> | null;
  now?: () => number;
  resolveRtk?: () => string | null;
  install?: typeof installRtk;
  onStatusChange?: (status: RtkInstallStatus) => void;
}

type MaybeInstallOutcome = RtkInstallDecision | (RtkInstallDecision & { result: InstallResult });

interface RtkInstallWiring {
  maybeInstall(): Promise<MaybeInstallOutcome>;
  getStatus(): RtkInstallStatus;
}

// One-shot lane, not a poller: the only triggers are boot and a settings save, so there is no timer to
// own. getRtkPath memoizes successes only, so a fresh install is picked up by the next call with no bust.
function createRtkInstallWiring({
  config,
  homeDir = os.homedir(),
  platform = process.platform,
  arch = process.arch,
  log = console,
  now = () => Date.now(),
  resolveRtk = getRtkPath,
  install = installRtk,
  onStatusChange = () => {},
}: RtkInstallWiringOptions = {}): RtkInstallWiring {
  let status: RtkInstallStatus = { status: 'idle' };
  let inFlight = false;
  let lastFailureAt: number | null = null;

  const getStatus = (): RtkInstallStatus => ({ ...status });

  function setStatus(next: RtkInstallStatus): void {
    status = next;
    onStatusChange(getStatus());
  }

  async function maybeInstall(): Promise<MaybeInstallOutcome> {
    const rtkEnabled = config?.rtk === true;
    const decision = decideRtkInstall({
      rtkEnabled,
      resolvedPath: rtkEnabled ? resolveRtk() : null,
      platform,
      arch,
      inFlight,
      lastFailureAt,
      nowMs: now(),
    });
    if (decision.action === 'skip') return decision;

    inFlight = true;
    setStatus({ status: 'installing' });
    log?.log?.(`[rtk] no rtk binary resolved and config.rtk is on: installing ${decision.asset.version}`);
    try {
      const result = await install({ homeDir, platform, arch, ...(log ? { log } : {}) });
      if (result.ok) {
        lastFailureAt = null;
        setStatus({ status: 'installed', path: result.path });
        return { ...decision, result };
      }
      lastFailureAt = now();
      log?.warn?.(`[rtk] install failed: ${result.reason}`);
      setStatus({ status: 'failed', reason: result.reason });
      return { ...decision, result };
    } finally {
      inFlight = false;
    }
  }

  return { maybeInstall, getStatus };
}

export { createRtkInstallWiring };
export type { RtkInstallStatus, RtkInstallWiring, RtkInstallWiringOptions };
