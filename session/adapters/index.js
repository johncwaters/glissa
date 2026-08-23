"use strict";

// The agent adapter registry (M1 of docs/plan-agent-adapters.md). It also owns THE lazy per-agent
// command cache that replaced the module-load CLAUDE_CMD global: resolution runs on the first spawn
// that needs it, so requiring sessions.js no longer pays a `where claude`, and it is cached per agent
// id so every session of that agent shares one lookup exactly as before.

const claudeCode = require("./claude-code");

const DEFAULT_AGENT_ID = claudeCode.id;

const ADAPTERS = new Map([[claudeCode.id, claudeCode]]);

const resolvedCommands = new Map();

function listAgentIds() {
  return [...ADAPTERS.keys()];
}

function isKnownAgentId(agentId) {
  return typeof agentId === "string" && ADAPTERS.has(agentId);
}

function getAdapter(agentId) {
  if (agentId == null) return ADAPTERS.get(DEFAULT_AGENT_ID);
  const adapter = ADAPTERS.get(agentId);
  if (adapter) return adapter;
  return null;
}

// The defensive read a construction site uses: an unknown id costs a warning and the default agent,
// never a failed spawn (config-store refuses the value on reload; boot must still come up).
function resolveAdapter(agentId, { warn = console.warn, label = "" } = {}) {
  const adapter = getAdapter(agentId);
  if (adapter) return adapter;
  warn(`[glissa]${label ? ` ${label}:` : ""} unknown agent "${agentId}", falling back to ${DEFAULT_AGENT_ID}`);
  return ADAPTERS.get(DEFAULT_AGENT_ID);
}

function commandFor(adapterOrId, options) {
  const adapter = typeof adapterOrId === "string" ? resolveAdapter(adapterOrId) : adapterOrId;
  if (resolvedCommands.has(adapter.id)) return resolvedCommands.get(adapter.id);
  const resolved = adapter.resolveCommand(options);
  resolvedCommands.set(adapter.id, resolved);
  return resolved;
}

// Tests only: drop the cache so a resolution can be observed happening again.
function resetCommandCache() {
  resolvedCommands.clear();
}

module.exports = {
  DEFAULT_AGENT_ID,
  listAgentIds,
  isKnownAgentId,
  getAdapter,
  resolveAdapter,
  commandFor,
  resetCommandCache,
};
