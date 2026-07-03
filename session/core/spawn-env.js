// Pure spawn-environment builder, extracted from Session._buildSpawnEnv (behavior-preserving).
// Returns a COPY of baseEnv with the inherited Glissa/Claude-Code vars scrubbed so a spawned
// `claude` does not think it is running inside Glissa's own Claude session, plus the always-on
// no-flicker flag. baseEnv is never mutated (the spread copies it).
function buildSpawnEnv(baseEnv) {
  const env = { ...baseEnv };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_SSE_PORT;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.GLISSA_PORT;
  delete env.GLISSA_CONFIG;
  env.CLAUDE_CODE_NO_FLICKER = "1";
  return env;
}

module.exports = { buildSpawnEnv };
