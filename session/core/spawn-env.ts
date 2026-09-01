import path from "node:path";

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
