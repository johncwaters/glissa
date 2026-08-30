"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { writeSessionSettings, generateToken } = require("../detection/settings-injector");
const { HOOK_URL_ENV } = require("./core/hook-relay-core");
const { RTK_PATH_ENV } = require("./core/rtk-hook-core");

const NO_HOOK_INJECTION = Object.freeze({ args: Object.freeze([]), env: Object.freeze({}) });
const MAX_PROJECT_CONFIG_DEPTH = 12;

/**
 * @typedef {object} SessionHookOptions
 * @property {string} id
 * @property {string} name
 * @property {string} agentId
 * @property {Record<string, any>} adapter
 * @property {Record<string, any> | null} hookRouter
 * @property {(() => number | null) | null} getHookPort
 * @property {string | undefined} hooksBaseDir
 * @property {Record<string, unknown> | null} settingsPermissions
 * @property {boolean} detectScheduledWakeups
 * @property {boolean} enableProjectMcp
 * @property {string | null} rtkPath
 * @property {boolean} planLimits
 * @property {(() => import('./core/user-hooks-core').UserHook[]) | null} [getUserHooks]
 * @property {boolean} bypassHookTrust
 * @property {() => string} effectiveCwd
 * @property {(signal: Record<string, any>) => void} ingestSignal
 * @property {(entry: Record<string, unknown>) => void} recordDecision
 */

