
import { buildAntiSlopArgs } from "../core/anti-slop-prompt.ts";
import { resolveAgentCommand, buildAgentSpawnCommand } from "../core/spawn-command.ts";
import type { PathLookupExec, ResolvedCommand } from "../core/spawn-command.ts";
import { buildAgentEnv } from "../core/spawn-env.ts";
import type { AgentEnvOptions, AgentEnvProfile, SpawnEnv } from "../core/spawn-env.ts";
import type { PackDelivery } from "../core/pack-pointer-core.ts";
import { execSync } from "../../server/child-process-safe.ts";
import type { AgentAdapterShape, AgentArgsOptions, AgentHookProfile, AgentSpawnCommandOptions } from "./index.ts";
import type { HookPayload } from "../../shared/contracts/index.ts";

const ID = "claude-code";
const COMMAND_NAME = "claude";

const envProfile: AgentEnvProfile = {
  scrub: [
    "CLAUDECODE",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_CHILD_SESSION",
  ],
  set: { CLAUDE_CODE_NO_FLICKER: "1" },
  additionalDirsEnvVar: "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD",
};

const BRAILLE_MIN = 0x2800;
const BRAILLE_MAX = 0x28ff;
const KNOWN_SPINNER_CODEPOINTS = new Set([0x25d0, 0x25d1, 0x25d2, 0x25d3]);
const KNOWN_IDLE_CODEPOINTS = new Set([0x2733]);

function isBrailleChar(char: string | null | undefined): boolean {
  if (!char) return false;
  const code = char.codePointAt(0) ?? 0;
  return code >= BRAILLE_MIN && code <= BRAILLE_MAX;
}

function isSpinnerChar(char: string | null | undefined): boolean {
  if (!char) return false;
  if (isBrailleChar(char)) return true;
  return KNOWN_SPINNER_CODEPOINTS.has(char.codePointAt(0) ?? 0);
}

function isKnownIdleChar(char: string | null | undefined): boolean {
  if (!char) return false;
  return KNOWN_IDLE_CODEPOINTS.has(char.codePointAt(0) ?? 0);
}

const titleProfile = {
  isSpinnerChar,
  isIdleChar: isKnownIdleChar,
  dropsLeadingAscii: true,
  unknownGlyphHint: "If this is a new idle glyph, add it to KNOWN_IDLE_CODEPOINTS.",
};

function notificationType(payload: HookPayload | null | undefined): string {
  return String((payload && (payload.notification_type || payload.notificationType)) || "").toLowerCase();
}

function mapHookConfidence(event: string, payload?: HookPayload): string | null {
  const e = String(event || "").toLowerCase();
  if (e === "notification" && notificationType(payload) === "idle_prompt") return "low";
  return null;
}

function mapHookPromptKind(event: string, payload?: HookPayload): string | null {
  const e = String(event || "").toLowerCase();
  if (e === "permissionrequest") return "permission";
  if (e === "notification") {
    const t = notificationType(payload);
    if (t === "permission_prompt") return "permission";
    if (t.startsWith("elicitation")) return "elicitation";
  }
  return null;
}

function mapHookToSignal(event: string, payload?: HookPayload): string | null {
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
    case "subagentstart":
      return "subagent-start";
    case "subagentstop":
      return "subagent-stop";
    case "taskcreated":
      return "task-created";
    case "taskcompleted":
      return "task-completed";
    case "teammateidle":
      return "teammate-idle";
    case "permissionrequest":
      return "awaiting-input";
    case "posttooluse": {
      const tool = String(payload?.tool_name || "");
      if (tool === "ScheduleWakeup") return "wakeup-scheduled";
      if (tool === "CronCreate") return "cron-created";
      if (tool === "CronDelete") return "cron-deleted";
      return null;
    }
    case "notification": {
      const t = notificationType(payload);
      if (t === "idle_prompt") return "ready";
      if (t === "permission_prompt" || t.startsWith("elicitation")) return "awaiting-input";
      return null;
    }
    default:
      return null;
  }
}

const hooks: AgentHookProfile = {
  mapSignal: mapHookToSignal,
  mapConfidence: mapHookConfidence,
  mapPromptKind: mapHookPromptKind,
  injection: { kind: "settings-file" },
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
  { platform, resolved, settingsArgs: injectedSettingsArgs = [], packArgs = [], agentArgs = [] }: AgentSpawnCommandOptions,
): { file: string; args: string[] } {
  return buildAgentSpawnCommand({
    name: COMMAND_NAME,
    platform,
    resolved,
    argGroups: [injectedSettingsArgs, packArgs, agentArgs],
  });
}

function buildEnv(baseEnv: SpawnEnv, extraEnv: SpawnEnv | null | undefined, options?: AgentEnvOptions): SpawnEnv {
  return buildAgentEnv(baseEnv, extraEnv, envProfile, options);
}

const settingsArgs = (settingsPath: string): string[] => ["--settings", settingsPath];
const addDirArgs = (dir: string): string[] => ["--add-dir", dir];

function renderPackArgs(deliveries: readonly PackDelivery[]): string[] {
  const args: string[] = [];
  for (const delivery of deliveries) args.push(...addDirArgs(delivery.dir));
  return args;
}

function buildArgs({
  dangerouslySkipPermissions = false,
  resumeSessionId = null,
  extraArgs = [],
  antiSlopPrompt = false,
  initialPrompt = null,
}: AgentArgsOptions = {}): string[] {
  const args = dangerouslySkipPermissions ? ["--dangerously-skip-permissions"] : [];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  if (extraArgs.length > 0) args.push(...extraArgs);
  args.push(...buildAntiSlopArgs(antiSlopPrompt));
  if (initialPrompt != null) args.push(initialPrompt);
  return args;
}

const claudeCode = {
  id: ID,
  label: "Claude Code",
  usageVendor: "claude",
  commandName: COMMAND_NAME,
  envProfile,
  titleProfile,
  hooks,
  resolveCommand,
  buildSpawnCommand,
  buildEnv,
  buildArgs,
  settingsArgs,
  addDirArgs,
  renderPackArgs,
  packCarrier: "--add-dir directories",
  capabilities: {
    hooks: true,
    packReads: true,
    awaitingInput: true,
    backgroundAgents: true,
    resume: true,
    packs: true,
    packNotice: true,
    statusLine: true,
    rtk: true,
    antiSlop: true,
    compactQuiet: true,
    skipPermissionsFlag: true,
    headless: true,
  },
  isBrailleChar,
  isSpinnerChar,
  isKnownIdleChar,
  mapHookToSignal,
  mapHookConfidence,
  mapHookPromptKind,
} satisfies AgentAdapterShape;

export default claudeCode;
