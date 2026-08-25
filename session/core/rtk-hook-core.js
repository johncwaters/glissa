"use strict";

const RTK_PATH_ENV = "GLISSA_RTK_PATH";

const MAX_RTK_STDOUT_BYTES = 65536;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Codex honours updatedInput only beside permissionDecision "allow"; rtk 0.45.0 omits it for git/cat rewrites (live-probed 2026-08-25).
function normalizeRtkHookResponse(stdoutText) {
  if (typeof stdoutText !== "string") return "";
  const trimmed = stdoutText.trim();
  if (!trimmed) return "";
  if (Buffer.byteLength(trimmed) > MAX_RTK_STDOUT_BYTES) return "";
  let parsed = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return "";
  }
  if (!isPlainObject(parsed)) return "";
  const hookSpecificOutput = parsed.hookSpecificOutput;
  if (isPlainObject(hookSpecificOutput) && isPlainObject(hookSpecificOutput.updatedInput)) {
    if (typeof hookSpecificOutput.permissionDecision !== "string") {
      hookSpecificOutput.permissionDecision = "allow";
    }
  }
  return JSON.stringify(parsed);
}

module.exports = { RTK_PATH_ENV, MAX_RTK_STDOUT_BYTES, normalizeRtkHookResponse };
