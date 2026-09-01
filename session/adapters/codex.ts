
import { execSync } from "../../server/child-process-safe.ts";
import { relayPath } from "../../server/runtime-paths.ts";
import { PACK_NAME_RE } from "../../server/core/pack-core.ts";
import { resolveAgentCommand, buildAgentSpawnCommand } from "../core/spawn-command.ts";
import type { PathLookupExec, ResolvedCommand } from "../core/spawn-command.ts";
import { buildAgentEnv } from "../core/spawn-env.ts";
import type { AgentEnvOptions, AgentEnvProfile, SpawnEnv } from "../core/spawn-env.ts";
import { buildHookCommand } from "../core/hook-command-core.ts";
import { PACK_DIRECTIVE, renderPackPointerText } from "../core/pack-pointer-core.ts";
import type { PackDelivery } from "../core/pack-pointer-core.ts";
import type {
  AgentAdapterShape,
  AgentArgsOptions,
  AgentHookProfile,
  AgentSpawnCommandOptions,
  AgentTitleProfile,
} from "./index.ts";
import type { HookPayload } from "../../shared/contracts/index.ts";

const ID = "codex";
const COMMAND_NAME = "codex";

const RELAY_PATH = relayPath("hook-relay");
const RTK_RELAY_PATH = relayPath("rtk-relay");
const RTK_HOOK_EVENT = "PreToolUse";
const RTK_TOOL_MATCHER = "Bash";

const HOOK_EVENTS = ["SessionStart", "SessionEnd", "UserPromptSubmit", "Stop", "PermissionRequest"];

const envProfile: AgentEnvProfile = { scrub: [], set: {} };

const BRAILLE_MIN = 0x2800;
const BRAILLE_MAX = 0x28ff;

const ACTION_REQUIRED_RE = /^\[\s*[.!]\s*\]\s*Action Required\b/;

function isSpinnerChar(char: string | null | undefined): boolean {
  if (!char) return false;
  const code = char.codePointAt(0) ?? 0;
  return code >= BRAILLE_MIN && code <= BRAILLE_MAX;
}

function isPathLikeTitle(title: string): boolean {
  return title.includes("/") || title.includes("\\");
}

function classifyTitle(title: string, { cwdBasename = null }: { cwdBasename?: string | null } = {}): string {
  if (isPathLikeTitle(title)) return "ignore";
  if (isSpinnerChar(String.fromCodePoint(title.codePointAt(0) ?? 0))) return "working";
  if (!cwdBasename) return "ignore";
  if (ACTION_REQUIRED_RE.test(title)) return title.trimEnd().endsWith(cwdBasename) ? "awaiting-input" : "unknown";
  if (title.trim() === cwdBasename) return "ready";
  return "unknown";
}

const titleProfile: AgentTitleProfile = {
  classifyTitle,
  quietUntilFirstPrompt: true,
};

function mapHookToSignal(event: string): string | null {
  const e = String(event || "").toLowerCase();
  switch (e) {
    case "sessionstart":
      return "session-start";
    case "sessionend":
      return "session-end";
    case "userpromptsubmit":
      return "resume";
    case "stop":
      return "ready";
    case "permissionrequest":
      return "awaiting-input";
    default:
      return null;
  }
}

function mapHookConfidence(): string | null {
  return null;
}

function mapHookPromptKind(event: string): string | null {
  return String(event || "").toLowerCase() === "permissionrequest" ? "permission" : null;
}

function sessionIdOf(payload: HookPayload): unknown {
  return payload?.session_id;
}

const TRUST_BYPASS_FLAG = "--dangerously-bypass-hook-trust";

const PROJECT_CONFIG_CANDIDATES = Object.freeze([
  Object.freeze({ relPath: ".codex/config.toml", presenceIsHit: false }),
  Object.freeze({ relPath: ".codex/hooks.json", presenceIsHit: true }),
]);

