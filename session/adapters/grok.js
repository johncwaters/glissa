"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { PACK_NAME_RE } = require("../../server/core/pack-core");
const { buildAgentEnv } = require("../core/spawn-env");
const { renderGrokHooksFile, classifyGrokHooksFile } = require("../core/grok-hooks-file-core");
const { PACK_DIRECTIVE, renderPackPointerText } = require("../core/pack-pointer-core");

const ID = "grok";
const COMMAND_NAME = "grok";
const RELAY_PATH = path.resolve(__dirname, "..", "hook-relay.js");
const HOOK_EVENTS = [
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "StopCancelled",
  "Notification",
  "SubagentStart",
  "SubagentStop",
];
const MANAGED_HOOK_EVENT_SETS = [[
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "StopCancelled",
  "Notification",
]];
const ACTION_REQUIRED_MARKER = String.fromCodePoint(0x26a0);
const BRAILLE_MIN = 0x2800;
const BRAILLE_MAX = 0x28ff;
const CLAUDE_COMPAT_HOOKS_ENV = "GROK_CLAUDE_HOOKS_ENABLED";
const PROJECT_CONFIG_CANDIDATES = Object.freeze([
  Object.freeze({ relPath: ".claude/settings.json", presenceIsHit: false }),
  Object.freeze({ relPath: ".claude/settings.local.json", presenceIsHit: false }),
]);

const envProfile = {
  scrub: [],
  // ~/.grok/docs/user-guide/05-configuration.md, "Harness compatibility", makes env override config.
  set: { [CLAUDE_COMPAT_HOOKS_ENV]: "false" },
};

function notificationType(payload) {
  return String(payload?.notificationType || payload?.notification_type || "").toLowerCase();
}

function isMainSessionPayload(payload) {
  return !payload?.subagentType && !payload?.subagent_type;
}

function mapBackgroundTask(task) {
  if (!task || typeof task !== "object" || Array.isArray(task)) return task;
  return {
    ...task,
    ...(typeof task.agentType === "string" ? { agent_type: task.agentType } : {}),
  };
}

function mapHookPayload(_event, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  return {
    ...payload,
    ...(typeof payload.subagentId === "string" ? { agent_id: payload.subagentId } : {}),
    ...(typeof payload.subagentType === "string" ? { agent_type: payload.subagentType } : {}),
    ...(Array.isArray(payload.backgroundTasks)
      ? { background_tasks: payload.backgroundTasks.map(mapBackgroundTask) }
      : {}),
  };
}

