const path = require("node:path");

// Pure spawn-environment builder, extracted from Session._buildSpawnEnv (behavior-preserving).
// Returns a COPY of baseEnv with the inherited Glissa/Claude-Code vars scrubbed so a spawned
// `claude` does not think it is running inside Glissa's own Claude session, plus the always-on
// no-flicker flag. baseEnv is never mutated (the spread copies it).
//
// extraEnv lets a lane hand a credential to its own headless session without exporting it
// process-wide, where every user session would inherit it. It is merged into the copy before the
// scrub, so it can add vars but never smuggle back one of the scrubbed names.
//
// additionalDirsClaudeMd is the context-mill delivery flag: without it Claude Code loads only
// skills and commands from an --add-dir, not the dir's CLAUDE.md or .claude/rules (live-verified on
// 2.1.235). It is an explicit argument rather than an extraEnv entry so the decision lives here, and
// it is set ONLY when a pack dir was actually added: a session with no packs keeps today's env.
//
// prependPathDir lets rtk's bare `rtk <cmd>` rewrites resolve inside the spawned session.
function normalizePathEntry(entry) {
  return entry.replace(/\\/g, "/").toLowerCase();
}

function prependPathDir(env, prependPathDirValue) {
  if (!prependPathDirValue) return;
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
  const existingPath = env[pathKey] || "";
  const pathEntries = existingPath.split(path.delimiter).filter(Boolean);
  const normalizedPrependDir = normalizePathEntry(prependPathDirValue);
  const alreadyPresent = pathEntries.some((entry) => normalizePathEntry(entry) === normalizedPrependDir);
  if (alreadyPresent) return;
  if (!existingPath) {
    env[pathKey] = prependPathDirValue;
    return;
  }
  env[pathKey] = `${prependPathDirValue}${path.delimiter}${existingPath}`;
}

function buildSpawnEnv(baseEnv, extraEnv, { additionalDirsClaudeMd = false, prependPathDir: pathDir = null } = {}) {
  const env = { ...baseEnv, ...(extraEnv || {}) };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_SSE_PORT;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.GLISSA_PORT;
  delete env.GLISSA_CONFIG;
  env.CLAUDE_CODE_NO_FLICKER = "1";
  if (additionalDirsClaudeMd) env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = "1";
  prependPathDir(env, pathDir);
  return env;
}

module.exports = { buildSpawnEnv };
