"use strict";

// THE Claude Code adapter: every Claude-specific table, flag spelling and glyph set that Glissa's
// otherwise agent-neutral spawn and detection paths used to hold inline. Moved here verbatim in M1
// of docs/plan-agent-adapters.md, so a second agent is a sibling file rather than a branch in each
// consumer. Data plus pure functions, except resolveCommand's PATH lookup (one exec, cached by the registry).

const { buildAntiSlopArgs } = require("../core/anti-slop-prompt");
const { resolveAgentCommand, buildAgentSpawnCommand } = require("../core/spawn-command");
const { buildAgentEnv } = require("../core/spawn-env");

const ID = "claude-code";
const COMMAND_NAME = "claude";

// -- Environment ------------------------------------------------------------
// Scrubbed so a spawned `claude` does not think it is running inside Glissa's own Claude session.
// CLAUDE_CODE_CHILD_SESSION is the load-bearing one: inherited, it silently disables transcript
// saving (live-probed 2.1.235), which blinds the usage lane and breaks resume for every session.
const envProfile = {
  scrub: [
    "CLAUDECODE",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_CHILD_SESSION",
  ],
  set: { CLAUDE_CODE_NO_FLICKER: "1" },
  additionalDirsEnvVar: "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD",
};

// -- Title glyphs -----------------------------------------------------------
// Claude Code emits an activity glyph as the first char of its OSC-0 title:
//   - braille family U+2800..U+28FF or circle-halves U+25D0..U+25D3 => spinner ("working")
//   - a known idle glyph (U+2733 EIGHT SPOKED ASTERISK) => idle/ready
// Claude Code 2.1.228 changed the busy title spinner from braille to circle-halves.
// See docs/postmortem-terminal-detection.md and .omc/probes/common-patterns.md.
const BRAILLE_MIN = 0x2800;
const BRAILLE_MAX = 0x28ff;
// Only U+25D0/U+25D1 live-probed (CC 2.1.234); the other two circle-halves frames can only ever mean spinning.
const KNOWN_SPINNER_CODEPOINTS = new Set([0x25d0, 0x25d1, 0x25d2, 0x25d3]);
// Known idle glyphs (extend as a probe confirms per Claude version).
const KNOWN_IDLE_CODEPOINTS = new Set([0x2733]);

function isBrailleChar(char) {
  if (!char) return false;
  const code = char.codePointAt(0);
  return code >= BRAILLE_MIN && code <= BRAILLE_MAX;
}

function isSpinnerChar(char) {
  if (!char) return false;
  if (isBrailleChar(char)) return true;
  return KNOWN_SPINNER_CODEPOINTS.has(char.codePointAt(0));
}

function isKnownIdleChar(char) {
  if (!char) return false;
  return KNOWN_IDLE_CODEPOINTS.has(char.codePointAt(0));
}

const titleProfile = {
  isSpinnerChar,
  isIdleChar: isKnownIdleChar,
  // Claude ALWAYS leads its activity title with a pictographic glyph, so a plain ASCII lead is a
  // shell-or-OS window title (the `cmd.exe /c claude` case) and is dropped rather than triaged.
  dropsLeadingAscii: true,
  unknownGlyphHint: "If this is a new idle glyph, add it to KNOWN_IDLE_CODEPOINTS.",
};

// -- Hook vocabulary --------------------------------------------------------
function notificationType(payload) {
  return String((payload && (payload.notification_type || payload.notificationType)) || "").toLowerCase();
}

// Confidence override for a mapped signal, or null for the source default ('high').
// idle_prompt means "Claude is waiting for YOU", not "the turn finished": as a `ready`
// it only confirms quiescence, so it is demoted to 'low' and the mapper completes it
// from RUNNING only (same rule as the title fallback). Without this, an idle nudge on
// a session that never ran a turn (fresh IDLE) or one parked at a prompt would fire a
// false COMPLETE + "finished working" notification.
function mapHookConfidence(event, payload) {
  const e = String(event || "").toLowerCase();
  if (e === "notification" && notificationType(payload) === "idle_prompt") return "low";
  return null;
}

// Advisory classification of an 'awaiting-input' signal's origin, surfaced as a card chip so the
// dashboard shows WHAT the session is waiting on. Only meaningful when mapHookToSignal returned
// 'awaiting-input' for this event/payload; null otherwise (never gates a transition).
function mapHookPromptKind(event, payload) {
  const e = String(event || "").toLowerCase();
  if (e === "permissionrequest") return "permission";
  if (e === "notification") {
    const t = notificationType(payload);
    if (t === "permission_prompt") return "permission";
    if (t.startsWith("elicitation")) return "elicitation";
  }
  return null;
}