const HOOKS_DECLARATION_RE = /^[^\S\r\n]*(?:\[{1,2}[^\S\r\n]*["']?hooks\b|hooks[.\w"'-]*[^\S\r\n]*=|extends[^\S\r\n]*=)/m;

function mayContributeHooks(configText: unknown): boolean {
  if (typeof configText !== "string") return false;
  return HOOKS_DECLARATION_RE.test(configText);
}

function buildHookArgs({
  relayPath = RELAY_PATH,
  events = HOOK_EVENTS,
  bypassHookTrust = false,
  rtkRewrites = false,
  rtkRelayPath = RTK_RELAY_PATH,
}: {
  relayPath?: string;
  events?: string[];
  bypassHookTrust?: boolean;
  rtkRewrites?: boolean;
  rtkRelayPath?: string;
} = {}): string[] | null {
  const args = bypassHookTrust ? [TRUST_BYPASS_FLAG] : [];
  for (const event of events) {
    const command = buildHookCommand(relayPath, event);
    if (!command) return null;
    args.push("-c", `hooks.${event}=[{hooks=[{type='command',command='${command}'}]}]`);
  }
  if (!rtkRewrites) return args;
  const rtkCommand = buildHookCommand(rtkRelayPath, RTK_HOOK_EVENT);
  if (!rtkCommand) return args;
  args.push("-c", `hooks.${RTK_HOOK_EVENT}=[{matcher='${RTK_TOOL_MATCHER}',hooks=[{type='command',command='${rtkCommand}'}]}]`);
  return args;
}

const hooks: AgentHookProfile = {
  mapSignal: mapHookToSignal,
  mapConfidence: mapHookConfidence,
  mapPromptKind: mapHookPromptKind,
  injection: {
    kind: "argv-config",
    relayPath: RELAY_PATH,
    events: HOOK_EVENTS,
    buildHookArgs,
    projectConfigCandidates: PROJECT_CONFIG_CANDIDATES,
    mayContributeHooks,
  },
};

function resolveCommand(
  { platform, exec = execSync }: { platform?: NodeJS.Platform; exec?: PathLookupExec } = {},
): ResolvedCommand {
  return resolveAgentCommand({
    name: COMMAND_NAME,
    platform: platform || process.platform,
    exec,
  });
}

function buildSpawnCommand(
  { platform, resolved, settingsArgs = [], packArgs = [], agentArgs = [] }: AgentSpawnCommandOptions,
): { file: string; args: string[] } {
  return buildAgentSpawnCommand({
    name: COMMAND_NAME,
    platform,
    resolved,
    argGroups: [settingsArgs, packArgs, agentArgs],
  });
}

function buildEnv(baseEnv: SpawnEnv, extraEnv: SpawnEnv | null | undefined, options?: AgentEnvOptions): SpawnEnv {
  return buildAgentEnv(baseEnv, extraEnv, envProfile, options);
}

function renderPackArgs(deliveries: readonly PackDelivery[], builtRoot: string): string[] | null {
  const pointerText = renderPackPointerText(deliveries, builtRoot, (name) => PACK_NAME_RE.test(name));
  if (pointerText === "") return [];
  if (pointerText == null) return null;
  return ["-c", `developer_instructions='''${pointerText}'''`];
}

const UPDATE_CHECK_ARGS = ["-c", "check_for_update_on_startup=false"];

const SKIP_PERMISSIONS_ARGS = ["-a", "never", "-s", "workspace-write"];

function buildArgs({
  dangerouslySkipPermissions = false,
  resumeSessionId = null,
  extraArgs = [],
  initialPrompt = null,
}: AgentArgsOptions = {}): string[] {
  const args = [...UPDATE_CHECK_ARGS];
  if (resumeSessionId) args.push("resume", resumeSessionId);
  if (dangerouslySkipPermissions) args.push(...SKIP_PERMISSIONS_ARGS);
  if (extraArgs.length > 0) args.push(...extraArgs);
  if (initialPrompt != null) args.push(initialPrompt);
  return args;
}

const codex = {
  id: ID,
  label: "Codex CLI",
  usageVendor: "codex",
  commandName: COMMAND_NAME,
  envProfile,
  titleProfile,
  hooks,
  resolveCommand,
  buildSpawnCommand,
  buildEnv,
  buildArgs,
  renderPackArgs,
  packCarrier: "developer_instructions index pointers",
  packNoticeCaveat: "staleness notices require trusted UserPromptSubmit hooks or the hook-trust bypass",
  buildHookArgs,
  buildHookCommand,
  mayContributeHooks,
  PROJECT_CONFIG_CANDIDATES,
  classifyTitle,
  mapHookToSignal,
  mapHookConfidence,
  mapHookPromptKind,
  sessionIdOf,
  HOOK_EVENTS,
  RELAY_PATH,
  RTK_RELAY_PATH,
  TRUST_BYPASS_FLAG,
  SKIP_PERMISSIONS_ARGS,
  UPDATE_CHECK_ARGS,
  PACK_DIRECTIVE,
  capabilities: {
    hooks: true,
    packReads: false,
    awaitingInput: true,
    backgroundAgents: false,
    resume: true,
    packs: true,
    packNotice: true,
    statusLine: false,
    rtk: true,
    antiSlop: false,
    compactQuiet: false,
    skipPermissionsFlag: true,
    headless: true,
  },
} satisfies AgentAdapterShape;

export default codex;
