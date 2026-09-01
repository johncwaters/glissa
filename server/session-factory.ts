import path from 'node:path';

import type { HookRouter } from '../detection/hook-source.ts';
import type { UserHook } from '../session/core/user-hooks-core.ts';
import { createRecorder } from '../session/session-recorder.ts';
import type { GitWorkspace } from '../session/session-worktree-lifecycle.ts';
import { Session } from '../session/sessions.ts';
import { DEFAULT_CONFIG } from './config-store.ts';
import type { GlissaConfig, ProjectEntry } from './config-store.ts';
import { configuredIntegrationBranch } from './core/integration-branch-core.ts';
import type { MillMetricsPort } from './mill-metrics-wiring.ts';
import { projectVariantSlug } from './core/pack-core.ts';
import { projectSkipsPermissions } from './core/session-registry-core.ts';
import { resolveUsageConfig } from './usage-wiring.ts';

interface SessionFactoryDependencies {
  configStore: { configPath: string };
  hookRouter: Pick<HookRouter, 'register' | 'unregister'> | null;
  getHookPort: () => number | null;
  getGitWorkspace: () => GitWorkspace | null;
  getMillMetricsPort: () => MillMetricsPort | null;
  rtkPathForConfig: (config: GlissaConfig) => string | null;
  getUserHooks: (projectId: string) => UserHook[];
}

function createSessionFactory(dependencies: SessionFactoryDependencies) {
  function planLimitsEnabled(config: GlissaConfig): boolean {
    const usageConfig = resolveUsageConfig(config.usage);
    return usageConfig.enabled && usageConfig.planLimits;
  }

  return function makeSession(project: ProjectEntry, config: GlissaConfig): Session {
    const session = new Session({
      id: project.id,
      name: project.name,
      path: project.path,
      dangerouslySkipPermissions: projectSkipsPermissions(project),
      agent: project.agent,
      bypassHookTrust: project.codexBypassHookTrust === true,
      replayBufferKB: config.replayBufferKB,
      hookRouter: dependencies.hookRouter,
      getHookPort: dependencies.getHookPort,
      gitWorkspace: dependencies.getGitWorkspace(),
      integrationBranch: configuredIntegrationBranch(config),
      autoRebase: config.worktreeAutoRebase !== false,
      syncOnStart: config.worktreeSyncOnStart !== false,
      liveWorktreeReview: config.liveWorktreeReview !== false,
      worktreeRoot: config.worktreeRoot || path.join(path.dirname(path.resolve(project.path)), '.glissa-worktrees'),
      worktreeShare: config.worktreeShare || DEFAULT_CONFIG.worktreeShare,
      detectBackgroundAgents: config.detectBackgroundAgents,
      detectScheduledWakeups: config.detectScheduledWakeups,
      antiSlopPrompt: config.antiSlopPrompt,
      rtkPath: dependencies.rtkPathForConfig(config),
      resumeSessionId: (project.resumeSessionId as string | null | undefined) || null,
      packs: project.packs,
      packVariantSlug: projectVariantSlug(project.path),
      millMetricsPort: dependencies.getMillMetricsPort(),
      planLimits: planLimitsEnabled(config),
      getUserHooks: () => dependencies.getUserHooks(project.id),
    });
    const captureConfig = {
      ...(config.capture || {}),
      baseDir: path.join(path.dirname(dependencies.configStore.configPath), 'recordings'),
    };
    const recorder = createRecorder(project.name, captureConfig, config.recordSignals ?? DEFAULT_CONFIG.recordSignals);
    if (recorder) session.setRecorder(recorder);
    return session;
  };
}

export { createSessionFactory };
export type { SessionFactoryDependencies };
