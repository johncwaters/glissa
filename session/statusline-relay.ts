import http from "node:http";
import type { ChildProcess } from "node:child_process";

import { readStdin } from "./relay-stdin.ts";
import type { StdinLike } from "./relay-stdin.ts";

// Managed statusLine relay, run standalone by Claude Code per assistant/tool step, never required by
// the server. In PARALLEL (any delay is a visible TUI stall): fire-and-forget the stdin blob to the
// local hook ingress, and chain the statusLine command the operator already had, since a per-session
// statusLine REPLACES the global one (live-verified 2.1.235) and must not delete their HUD.

// Via the shared wrapper: this spawns a console child several times per turn, windowsHide matters.
import { spawn } from "../server/child-process-safe.js";

// Bounded hard: the POST is telemetry, and the status line is the operator's. Anything slower than
// this is abandoned, not waited on.
const POST_TIMEOUT_MS = 1500;
// Argv marker for "the operator had no statusLine of their own".
const NO_CHAIN = "-";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

interface StdoutLike {
  write(text: string): unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Never resolves to a rejection and never outlives POST_TIMEOUT_MS. The loopback check is a guard on
// our own argv: this process only ever talks to the local Glissa.
function postPayload(url: string, body: Buffer): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      done();
      return;
    }
    if (target.protocol !== "http:" || !LOOPBACK_HOSTS.has(target.hostname)) {
      done();
      return;
    }
    try {
      const req = http.request(
        {
          hostname: target.hostname,
          port: target.port,
          path: `${target.pathname}${target.search}`,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (res) => {
          res.resume();
          res.on("end", done);
          res.on("error", done);
        },
      );
      req.on("error", done);
      req.setTimeout(POST_TIMEOUT_MS, () => {
        req.destroy();
        done();
      });
      req.end(body);
    } catch {
      done();
    }
  });
}

function decodeChainCommand(encoded: string | undefined): string | null {
  if (!encoded || encoded === NO_CHAIN) return null;
  try {
    const command = Buffer.from(encoded, "base64").toString("utf8").trim();
    return command || null;
  } catch {
    return null;
  }
}

// Used only with nothing to chain; minimal because Glissa stands in for the HUD, not competing.
function fallbackLine(payload: Record<string, unknown> | null): string {
  const parts: string[] = [];
  const modelField = payload?.model;
  const model = isPlainObject(modelField) ? modelField.display_name : undefined;
  if (typeof model === "string" && model.trim()) parts.push(model.trim());
  const costField = payload?.cost;
  const cost = isPlainObject(costField) ? costField.total_cost_usd : undefined;
  if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) parts.push(`$${cost.toFixed(2)}`);
  return parts.join("  ");
}

function parsePayload(raw: Buffer | string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(String(raw));
    if (isPlainObject(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}

// stdout is inherited so the chained command's own buffering and colors reach the TUI untouched, and
// its stdin is fed the blob we already consumed (a stream cannot be read twice).
function runChain(command: string, stdinBody: Buffer): Promise<number> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, { shell: true, stdio: ["pipe", "inherit", "inherit"] });
    } catch {
      resolve(0);
      return;
    }
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      resolve(typeof code === "number" ? code : 0);
    };
    child.on("error", () => finish(0));
    child.on("close", (code) => finish(code));
    child.stdin?.on("error", () => {});
    try {
      child.stdin?.end(stdinBody);
    } catch {
      // A command that closed stdin immediately is not our problem to report.
    }
  });
}

async function main(
  argv: (string | undefined)[] = process.argv.slice(2),
  stdin: StdinLike = process.stdin,
  stdout: StdoutLike = process.stdout,
): Promise<number> {
  const [postUrl, chainEncoded] = argv;
  const raw = await readStdin(stdin);
  const chainCommand = decodeChainCommand(chainEncoded);

  // Both started before either is awaited: the POST must not add its latency to the status line.
  const post = postUrl ? postPayload(postUrl, raw) : Promise.resolve();
  if (!chainCommand) {
    const line = fallbackLine(parsePayload(raw));
    if (line) stdout.write(`${line}\n`);
    await post;
    return 0;
  }
  const [code] = await Promise.all([runChain(chainCommand, raw), post]);
  return code;
}

if (process.argv[1] === import.meta.filename) {
  main().then((code) => process.exit(code)).catch(() => process.exit(0));
}

export { main, fallbackLine, decodeChainCommand, parsePayload, NO_CHAIN, POST_TIMEOUT_MS };
