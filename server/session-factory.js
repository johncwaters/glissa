'use strict';

const path = require('node:path');
const { Session } = require('../session/sessions.ts');
const { createRecorder } = require('../session/session-recorder.ts');
const { DEFAULT_CONFIG } = require('./config-store.ts');
const { configuredIntegrationBranch } = require('./core/integration-branch-core.js');
const { projectVariantSlug } = require('./core/pack-core.ts');
const { projectSkipsPermissions } = require('./core/session-registry-core.ts');
const { resolveUsageConfig } = require('./usage-wiring');


/**
 * @typedef {object} SessionFactoryDependencies
 * @property {{ configPath: string }} configStore
 * @property {Pick<InstanceType<typeof import('../detection/hook-source.ts').HookRouter>, 'register' | 'unregister'>|null} hookRouter
 * @property {() => number|null} getHookPort
 * @property {() => import('../session/session-worktree-lifecycle.ts').GitWorkspace|null} getGitWorkspace
 * @property {() => MillMetricsPort|null} getMillMetricsPort
 * @property {(config: object) => string|null} rtkPathForConfig
 * @property {(projectId: string) => import('../session/core/user-hooks-core.ts').UserHook[]} getUserHooks
 */

/** @param {SessionFactoryDependencies} dependencies */
function createSessionFactory(dependencies) {
  function planLimitsEnabled(config) {
    const usageConfig = resolveUsageConfig(config.usage);
    return usageConfig.enabled && usageConfig.planLimits;
  }

  return function makeSession(project, config) {
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
      resumeSessionId: project.resumeSessionId || null,
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

module.exports = { createSessionFactory };
