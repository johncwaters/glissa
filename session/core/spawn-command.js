const path = require("node:path");

const { execSync } = require("../../server/child-process-safe");

// Pure/stateless spawn-command mechanics, extracted from sessions.js (behavior-preserving) and
// generalized over the agent binary in M1 of docs/plan-agent-adapters.md: the "claude" name, its
// flag spellings and its log wording now live in session/adapters/claude-code.js, and what stays
// here is the PATH lookup and the per-platform spawn form every agent adapter shares.

// Classify a resolved agent path by extension. Only real PE images (.exe/.com)
// can be handed straight to node-pty (CreateProcess); .cmd/.bat/.ps1 are shims that
// must go through a shell, so they (and anything unrecognized) fall back to cmd.exe.
function classifyCommandKind(resolvedPath) {
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

// THE shared PATH-lookup (claude here, rtk in rtk-command.js): `where` on win32, `which -a` on POSIX with a `command -v` fallback since minimal distros ship no `which`; never throws, [] on failure, first match wins.
function resolvePathCommandMatches(name, { platform, exec }) {
  const run = (command) => {
    const out = exec(command, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    return dedupePathMatches(out.split(/\r?\n/).filter((s) => s.trim()), platform);
  };
  if (platform === "win32") {
    try {
      return run(`where ${name}`);
    } catch {
      return [];
    }
  }
  let matches = [];
  try {
    matches = run(`which -a ${name}`);
  } catch {
    matches = [];
  }
  if (matches.length > 0) return matches;
  try {
    return run(`sh -c "command -v ${name}"`);
  } catch {
    return [];
  }
}

// Resolve an agent binary on PATH, so a Bun shim shadowing claude.exe surfaces in the log instead of
// at runtime; the .exe/shim spawn split lives in buildAgentSpawnCommand below. Called once per agent
// through the adapter registry's lazy cache (session/adapters/index.js), never at module load.
function resolveAgentCommand({ name, platform = process.platform, exec = execSync }) {
  const matches = resolvePathCommandMatches(name, { platform, exec });
  if (matches.length === 0) {
    console.warn(`[glissa] could not resolve '${name}' on PATH`);
    return { path: null, kind: "unresolved" };
  }
  const resolvedPath = matches[0];
  // Gated: this prints the operator's home-dir path.
  if (process.env.GLISSA_DEBUG_SPAWN) {
    console.log(`[glissa] resolved '${name}' (first match wins): ${resolvedPath}`);
  }
  if (matches.length > 1) {
    console.warn(
      `[glissa] multiple '${name}' on PATH (Bun shim risk):\n  ${matches.join("\n  ")}`,
    );
  }
  const kind = classifyCommandKind(resolvedPath);
  if (platform === "win32") {
    console.log(
      `[glissa] ${name} spawn strategy: ${kind === "exe" ? "direct exe" : "cmd.exe shim fallback"}`,
    );
  }
  return { path: resolvedPath, kind };
}

// Pure spawn-command builder (the unit-test seam). Decides whether to spawn the
// resolved agent .exe directly or route through `cmd.exe /c <name>`. Keeps the
// shell path byte-identical to the historical behavior for shim/unresolved installs.
// argGroups are concatenated in order; the last group's last element may be the
// initial-prompt positional, so nothing may be appended after them.
function buildAgentSpawnCommand({ name, platform, resolved, argGroups = [] }) {
  const childArgs = argGroups.flatMap((group) => group || []);
  if (platform !== "win32") {
    return { file: name, args: childArgs };
  }
  if (resolved && resolved.kind === "exe" && resolved.path) {
    return { file: resolved.path, args: childArgs };
  }
  // .cmd/.bat/.ps1 shim or unresolved -> let cmd.exe resolve PATH+PATHEXT at spawn time.
  return { file: "cmd.exe", args: ["/c", name, ...childArgs] };
}

// Back-compat shims for the pre-adapter call sites and their pins. The Claude Code adapter is the
// live consumer; these keep `claude` bound to the old names.
const classifyClaudeKind = classifyCommandKind;
const resolveClaudeCommand = (opts = {}) => resolveAgentCommand({ name: "claude", ...opts });
const buildSpawnCommand = ({ platform, resolved, settingsArgs = [], packArgs = [], claudeArgs = [] }) =>
  buildAgentSpawnCommand({ name: "claude", platform, resolved, argGroups: [settingsArgs, packArgs, claudeArgs] });

module.exports = {
  classifyCommandKind,
  dedupePathMatches,
  resolvePathCommandMatches,
  resolveAgentCommand,
  buildAgentSpawnCommand,
  classifyClaudeKind,
  resolveClaudeCommand,
  buildSpawnCommand,
};
