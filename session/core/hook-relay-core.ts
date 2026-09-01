const HOOK_URL_ENV = "GLISSA_HOOK_URL";

const MAX_PAYLOAD_BYTES = 65536;
const MAX_RESPONSE_BYTES = 65536;
const MAX_ADDITIONAL_CONTEXT_CHARS = 10000;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

const EVENT_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const HOOK_PATH_PREFIX = "/hook/";

interface RelayPostVerdict {
  post: boolean;
  url: string | null;
  reason: string;
}

function readHookUrl(env: Record<string, unknown> | null | undefined): string | null {
  const raw = env ? env[HOOK_URL_ENV] : null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

function normalizeEvent(event: unknown): string | null {
  if (typeof event !== "string") return null;
  const trimmed = event.trim();
  if (!EVENT_RE.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveHookTarget(baseUrl: string, event: string): { url: string | null; reason: string } {
  let target: URL;
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

function decideRelayPost(
  { env = {}, event = null, payloadBytes = 0 }: {
    env?: Record<string, string | undefined>;
    event?: unknown;
    payloadBytes?: number;
  } = {},
): RelayPostVerdict {
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

function decideHookStdout(event: unknown, status: unknown, body: unknown): string | null {
  const normalizedEvent = normalizeEvent(event);
  if (normalizedEvent !== "userpromptsubmit" && normalizedEvent !== "stop") return null;
  if (status !== 200) return null;
  const bodyBytes = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(String(body || ""));
  if (bodyBytes === 0 || bodyBytes > MAX_RESPONSE_BYTES) return null;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(String(body));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const hookSpecificOutput = parsed.hookSpecificOutput;
  if (!isPlainObject(hookSpecificOutput)) return null;
  if (normalizeEvent(hookSpecificOutput.hookEventName) !== normalizedEvent) return null;
  const additionalContext = hookSpecificOutput.additionalContext;
  if (typeof additionalContext !== "string") return null;
  if (additionalContext.length === 0 || additionalContext.length > MAX_ADDITIONAL_CONTEXT_CHARS) return null;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: normalizedEvent === "stop" ? "Stop" : "UserPromptSubmit",
      additionalContext,
    },
  });
}

export {
  HOOK_URL_ENV,
  MAX_PAYLOAD_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_ADDITIONAL_CONTEXT_CHARS,
  readHookUrl,
  normalizeEvent,
  resolveHookTarget,
  decideRelayPost,
  decideHookStdout,
};
export type { RelayPostVerdict };
