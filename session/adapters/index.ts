import claudeCode from "./claude-code.ts";
import codex from "./codex.ts";
import grok from "./grok.ts";

import type { HookProfile } from "../../detection/hook-source.ts";
import type { TitleProfile } from "../../detection/osc-title-source.ts";
import type { PathLookupExec, ResolvedCommand } from "../core/spawn-command.ts";
import type { AgentEnvOptions, AgentEnvProfile, SpawnEnv } from "../core/spawn-env.ts";
import type { PackDelivery } from "../core/pack-pointer-core.ts";
import type { HookPayload } from "../../shared/contracts/index.ts";

interface AgentCapabilities {
  hooks: boolean;
  awaitingInput: boolean;
  backgroundAgents: boolean;
  resume: boolean;
  packs: boolean;
  packNotice: boolean;
  packReads: boolean;
  statusLine: boolean;
  rtk: boolean;
  antiSlop: boolean;
  compactQuiet: boolean;
  skipPermissionsFlag: boolean;
  headless: boolean;
}

interface ProjectConfigCandidate {
  relPath: string;
  presenceIsHit?: boolean;
}

interface SettingsFileInjection {
  kind: "settings-file";
}

interface ArgvConfigInjection {
  kind: "argv-config";
  relayPath: string;
  events: string[];
  buildHookArgs(options?: {
    relayPath?: string;
    events?: string[];
    bypassHookTrust?: boolean;
    rtkRewrites?: boolean;
    rtkRelayPath?: string;
  }): string[] | null;
  projectConfigCandidates: readonly ProjectConfigCandidate[];
  mayContributeHooks(configText: unknown): boolean;
}

interface HomeHooksFileInjection {
  kind: "home-hooks-file";
  filePath(env?: Record<string, string | undefined>, homedir?: string): string;
  expectedContents(): string | null;
  classifyContents(contents: string): string;
  projectConfigCandidates: readonly ProjectConfigCandidate[];
  mayContributeHooks(configText: unknown): boolean;
}

type HookInjection = SettingsFileInjection | ArgvConfigInjection | HomeHooksFileInjection;

interface AgentHookProfile extends HookProfile {
  injection: HookInjection;
}

interface AgentTitleProfile extends TitleProfile {
  quietUntilFirstPrompt?: boolean;
}

interface AgentArgsOptions {
  dangerouslySkipPermissions?: boolean;
  resumeSessionId?: string | null;
  extraArgs?: string[];
  antiSlopPrompt?: boolean;
  initialPrompt?: string | null;
}

interface AgentSpawnCommandOptions {
  platform: NodeJS.Platform;
  resolved?: ResolvedCommand | null;
  settingsArgs?: string[];
  packArgs?: string[];
  agentArgs?: string[];
}

interface AgentCommandOptions {
  platform?: NodeJS.Platform;
  exec?: PathLookupExec;
}

interface AgentAdapter {
  id: string;
  label: string;
  usageVendor: string;
  commandName: string;
  envProfile: AgentEnvProfile;
  titleProfile: AgentTitleProfile;
  hooks: AgentHookProfile;
  capabilities: AgentCapabilities;
  packCarrier: string;
  packNoticeCaveat?: string;
  packNoticeHookEvent?: string;
  resolveCommand(options?: AgentCommandOptions): ResolvedCommand;
  buildSpawnCommand(options: AgentSpawnCommandOptions): { file: string; args: string[] };
  buildEnv(baseEnv: SpawnEnv, extraEnv: SpawnEnv | null | undefined, options?: AgentEnvOptions): SpawnEnv;
  buildArgs(options?: AgentArgsOptions): string[];
  renderPackArgs(deliveries: readonly PackDelivery[], builtRoot: string): string[] | null;
  settingsArgs?(settingsPath: string): string[];
  sessionIdOf?(payload: HookPayload): unknown;
}

type AgentAdapterShape = AgentAdapter & Record<string, unknown>;

const DEFAULT_AGENT_ID = claudeCode.id;

type Adapter = typeof claudeCode | typeof codex | typeof grok;
const adapterEntries: [string, Adapter][] = [
  [claudeCode.id, claudeCode],
  [codex.id, codex],
  [grok.id, grok],
];
const ADAPTERS = new Map(adapterEntries);

const resolvedCommands = new Map<string, ResolvedCommand>();

function listAgentIds(): string[] {
  return [...ADAPTERS.keys()];
}

function isKnownAgentId(agentId: unknown): boolean {
  return typeof agentId === "string" && ADAPTERS.has(agentId);
}

function getAdapter(agentId: string | null | undefined): Adapter | null {
  if (agentId == null) return ADAPTERS.get(DEFAULT_AGENT_ID) ?? null;
  const adapter = ADAPTERS.get(agentId);
  if (adapter) return adapter;
  return null;
}

function resolveAdapter(
  agentId: string | null | undefined,
  { warn = console.warn, label = "" }: { warn?: (message: string) => void; label?: string } = {},
): Adapter | null {
  const adapter = getAdapter(agentId);
  if (adapter) return adapter;
  warn(`[glissa]${label ? ` ${label}:` : ""} unknown agent "${agentId}", falling back to ${DEFAULT_AGENT_ID}`);
  return ADAPTERS.get(DEFAULT_AGENT_ID) ?? null;
}

function commandFor(adapterOrId: AgentAdapter | string, options?: AgentCommandOptions): ResolvedCommand {
  const adapter = typeof adapterOrId === "string" ? resolveAdapter(adapterOrId) : adapterOrId;
  if (!adapter) throw new TypeError("default agent adapter is unavailable");
  const cached = resolvedCommands.get(adapter.id);
  if (cached) return cached;
  const resolved = adapter.resolveCommand(options);
  resolvedCommands.set(adapter.id, resolved);
  return resolved;
}

function resetCommandCache(): void {
  resolvedCommands.clear();
}

export {
  DEFAULT_AGENT_ID,
  listAgentIds,
  isKnownAgentId,
  getAdapter,
  resolveAdapter,
  commandFor,
  resetCommandCache,
};
export type {
  Adapter,
  AgentAdapter,
  AgentAdapterShape,
  AgentArgsOptions,
  AgentCapabilities,
  AgentCommandOptions,
  AgentHookProfile,
  AgentSpawnCommandOptions,
  AgentTitleProfile,
  ArgvConfigInjection,
  HomeHooksFileInjection,
  HookInjection,
  ProjectConfigCandidate,
  SettingsFileInjection,
};
