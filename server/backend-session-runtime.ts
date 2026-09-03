import type { Server } from 'node:http';
import { HookRouter } from '../detection/hook-source.ts';
import { sweepOrphans } from '../detection/settings-injector.ts';
import { hooksForProject } from '../session/core/user-hooks-core.ts';
import type { GitWorkspace } from '../session/session-worktree-lifecycle.ts';
import type { ControlBroadcast } from './backend-websockets.ts';
import type { MillMetricsPort } from './mill-metrics-wiring.ts';
import type { ConfigStore, GlissaConfig } from './config-store.ts';
import { createRtkInstallWiring } from './rtk-install-wiring.ts';
import { getRtkPath } from './rtk-resolver.ts';
import { listPackSpecNamesSync } from './pack-builder.ts';
import { createSessionFactory } from './session-factory.ts';
import { buildSettingsPayload } from './settings-payload.ts';

interface BackendSessionRuntimeDependencies {
  httpServer: Server;
  config: GlissaConfig;
  configStore: ConfigStore;
  getGitWorkspace: () => GitWorkspace | null;
  getMillMetricsPort?: () => MillMetricsPort | null;
  getBroadcastControl: () => ControlBroadcast | null;
  logger: Pick<Console, 'warn'>;
}

function createBackendSessionRuntime(dependencies: BackendSessionRuntimeDependencies) {
  const hookRouter = new HookRouter();
  const getHookPort = (): number | null => {
    const address = dependencies.httpServer?.address();
    if (!address || typeof address !== 'object' || !address.port) return null;
    return address.port;
  };
  try {
    sweepOrphans();
  } catch {}

  let hasWarnedMissingRtk = false;
  function rtkPathForConfig(config: { rtk?: unknown }): string | null {
    if (!config.rtk) return null;
    const rtkPath = getRtkPath();
    if (rtkPath) return rtkPath;
    if (hasWarnedMissingRtk) return null;
    hasWarnedMissingRtk = true;
    dependencies.logger.warn(
      '[rtk] config.rtk is true, but no rtk binary was found. Sessions will spawn without rtk hooks.',
    );
    return null;
  }

  const rtkInstall = createRtkInstallWiring({
    config: dependencies.config,
    onStatusChange: (status) => {
      const broadcast = dependencies.getBroadcastControl();
      if (!broadcast) return;
      broadcast({
        type: 'settings-updated',
        settings: buildSettingsPayload({ configStore: dependencies.configStore, rtkInstallStatus: status }),
      });
    },
  });
  const makeSession = createSessionFactory({
    configStore: dependencies.configStore,
    getConfig: () => dependencies.config,
    hookRouter,
    getHookPort,
    getGitWorkspace: dependencies.getGitWorkspace,
    getMillMetricsPort: dependencies.getMillMetricsPort || (() => null),
    rtkPathForConfig,
    getUserHooks: (projectId: string) => hooksForProject(dependencies.config.hooks, projectId),
    listPackNames: () => listPackSpecNamesSync(),
  });

  return { getHookPort, hookRouter, makeSession, rtkInstall };
}

type BackendSessionRuntime = ReturnType<typeof createBackendSessionRuntime>;

export { createBackendSessionRuntime };
export type { BackendSessionRuntime, BackendSessionRuntimeDependencies };
