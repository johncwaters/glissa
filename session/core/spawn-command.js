const path = require("node:path");

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

// Collapse candidates that name the SAME file, returning each survivor in its NORMALIZED form so the
// value compared and the value handed on (spawn path, boot warning) are the same string. `which -a` /
// `where` walk PATH entry by entry, so a PATH holding ~/.local/bin twice reports that one claude
// twice, which used to print a "multiple claude on PATH" warning listing the identical path twice.
// Normalization only (separators, trailing slashes, and case-INSENSITIVE keying on Windows, whose
// filesystem ignores case); no realpath, because two distinct paths pointing at one file through a
// symlink IS the shadowing risk the warning is for. Case is preserved in the output even where it is
// ignored for keying. Order is preserved, so the first match still wins the resolution.
function dedupePathMatches(matches, platform = process.platform) {
  // Keyed off the platform argument rather than the ambient `path`, so the normalization a caller
  // asks for does not depend on the OS this happens to run on.
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const seen = new Set();
  const unique = [];
  for (const candidate of matches) {
    let normalized = pathApi.normalize(candidate.trim());
    if (normalized.length > 1) normalized = normalized.replace(/[\\/]+$/, "");
    const key = platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(normalized);
  }
  return unique;
}

// Resolve `claude` once at module load. On Windows we prefer spawning the resolved
// .exe directly (node-pty -> CreateProcess), falling back to `cmd.exe /c claude` only
// for .cmd/.bat/.ps1 shim installs or when resolution fails. Resolving here also
// surfaces a Bun shim shadowing claude.exe in the boot log instead of at runtime.
function resolveCommandMatches(command, exec, platform) {
  const out = exec(command, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000,
  });
  return dedupePathMatches(out.split(/\r?\n/).filter((s) => s.trim()), platform);
}

function resolvePosixClaudeMatches(exec) {
  let matches = [];
  try {
    matches = resolveCommandMatches("which -a claude", exec, "linux");
  } catch {
    matches = [];
  }
  if (matches.length > 0) return matches;

  try {
    return resolveCommandMatches('sh -c "command -v claude"', exec, "linux");
  } catch {
    return [];
  }
}

function resolveClaudeCommand({ platform = process.platform, exec = execSync } = {}) {
  let matches = [];
  try {
    if (platform === "win32") matches = resolveCommandMatches("where claude", exec, platform);
    if (platform !== "win32") matches = resolvePosixClaudeMatches(exec);
  } catch {
    matches = [];
  }
  if (matches.length === 0) {
    console.warn(`[glissa] could not resolve 'claude' on PATH`);
    return { path: null, kind: "unresolved" };
  }
  const resolvedPath = matches[0];
  // Gated: this prints the operator's home-dir path, and every Session construction (each test
  // included) triggers module-load resolution, so an ungated log spams a full test run.
  if (process.env.GLISSA_DEBUG_SPAWN) {
    console.log(`[glissa] resolved 'claude' (first match wins): ${resolvedPath}`);
  }
  if (matches.length > 1) {
    console.warn(
      `[glissa] multiple 'claude' on PATH (Bun shim risk):\n  ${matches.join("\n  ")}`,
    );
  }
  const kind = classifyClaudeKind(resolvedPath);
  if (platform === "win32") {
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
// packArgs (the context mill's --add-dir pairs) sits with the --settings block, ahead of claudeArgs,
// whose last element may be the initial-prompt positional.
function buildSpawnCommand({ platform, resolved, settingsArgs = [], packArgs = [], claudeArgs = [] }) {
  const childArgs = [...settingsArgs, ...packArgs, ...claudeArgs];
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
  dedupePathMatches,
  resolveClaudeCommand,
  buildSpawnCommand,
  CLAUDE_CMD,
};
