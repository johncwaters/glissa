// Pure spawn-environment builder, extracted from Session._buildSpawnEnv (behavior-preserving).
// Returns a COPY of baseEnv with the inherited Glissa/Claude-Code vars scrubbed so a spawned
// `claude` does not think it is running inside Glissa's own Claude session, plus the always-on
// no-flicker flag. baseEnv is never mutated (the spread copies it).
//
// opts.proxyBaseUrl: when a non-empty string, exported as ANTHROPIC_BASE_URL so the spawned
// Claude Code routes its API traffic through a local LLM proxy (e.g. Headroom, LiteLLM).
// Glissa never spawns or manages the proxy; it only points sessions at it. Empty/absent
// leaves any inherited ANTHROPIC_BASE_URL untouched (a user-level override keeps working).
function buildSpawnEnv(baseEnv, { proxyBaseUrl = "" } = {}) {
  const env = { ...baseEnv };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_SSE_PORT;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.GLISSA_PORT;
  delete env.GLISSA_CONFIG;
  env.CLAUDE_CODE_NO_FLICKER = "1";
  const proxy = typeof proxyBaseUrl === "string" ? proxyBaseUrl.trim() : "";
  if (proxy) env.ANTHROPIC_BASE_URL = proxy;
  return env;
}

module.exports = { buildSpawnEnv };
