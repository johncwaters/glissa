import path from "node:path";

// Pure spawn-environment mechanics, extracted from Session._buildSpawnEnv (behavior-preserving) and
// generalized over the agent in M1 of docs/plan-agent-adapters.md: WHICH vars are scrubbed and set is
// the adapter's env profile (session/adapters/claude-code.js), what stays here is the neutral apply.
// Returns a COPY of baseEnv; baseEnv is never mutated (the spread copies it).
//
// extraEnv lets a lane hand a credential to its own headless session without exporting it
// process-wide, where every user session would inherit it. It is merged into the copy before the
// scrub, so it can add vars but never smuggle back one of the scrubbed names.
//
// additionalDirsClaudeMd is the context-mill delivery flag: without it Claude Code loads only
// skills and commands from an --add-dir, not the dir's CLAUDE.md or .claude/rules (live-verified on
// 2.1.235). It is an explicit argument rather than an extraEnv entry so the decision lives here, and
// it is set ONLY when a pack dir was actually added and scrubbed otherwise: a backend running inside
// a pack-delivered Claude session would hand the inherited flag to every session it spawns.
// prependPathDir lets rtk's bare `rtk <cmd>` rewrites resolve inside the spawned session.

// A supervised agent must never inherit Glissa's own markers, whichever agent it is.
const GLISSA_SCRUB_KEYS = ["GLISSA_PORT", "GLISSA_CONFIG"];

type SpawnEnv = Record<string, string | undefined>;

interface AgentEnvProfile {
  scrub?: readonly string[];
  set?: Readonly<Record<string, string>>;
  additionalDirsEnvVar?: string | null;
}

interface AgentEnvOptions {
  additionalDirsClaudeMd?: boolean;
  prependPathDir?: string | null;
}

function normalizePathEntry(entry: string): string {
  return entry.replace(/\\/g, "/").toLowerCase();
}

function isWindowsDriveColon(value: string, index: number, entryStart: number): boolean {
  if (path.delimiter !== ":") return false;
  if (index !== entryStart + 1) return false;
  if (!/[A-Za-z]/.test(value[index - 1] || "")) return false;
  return value[index + 1] === "\\" || value[index + 1] === "/";
}

function splitPathEntries(value: string): string[] {
  const entries: string[] = [];
  let entryStart = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== path.delimiter) continue;
    if (isWindowsDriveColon(value, index, entryStart)) continue;
    entries.push(value.slice(entryStart, index));
    entryStart = index + 1;
  }
  entries.push(value.slice(entryStart));
  return entries.filter(Boolean);
}

function prependPathDir(env: SpawnEnv, prependPathDirValue: string | null | undefined): void {
  if (!prependPathDirValue) return;
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
  const existingPath = env[pathKey] || "";
  const pathEntries = splitPathEntries(existingPath);
  const normalizedPrependDir = normalizePathEntry(prependPathDirValue);
  const alreadyPresent = pathEntries.some((entry) => normalizePathEntry(entry) === normalizedPrependDir);
  if (alreadyPresent) return;
  if (!existingPath) {
    env[pathKey] = prependPathDirValue;
    return;
  }
  env[pathKey] = `${prependPathDirValue}${path.delimiter}${existingPath}`;
}

function buildAgentEnv(
  baseEnv: SpawnEnv,
  extraEnv: SpawnEnv | null | undefined,
  profile: AgentEnvProfile,
  { additionalDirsClaudeMd = false, prependPathDir: pathDir = null }: AgentEnvOptions = {},
): SpawnEnv {
  const env: SpawnEnv = { ...baseEnv, ...(extraEnv || {}) };
  for (const key of profile.scrub || []) delete env[key];
  for (const key of GLISSA_SCRUB_KEYS) delete env[key];
  Object.assign(env, profile.set || {});
  if (profile.additionalDirsEnvVar) delete env[profile.additionalDirsEnvVar];
  if (additionalDirsClaudeMd && profile.additionalDirsEnvVar) env[profile.additionalDirsEnvVar] = "1";
  prependPathDir(env, pathDir);
  return env;
}

export { buildAgentEnv };
export type { AgentEnvOptions, AgentEnvProfile, SpawnEnv };