function mayContributeHooks(configText) {
  if (typeof configText !== "string") return false;
  let settings;
  try {
    settings = JSON.parse(configText);
  } catch {
    return true;
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return false;
  return Object.hasOwn(settings, "hooks");
}

function mapHookToSignal(event, payload) {
  const normalizedEvent = String(event || "").toLowerCase();
  if (normalizedEvent === "subagentstart") return "subagent-start";
  if (normalizedEvent === "subagentstop") return "subagent-stop";
  if (!isMainSessionPayload(payload)) return null;
  switch (normalizedEvent) {
    case "sessionstart":
      return "session-start";
    case "sessionend":
      return "session-end";
    case "userpromptsubmit":
      return "resume";
    case "stop":
      return payload?.reason === "end_turn" ? "ready" : null;
    case "stopfailure":
    case "stopcancelled":
      return "ready";
    case "notification": {
      const type = notificationType(payload);
      if (type === "idle_prompt") return "ready";
      if (type === "permission_prompt" || type === "approval_required") return "awaiting-input";
      return null;
    }
    default:
      return null;
  }
}

function mapHookConfidence(event, payload) {
  const normalizedEvent = String(event || "").toLowerCase();
  if (normalizedEvent === "notification" && notificationType(payload) === "idle_prompt") return "low";
  return null;
}

function mapHookPromptKind(event, payload) {
  if (String(event || "").toLowerCase() !== "notification") return null;
  const type = notificationType(payload);
  if (type === "permission_prompt" || type === "approval_required") return "permission";
  return null;
}

function sessionIdOf(payload) {
  return payload?.sessionId;
}

function isSpinnerChar(char) {
  if (!char) return false;
  const codePoint = char.codePointAt(0);
  return codePoint >= BRAILLE_MIN && codePoint <= BRAILLE_MAX;
}

function classifyTitle(title) {
  const normalizedTitle = String(title || "");
  if (normalizedTitle.includes("/") || normalizedTitle.includes("\\")) return "ignore";
  const firstCharacter = normalizedTitle.length > 0 ? String.fromCodePoint(normalizedTitle.codePointAt(0) ?? 0) : "";
  if (isSpinnerChar(firstCharacter)) return "working";
  if (normalizedTitle.startsWith(ACTION_REQUIRED_MARKER)) return "awaiting-input";
  return "unknown";
}

const titleProfile = { classifyTitle };

function grokHome(env = process.env, homedir = os.homedir(), platform = process.platform) {
  const pathApi = platform === "win32" ? path.win32 : path;
  const configuredHome = typeof env.GROK_HOME === "string" ? env.GROK_HOME.trim() : "";
  if (configuredHome) return pathApi.resolve(configuredHome);
  return pathApi.join(homedir, ".grok");
}

function hooksFilePath(env = process.env, homedir = os.homedir()) {
  return path.join(grokHome(env, homedir), "hooks", "glissa.json");
}

function nativeBinaryPath({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  const pathApi = platform === "win32" ? path.win32 : path;
  const binaryName = platform === "win32" ? "grok.exe" : "grok";
  return pathApi.join(grokHome(env, homedir, platform), "bin", binaryName);
}

function resolveCommand({
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
  existsSync = fs.existsSync,
  realpathSync = fs.realpathSync,
  warn = console.warn,
} = {}) {
  const candidate = nativeBinaryPath({ platform, env, homedir });
  try {
    if (existsSync(candidate)) return { path: realpathSync(candidate), kind: "exe" };
  } catch (error) {
    warn(`[glissa] could not resolve the native 'grok' binary at ${candidate}: ${error.message}`);
    return { path: null, kind: "unresolved" };
  }
  warn(`[glissa] could not resolve the native 'grok' binary at ${candidate}`);
  return { path: null, kind: "unresolved" };
}

function buildSpawnCommand({ resolved, settingsArgs = [], packArgs = [], agentArgs = [] }) {
  if (!resolved?.path) throw new Error("the native grok binary is not resolved");
  return { file: resolved.path, args: [...settingsArgs, ...packArgs, ...agentArgs] };
}

function buildEnv(baseEnv, extraEnv, options) {
  return buildAgentEnv(baseEnv, extraEnv, envProfile, options);
}

function buildArgs({
  dangerouslySkipPermissions = false,
  resumeSessionId = null,
  extraArgs = [],
  initialPrompt = null,
} = {}) {
  const args = ["--no-auto-update"];
  if (dangerouslySkipPermissions) args.push("--always-approve");
  if (resumeSessionId) args.push("-r", resumeSessionId);
  if (extraArgs.length > 0) args.push(...extraArgs);
  if (initialPrompt != null) args.push(initialPrompt);
  return args;
}

const hooks = {
  mapSignal: mapHookToSignal,
  mapConfidence: mapHookConfidence,
  mapPromptKind: mapHookPromptKind,
  mapPayload: mapHookPayload,
  injection: {
    kind: "home-hooks-file",
    filePath: hooksFilePath,
    expectedContents: () => renderGrokHooksFile({ relayPath: RELAY_PATH, events: HOOK_EVENTS }),
    classifyContents: (contents) => classifyGrokHooksFile(contents, {
      relayPath: RELAY_PATH,
      events: HOOK_EVENTS,
      managedEventSets: MANAGED_HOOK_EVENT_SETS,
    }),
    projectConfigCandidates: PROJECT_CONFIG_CANDIDATES,
    mayContributeHooks,
  },
};

function renderPackArgs(deliveries, builtRoot) {
  const pointerText = renderPackPointerText(deliveries, builtRoot, (name) => PACK_NAME_RE.test(name));
  if (pointerText === "") return [];
  if (pointerText == null) return null;
  return ["--rules", pointerText];
}

module.exports = {
  id: ID,
  label: "Grok Build",
  usageVendor: "grok",
  commandName: COMMAND_NAME,
  envProfile,
  titleProfile,
  hooks,
  resolveCommand,
  buildSpawnCommand,
  buildEnv,
  buildArgs,
  renderPackArgs,
  packCarrier: "--rules index pointers",
  packNoticeHookEvent: "Stop",
  sessionIdOf,
  mapHookPayload,
  mapHookToSignal,
  mapHookConfidence,
  mapHookPromptKind,
  classifyTitle,
  grokHome,
  hooksFilePath,
  nativeBinaryPath,
  mayContributeHooks,
  PROJECT_CONFIG_CANDIDATES,
  CLAUDE_COMPAT_HOOKS_ENV,
  HOOK_EVENTS,
  MANAGED_HOOK_EVENT_SETS,
  RELAY_PATH,
  ACTION_REQUIRED_MARKER,
  PACK_DIRECTIVE,
  capabilities: {
    hooks: true,
    packReads: false,
    awaitingInput: true,
    backgroundAgents: true,
    resume: true,
    packs: true,
    packNotice: true,
    statusLine: false,
    rtk: false,
    antiSlop: false,
    compactQuiet: false,
    skipPermissionsFlag: true,
    headless: true,
  },
};
