import fs from "node:fs";
import path from "node:path";
import { writeSessionSettings, generateToken } from "../detection/settings-injector.ts";
import type { HookRegistration, HookSignal } from "../detection/hook-source.ts";
import { HOOK_URL_ENV } from "./core/hook-relay-core.ts";
import { RTK_PATH_ENV } from "./core/rtk-hook-core.ts";
import type { UserHook } from "./core/user-hooks-core.ts";
import type { DecisionEntry } from "./core/decision-log.ts";
import type {
  AgentAdapter,
  ArgvConfigInjection,
  HomeHooksFileInjection,
  ProjectConfigCandidate,
} from "./adapters/index.ts";

interface HookInjectionResult {
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}

const NO_HOOK_INJECTION: HookInjectionResult = Object.freeze({
  args: Object.freeze<string[]>([]),
  env: Object.freeze<Record<string, string>>({}),
});
const MAX_PROJECT_CONFIG_DEPTH = 12;

interface HookRouterPort {
  register(glissaId: string, registration: HookRegistration): void;
  unregister(glissaId: string): void;
}

interface SessionHookOptions {
  id: string;
  name: string;
  agentId: string;
  adapter: AgentAdapter;
  hookRouter: HookRouterPort | null;
  getHookPort: (() => number | null) | null;
  hooksBaseDir: string | undefined;
  settingsPermissions: Record<string, unknown> | null;
  detectScheduledWakeups: boolean;
  detectPackReads: (() => boolean) | null;
  observeToolCalls: boolean;
  enableProjectMcp: boolean;
  rtkPath: string | null;
  planLimits: boolean;
  getUserHooks?: (() => UserHook[]) | null;
  bypassHookTrust: boolean;
  effectiveCwd: () => string;
  ingestSignal: (signal: HookSignal) => void;
  observeHook: ((event: string, payload: Record<string, unknown>) => void) | null;
  recordDecision: (entry: DecisionEntry) => void;
}

interface SessionHookLifecycle {
  inject(): HookInjectionResult;
  cleanup(): void;
  token(): string | null;
  hasInjection(): boolean;
  hasSettings(): boolean;
  detectsPackReads(): boolean;
}

function errorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) return String((error as { code: unknown }).code);
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createSessionHookLifecycle(options: SessionHookOptions): SessionHookLifecycle {
  let token: string | null = null;
  let settingsHandle: ReturnType<typeof writeSessionSettings> | null = null;

  function cleanup(): void {
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

  function findProjectAgentConfig(
    candidates: readonly ProjectConfigCandidate[],
    mayContributeHooks: ((contents: string) => boolean) | undefined,
  ): string | null {
    let directory = options.effectiveCwd();
    for (let depth = 0; depth < MAX_PROJECT_CONFIG_DEPTH; depth += 1) {
      for (const { relPath, presenceIsHit } of candidates) {
        const candidate = path.join(directory, relPath);
        if (presenceIsHit) {
          if (fs.existsSync(candidate)) return candidate;
          continue;
        }
        let contents: string | null = null;
        try {
          contents = fs.readFileSync(candidate, "utf8");
        } catch (error) {
          const code = errorCode(error);
          if (code !== "ENOENT" && code !== "ENOTDIR") return candidate;
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

  function decideTrustBypass(injection: ArgvConfigInjection): boolean {
    if (!options.bypassHookTrust) return false;
    const candidates = injection.projectConfigCandidates;
    if (!Array.isArray(candidates) || candidates.length === 0) return true;
    const found = findProjectAgentConfig(candidates, injection.mayContributeHooks);
    if (!found) return true;
    console.warn(`[session:${options.name}] hook-trust bypass refused: ${found} could contribute hooks Glissa did not write - falling back to OSC title only`);
    options.recordDecision({ kind: "hook-trust", ts: Date.now(), decision: "bypass-refused", reason: "project agent config could contribute hooks" });
    return false;
  }

  function registerRelayHooks(
    port: number,
    args: string[],
    relayEnv: Record<string, string> | null = null,
  ): HookInjectionResult {
    if (!options.hookRouter) return NO_HOOK_INJECTION;
    const nextToken = generateToken();
    const hookUrl = `http://127.0.0.1:${port}/hook/${encodeURIComponent(options.id)}?t=${encodeURIComponent(nextToken)}`;
    try {
      token = nextToken;
      options.hookRouter.register(options.id, {
        token,
        onSignal: options.ingestSignal,
        onEvent: options.observeHook,
        hooks: options.adapter.hooks,
      });
      return { args, env: { [HOOK_URL_ENV]: hookUrl, ...(relayEnv || {}) } };
    } catch (error) {
      console.warn(`[session:${options.name}] hook injection failed: ${errorMessage(error)} - falling back to OSC title only`);
      cleanup();
      return NO_HOOK_INJECTION;
    }
  }

  function injectRelayHooks(port: number, injection: ArgvConfigInjection): HookInjectionResult {
    const args = injection.buildHookArgs({
      bypassHookTrust: decideTrustBypass(injection),
      rtkRewrites: options.rtkPath !== null,
    });
    if (!args) {
      console.warn(`[session:${options.name}] hook injection skipped: the relay path cannot be expressed for ${options.agentId} - falling back to OSC title only`);
      return NO_HOOK_INJECTION;
    }
    const relayEnv = options.rtkPath ? { [RTK_PATH_ENV]: options.rtkPath } : null;
    return registerRelayHooks(port, args, relayEnv);
  }

  function injectHomeRelayHooks(port: number, injection: HomeHooksFileInjection): HookInjectionResult {
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
    let hooksPath: string | null = null;
    let contents: string | null = null;
    try {
      const resolvedHooksPath = injection.filePath(process.env);
      hooksPath = resolvedHooksPath;
      contents = fs.readFileSync(resolvedHooksPath, "utf8");
    } catch (error) {
      const reason = errorCode(error) === "ENOENT" ? "not installed" : errorMessage(error);
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

  function inject(): HookInjectionResult {
    if (!options.hookRouter || !options.getHookPort) return NO_HOOK_INJECTION;
    let port: number | null = null;
    try {
      port = options.getHookPort();
    } catch {}
    if (!port) {
      console.warn(`[session:${options.name}] hook injection skipped: HTTP listener port unavailable - hooks were not injected`);
      return NO_HOOK_INJECTION;
    }
    const injection = options.adapter.hooks.injection;
    if (injection?.kind === "argv-config") return injectRelayHooks(port, injection);
    if (injection?.kind === "home-hooks-file") return injectHomeRelayHooks(port, injection);
    try {
      const buildSettingsArgs = options.adapter.settingsArgs;
      if (typeof buildSettingsArgs !== "function") {
        throw new TypeError(`agent ${options.agentId} carries no settings-file argv`);
      }
      const nextSettingsHandle = writeSessionSettings({
        port,
        glissaId: options.id,
        baseDir: options.hooksBaseDir,
        permissions: options.settingsPermissions,
        detectScheduledWakeups: options.detectScheduledWakeups,
        detectPackReads: typeof options.detectPackReads === "function" ? options.detectPackReads() : false,
        observeToolCalls: options.observeToolCalls,
        enableProjectMcp: options.enableProjectMcp,
        rtkPath: options.rtkPath,
        planLimits: options.planLimits,
        userHooks: typeof options.getUserHooks === "function" ? options.getUserHooks() : [],
      });
      settingsHandle = nextSettingsHandle;
      token = nextSettingsHandle.token;
      options.hookRouter.register(options.id, {
        token,
        onSignal: options.ingestSignal,
        onEvent: options.observeHook,
        hooks: options.adapter.hooks,
      });
      return { args: buildSettingsArgs(nextSettingsHandle.settingsPath), env: {} };
    } catch (error) {
      console.warn(`[session:${options.name}] hook injection failed: ${errorMessage(error)} - falling back to OSC title only`);
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
    detectsPackReads: () => settingsHandle?.packReadHook === true,
  };
}

export { createSessionHookLifecycle };
export type { HookInjectionResult, HookRouterPort, SessionHookLifecycle, SessionHookOptions };
