const { execSync } = require("../../server/child-process-safe");

// Pure/stateless spawn-command seam, extracted from sessions.js (behavior-preserving).
// Decides how `claude` is launched per platform/install shape. No session state here.

// Classify a resolved `claude` path by extension. Only real PE images (.exe/.com)
// can be handed straight to node-pty (CreateProcess); .cmd/.bat/.ps1 are shims that
// must go through a shell, so they (and anything unrecognized) fall back to cmd.exe.
function classifyClaudeKind(resolvedPath) {
  if (!resolvedPath) return "unresolved";
  const ext = (resolvedPath.match(/\.[^.\\/]+$/) || [""])[0].toLowerCase();
  return ext === ".exe" || ext === ".com" ? "exe" : "shim";
}

// Resolve `claude` once at module load. On Windows we prefer spawning the resolved
// .exe directly (node-pty -> CreateProcess), falling back to `cmd.exe /c claude` only
// for .cmd/.bat/.ps1 shim installs or when resolution fails. Resolving here also
// surfaces a Bun shim shadowing claude.exe in the boot log instead of at runtime.
function resolveClaudeCommand() {
  let matches = [];
  try {
    const cmd = process.platform === "win32" ? "where claude" : "which -a claude";
    const out = execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    matches = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    // fall through to "could not resolve" warning below
  }
  if (matches.length === 0) {
    console.warn(`[glissa] could not resolve 'claude' on PATH`);
    return { path: null, kind: "unresolved" };
  }
  const resolvedPath = matches[0];
  console.log(`[glissa] resolved 'claude' (first match wins): ${resolvedPath}`);
  if (matches.length > 1) {
    console.warn(
      `[glissa] multiple 'claude' on PATH (Bun shim risk):\n  ${matches.join("\n  ")}`,
    );
  }
  const kind = classifyClaudeKind(resolvedPath);
  if (process.platform === "win32") {
    console.log(
      `[glissa] claude spawn strategy: ${kind === "exe" ? "direct exe" : "cmd.exe shim fallback"}`,
    );
  }
  return { path: resolvedPath, kind };
}

// Cached resolution used by every Session unless overridden via the constructor.
const CLAUDE_CMD = resolveClaudeCommand();

// Pure spawn-command builder (the unit-test seam). Decides whether to spawn the
// resolved claude .exe directly or route through `cmd.exe /c claude`. Keeps the
// shell path byte-identical to the historical behavior for shim/unresolved installs.
function buildSpawnCommand({ platform, resolved, settingsArgs = [], claudeArgs = [] }) {
  const childArgs = [...settingsArgs, ...claudeArgs];
  if (platform !== "win32") {
    return { file: "claude", args: childArgs };
  }
  if (resolved && resolved.kind === "exe" && resolved.path) {
    return { file: resolved.path, args: childArgs };
  }
  // .cmd/.bat/.ps1 shim or unresolved -> let cmd.exe resolve PATH+PATHEXT at spawn time.
  return { file: "cmd.exe", args: ["/c", "claude", ...childArgs] };
}

module.exports = {
  classifyClaudeKind,
  resolveClaudeCommand,
  buildSpawnCommand,
  CLAUDE_CMD,
};
