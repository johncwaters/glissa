import path from "node:path";

type PathLookupExec = (
  command: string,
  options: { encoding: 'utf8'; stdio: ['ignore', 'pipe', 'ignore']; timeout: number },
) => string;

type CommandKind = "exe" | "shim" | "unresolved";

interface ResolvedCommand {
  path: string | null;
  kind: string;
}

function classifyCommandKind(resolvedPath: string | null | undefined): CommandKind {
  if (!resolvedPath) return "unresolved";
  const ext = (resolvedPath.match(/\.[^.\\/]+$/) || [""])[0].toLowerCase();
  return ext === ".exe" || ext === ".com" ? "exe" : "shim";
}

function dedupePathMatches(
  matches: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const seen = new Set<string>();
  const unique: string[] = [];
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

function resolvePathCommandMatches(
  name: string,
  { platform, exec }: { platform: NodeJS.Platform; exec: PathLookupExec },
): string[] {
  const run = (command: string): string[] => {
    const output = exec(command, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    return dedupePathMatches(output.split(/\r?\n/).filter((line) => line.trim()), platform);
  };
  if (platform === "win32") {
    try {
      return run(`where ${name}`);
    } catch {
      return [];
    }
  }
  let matches: string[] = [];
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

function resolveAgentCommand(
  { name, platform = process.platform, exec }:
    { name: string; platform?: NodeJS.Platform; exec?: PathLookupExec },
): ResolvedCommand {
  if (typeof exec !== "function") throw new TypeError("resolveAgentCommand requires an exec function");
  const matches = resolvePathCommandMatches(name, { platform, exec });
  if (matches.length === 0) {
    console.warn(`[glissa] could not resolve '${name}' on PATH`);
    return { path: null, kind: "unresolved" };
  }
  const resolvedPath = matches[0];

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

function buildAgentSpawnCommand(
  { name, platform, resolved, argGroups = [] }: {
    name: string;
    platform: NodeJS.Platform;
    resolved?: ResolvedCommand | null;
    argGroups?: (string[] | null | undefined)[];
  },
): { file: string; args: string[] } {
  const childArgs = argGroups.flatMap((group) => group || []);
  if (platform !== "win32") {
    return { file: name, args: childArgs };
  }
  if (resolved && resolved.kind === "exe" && resolved.path) {
    return { file: resolved.path, args: childArgs };
  }

  return { file: "cmd.exe", args: ["/c", name, ...childArgs] };
}

const classifyClaudeKind = classifyCommandKind;
const resolveClaudeCommand = (
  opts: { platform?: NodeJS.Platform; exec?: PathLookupExec } = {},
): ResolvedCommand => resolveAgentCommand({ name: "claude", ...opts });
const buildSpawnCommand = ({ platform, resolved, settingsArgs = [], packArgs = [], claudeArgs = [] }: {
  platform: NodeJS.Platform;
  resolved?: ResolvedCommand | null;
  settingsArgs?: string[];
  packArgs?: string[];
  claudeArgs?: string[];
}): { file: string; args: string[] } =>
  buildAgentSpawnCommand({ name: "claude", platform, resolved, argGroups: [settingsArgs, packArgs, claudeArgs] });

export {
  classifyCommandKind,
  dedupePathMatches,
  resolvePathCommandMatches,
  resolveAgentCommand,
  buildAgentSpawnCommand,
  classifyClaudeKind,
  resolveClaudeCommand,
  buildSpawnCommand,
};
export type { CommandKind, PathLookupExec, ResolvedCommand };