// Map a Claude Code hook event (+ payload) to a normalized StatusSource signal.
// Returns null for events that should be ignored.
function mapHookToSignal(event, payload) {
  const e = String(event || "").toLowerCase();
  switch (e) {
    case "sessionstart":
      return "session-start";
    case "sessionend":
      return "session-end";
    case "userpromptsubmit":
      return "resume";
    case "stop":
      // Main-agent turn end only. NOT SubagentStop: a sub-agent (Task tool)
      // finishing mid-turn must not mark the whole session COMPLETE. This `ready`
      // is gated downstream on the live background sub-agent count (see below).
      return "ready";
    case "subagentstart":
      // A background sub-agent (Task run_in_background / Ctrl+B) began. NOT a state
      // transition: tracked as a live-count delta so a later main-agent Stop fired while
      // it is still running does not falsely COMPLETE the card (see Session._trackSubagent
      // and the activeAgents gate in session/core/status-mapper.js).
      return "subagent-start";
    case "subagentstop":
      // A sub-agent finished. Drops the live count; never completes the session itself
      // (the main agent's own Stop does that, gated on the count).
      return "subagent-stop";
    case "taskcreated":
      // Background task registered (payload: task_id, teammate_name?). Tracking-only:
      // maps teammate names to task ids and reactivates a previously idled id.
      return "task-created";
    case "taskcompleted":
      // Background task finished (payload: task_id). Tracking-only: drains that id from
      // the declared background_tasks gate without waiting for the next Stop.
      return "task-completed";
    case "teammateidle":
      // A native-team teammate went idle (payload: teammate_name, NO task_id). Its task
      // registry entry stays status:running until shutdown, so every later Stop keeps
      // declaring it in background_tasks; this signal is the only way to know the entry
      // no longer gates completion. Tracking-only.
      return "teammate-idle";
    case "permissionrequest":
      return "awaiting-input";
    case "posttooluse": {
      // Scheduled-revival bookkeeping (subscribed with a ScheduleWakeup|CronCreate|CronDelete
      // matcher; see settings-injector.WAKEUP_TOOL_MATCHER). Tracking-only signals, never
      // transitions (Session._trackWakeup). The tool_name switch is defense in depth: if a
      // Claude version ignores the matcher and floods every tool call, everything else maps
      // to null (ignored-event).
      const tool = String(payload?.tool_name || "");
      if (tool === "ScheduleWakeup") return "wakeup-scheduled";
      if (tool === "CronCreate") return "cron-created";
      if (tool === "CronDelete") return "cron-deleted";
      // Pack read telemetry, subscribed with its own Read matcher and only for a session that
      // delivers context packs (settings-injector.PACK_READ_TOOL_MATCHER). Tracking-only like the
      // wakeups above: never a transition, never confidence-bearing.
      if (tool === "Read") return "pack-read";
      return null;
    }
    case "notification": {
      // Only act on subtypes with a clear meaning; ignore the rest (e.g.
      // auth_success) rather than firing a false WAITING.
      const t = notificationType(payload);
      if (t === "idle_prompt") return "ready";
      if (t === "permission_prompt" || t.startsWith("elicitation")) return "awaiting-input";
      return null;
    }
    default:
      return null;
  }
}

const hooks = {
  mapSignal: mapHookToSignal,
  mapConfidence: mapHookConfidence,
  mapPromptKind: mapHookPromptKind,
  // HTTP hooks written into a per-session managed --settings file; no repo modification, no shell.
  injection: { kind: "settings-file" },
};

// -- Spawn ------------------------------------------------------------------
function resolveCommand({ platform, exec } = {}) {
  return resolveAgentCommand({
    name: COMMAND_NAME,
    ...(platform ? { platform } : {}),
    ...(exec ? { exec } : {}),
  });
}

function buildSpawnCommand({ platform, resolved, settingsArgs = [], packArgs = [], agentArgs = [] }) {
  return buildAgentSpawnCommand({
    name: COMMAND_NAME,
    platform,
    resolved,
    argGroups: [settingsArgs, packArgs, agentArgs],
  });
}

function buildEnv(baseEnv, extraEnv, options) {
  return buildAgentEnv(baseEnv, extraEnv, envProfile, options);
}

const settingsArgs = (settingsPath) => ["--settings", settingsPath];
const addDirArgs = (dir) => ["--add-dir", dir];

// The argv the spawn form wraps, in the order Session.start() has always assembled it: the resume id
// ahead of any lane flags, the anti-slop note ahead of the prompt, and the prompt LAST because it is
// a positional.
function buildArgs({
  dangerouslySkipPermissions = false,
  resumeSessionId = null,
  extraArgs = [],
  antiSlopPrompt = false,
  initialPrompt = null,
} = {}) {
  const args = dangerouslySkipPermissions ? ["--dangerously-skip-permissions"] : [];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  if (extraArgs.length > 0) args.push(...extraArgs);
  args.push(...buildAntiSlopArgs(antiSlopPrompt));
  if (initialPrompt != null) args.push(initialPrompt);
  return args;
}

module.exports = {
  id: ID,
  label: "Claude Code",
  // The usage lane's vendor namespace (usage-scanner / usage-lane-core), which is NOT the adapter id:
  // the scanner tags Claude transcript entries `claude`, and the lane ledger's composite key joins on it.
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
  // Downstream code keys on these, never on the adapter id. Claude Code is the reference
  // implementation, so every one is true; a second adapter is what makes them load-bearing.
  capabilities: {
    hooks: true,
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
};
