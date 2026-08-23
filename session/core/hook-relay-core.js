"use strict";

// Pure decisions for session/hook-relay.js, the standalone process a non-Claude agent CLI runs as a
// command-type hook (M2 of docs/plan-agent-adapters.md). Claude Code posts to Glissa's ingress itself
// over HTTP hooks; the other CLIs cannot (Codex has no http hook type, Grok's is SSRF-blocked against
// loopback), so a tiny relay stands in and this module holds every rule it can state without a socket:
// where the target comes from, whether it is one this process may talk to, and what makes a payload
// forwardable. No IO, no adapter import: field aliasing belongs to the adapter (M3/M4), never here.

// The target rides the spawn ENV, never argv, so the per-session bearer token in it is not visible in
// a local process listing, and an operator's own terminal run of the same CLI (which inherits no such
// var) executes the hook as a no-op.
const HOOK_URL_ENV = "GLISSA_HOOK_URL";

// The ingress destroys a request body past this (the hook route in server/backend.js), so a larger
// payload is dropped here rather than POSTed to be cut off mid-JSON.
const MAX_PAYLOAD_BYTES = 65536;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

// Claude Code's own hook URLs end in a lowercased event segment; the relay reproduces that shape so
// `POST /hook/:glissaId/:event` needs no change and a malformed payload still lands on the right handler.
const EVENT_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const HOOK_PATH_PREFIX = "/hook/";

function readHookUrl(env) {
  const raw = env ? env[HOOK_URL_ENV] : null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

function normalizeEvent(event) {
  if (typeof event !== "string") return null;
  const trimmed = event.trim();
  if (!EVENT_RE.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

// The loopback refusal mirrors session/statusline-relay.js: this process only ever talks to the local
// Glissa, so a target that is not plain http on a loopback host is a misconfiguration or an attempt to
// exfiltrate the hook payload, and either way it is refused rather than sent.
function resolveHookTarget(baseUrl, event) {
  let target = null;
  try {
    target = new URL(baseUrl);
  } catch {
    return { url: null, reason: "bad-url" };
  }
  if (target.protocol !== "http:") return { url: null, reason: "not-http" };
  if (!LOOPBACK_HOSTS.has(target.hostname)) return { url: null, reason: "not-loopback" };
  if (!target.pathname.startsWith(HOOK_PATH_PREFIX)) return { url: null, reason: "not-hook-path" };
  const base = target.pathname.replace(/\/+$/, "");
  target.pathname = `${base}/${event}`;
  return { url: target.toString(), reason: "ok" };
}

// The whole relay contract in one verdict. `post: false` is never an error the agent hears about: the
// relay exits 0 regardless, because a hook that fails must not fail the turn it was called from.
function decideRelayPost({ env = {}, event = null, payloadBytes = 0 } = {}) {
  const baseUrl = readHookUrl(env);
  if (!baseUrl) return { post: false, url: null, reason: "no-hook-url" };
  const name = normalizeEvent(event);
  if (!name) return { post: false, url: null, reason: "bad-event" };
  if (!Number.isFinite(payloadBytes) || payloadBytes < 0) return { post: false, url: null, reason: "bad-payload" };
  if (payloadBytes > MAX_PAYLOAD_BYTES) return { post: false, url: null, reason: "payload-too-large" };
  const target = resolveHookTarget(baseUrl, name);
  if (!target.url) return { post: false, url: null, reason: target.reason };
  return { post: true, url: target.url, reason: "ok" };
}

module.exports = {
  HOOK_URL_ENV,
  MAX_PAYLOAD_BYTES,
  readHookUrl,
  normalizeEvent,
  resolveHookTarget,
  decideRelayPost,
};