/** @param {SessionHookOptions} options */
function createSessionHookLifecycle(options) {
  /** @type {string | null} */
  let token = null;
  /** @type {ReturnType<typeof writeSessionSettings> | null} */
  let settingsHandle = null;

  function cleanup() {
    if (!token && !settingsHandle) return;
    if (options.hookRouter) {
      try { options.hookRouter.unregister(options.id); } catch {}
    }
    if (settingsHandle) {
      try { settingsHandle.cleanup(); } catch {}
      settingsHandle = null;
    }
    token = null;
  }

  /** @param {Array<{ relPath: string, presenceIsHit?: boolean }>} candidates @param {(contents: string) => boolean} mayContributeHooks */
  function findProjectAgentConfig(candidates, mayContributeHooks) {
    let directory = options.effectiveCwd();
    for (let depth = 0; depth < MAX_PROJECT_CONFIG_DEPTH; depth += 1) {
      for (const { relPath, presenceIsHit } of candidates) {
        const candidate = path.join(directory, relPath);
        if (presenceIsHit) {
          if (fs.existsSync(candidate)) return candidate;
          continue;
        }
        /** @type {string | null} */
        let contents = null;
        try {
          contents = fs.readFileSync(candidate, "utf8");
        } catch (error) {
          if (error.code !== "ENOENT" && error.code !== "ENOTDIR") return candidate;
          continue;
        }
        if (typeof mayContributeHooks === "function" && mayContributeHooks(contents)) return candidate;
      }
      const parent = path.dirname(directory);
      if (parent === directory) return null;
      directory = parent;
    }
    return null;
  }

  function decideTrustBypass() {
    if (!options.bypassHookTrust) return false;
    const injection = options.adapter.hooks.injection || {};
    const candidates = injection.projectConfigCandidates;
    if (!Array.isArray(candidates) || candidates.length === 0) return true;
    const found = findProjectAgentConfig(candidates, injection.mayContributeHooks);
    if (!found) return true;
    console.warn(`[session:${options.name}] hook-trust bypass refused: ${found} could contribute hooks Glissa did not write - falling back to OSC title only`);
    options.recordDecision({ kind: "hook-trust", ts: Date.now(), decision: "bypass-refused", reason: "project agent config could contribute hooks" });
    return false;
  }

  /** @param {number} port @param {string[]} args @param {Record<string, string> | null} [relayEnv] */
  function registerRelayHooks(port, args, relayEnv = null) {
    if (!options.hookRouter) return NO_HOOK_INJECTION;
    const nextToken = generateToken();
    const hookUrl = `http://127.0.0.1:${port}/hook/${encodeURIComponent(options.id)}?t=${encodeURIComponent(nextToken)}`;
    try {
      token = nextToken;
      options.hookRouter.register(options.id, {
        token,
        onSignal: options.ingestSignal,
        hooks: options.adapter.hooks,
      });
      return { args, env: { [HOOK_URL_ENV]: hookUrl, ...(relayEnv || {}) } };
    } catch (error) {
      console.warn(`[session:${options.name}] hook injection failed: ${error.message} - falling back to OSC title only`);
      cleanup();
      return NO_HOOK_INJECTION;
    }
  }

  /** @param {number} port */
  function injectRelayHooks(port) {
    const args = options.adapter.hooks.injection.buildHookArgs({
      bypassHookTrust: decideTrustBypass(),
      rtkRewrites: options.rtkPath !== null,
    });
    if (!args) {
      console.warn(`[session:${options.name}] hook injection skipped: the relay path cannot be expressed for ${options.agentId} - falling back to OSC title only`);
      return NO_HOOK_INJECTION;
    }
    const relayEnv = options.rtkPath ? { [RTK_PATH_ENV]: options.rtkPath } : null;
    return registerRelayHooks(port, args, relayEnv);
  }

  /** @param {number} port */
  function injectHomeRelayHooks(port) {
    const injection = options.adapter.hooks.injection;
    const contributingConfig = findProjectAgentConfig(
      injection.projectConfigCandidates,
      injection.mayContributeHooks,
    );
    if (contributingConfig) {
      console.warn(`[session:${options.name}] home hook injection refused: ${contributingConfig} could contribute hooks Glissa did not write - falling back to OSC title only`);
      options.recordDecision({
        kind: "hook-trust",
        ts: Date.now(),
        decision: "injection-refused",
        reason: "Claude compatibility settings could contribute hooks",
      });
      return NO_HOOK_INJECTION;
    }
    /** @type {string | null} */
    let hooksPath = null;
    /** @type {string | null} */
    let contents = null;
    try {
      const resolvedHooksPath = injection.filePath(process.env);
      hooksPath = resolvedHooksPath;
      contents = fs.readFileSync(resolvedHooksPath, "utf8");
    } catch (error) {
      const reason = error.code === "ENOENT" ? "not installed" : error.message;
      console.warn(`[session:${options.name}] Grok hook injection skipped: ${reason}; run "glissa agent setup grok"`);
      return NO_HOOK_INJECTION;
    }
    const classification = injection.classifyContents(contents);
    if (classification !== "current") {
      console.warn(`[session:${options.name}] Grok hook injection skipped: ${hooksPath} is ${classification}; run "glissa agent setup grok"`);
      return NO_HOOK_INJECTION;
    }
    return registerRelayHooks(port, []);
  }

  function inject() {
    if (!options.hookRouter || !options.getHookPort) return NO_HOOK_INJECTION;
    /** @type {number | null} */
    let port = null;
    try {
      port = options.getHookPort();
    } catch {}
    if (!port) {
      console.warn(`[session:${options.name}] hook injection skipped: HTTP listener port unavailable - hooks were not injected`);
      return NO_HOOK_INJECTION;
    }
    if (options.adapter.hooks.injection?.kind === "argv-config") return injectRelayHooks(port);
    if (options.adapter.hooks.injection?.kind === "home-hooks-file") return injectHomeRelayHooks(port);
    try {
      const nextSettingsHandle = writeSessionSettings({
        port,
        glissaId: options.id,
        baseDir: options.hooksBaseDir,
        permissions: options.settingsPermissions,
        detectScheduledWakeups: options.detectScheduledWakeups,
        enableProjectMcp: options.enableProjectMcp,
        rtkPath: options.rtkPath,
        planLimits: options.planLimits,
        // Read at every inject, not at construction, so an edit in the Hooks tab reaches the next
        // restart of a live session without the session being recreated.
        userHooks: typeof options.getUserHooks === "function" ? options.getUserHooks() : [],
      });
      settingsHandle = nextSettingsHandle;
      token = nextSettingsHandle.token;
      options.hookRouter.register(options.id, {
        token,
        onSignal: options.ingestSignal,
        hooks: options.adapter.hooks,
      });
      return { args: options.adapter.settingsArgs(nextSettingsHandle.settingsPath), env: {} };
    } catch (error) {
      console.warn(`[session:${options.name}] hook injection failed: ${error.message} - falling back to OSC title only`);
      cleanup();
      return NO_HOOK_INJECTION;
    }
  }

  return {
    inject,
    cleanup,
    token: () => token,
    hasInjection: () => token !== null,
    hasSettings: () => settingsHandle !== null,
  };
}

module.exports = { createSessionHookLifecycle };
