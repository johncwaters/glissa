const RTK_PATH_ENV = "GLISSA_RTK_PATH";

const MAX_RTK_STDOUT_BYTES = 65536;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeRtkHookResponse(stdoutText: unknown): string {
  if (typeof stdoutText !== "string") return "";
  const trimmed = stdoutText.trim();
  if (!trimmed) return "";
  if (Buffer.byteLength(trimmed) > MAX_RTK_STDOUT_BYTES) return "";
  let parsed: unknown = null;
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

export { RTK_PATH_ENV, MAX_RTK_STDOUT_BYTES, normalizeRtkHookResponse };
