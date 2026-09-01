import type { ChildProcess } from "node:child_process";

import { readStdin } from "./relay-stdin.ts";
import type { StdinLike } from "./relay-stdin.ts";

import { spawn } from "../server/child-process-safe.ts";

import { MAX_RTK_STDOUT_BYTES, RTK_PATH_ENV, normalizeRtkHookResponse } from "./core/rtk-hook-core.ts";

// The agent's tool call blocks on this process and the rewrite is only an optimization.
const RTK_TIMEOUT_MS = 3000;

interface StdoutLike {
  write(text: string): unknown;
}

function runRtk(rtkPath: string, body: Buffer): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const done = (text: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(text);
    };
    let child: ChildProcess;
    try {
      child = spawn(rtkPath, ["hook", "claude"], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      done("");
      return;
    }
    const childStdout = child.stdout;
    const childStdin = child.stdin;
    if (!childStdout || !childStdin) {
      try { child.kill(); } catch {}
      done("");
      return;
    }
    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      done("");
    }, RTK_TIMEOUT_MS);
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    childStdout.on("data", (chunk: Buffer) => {
      const bytes = Buffer.from(chunk);
      stdoutBytes += bytes.length;
      if (stdoutBytes > MAX_RTK_STDOUT_BYTES) {
        try { child.kill(); } catch {}
        done("");
        return;
      }
      chunks.push(bytes);
    });
    childStdout.on("error", () => done(""));
    child.on("error", () => done(""));
    child.on("close", (code) => done(code === 0 ? Buffer.concat(chunks).toString("utf8") : ""));
    childStdin.on("error", () => {});
    try {
      childStdin.end(body);
    } catch {
      done("");
    }
  });
}

async function main(
  env: Record<string, string | undefined> = process.env,
  stdin: StdinLike = process.stdin,
  stdout: StdoutLike = process.stdout,
  runner: (rtkPath: string, body: Buffer) => Promise<string> = runRtk,
): Promise<{ code: number; reason: string }> {
  const configuredRtkPath = env[RTK_PATH_ENV];
  const rtkPath = typeof configuredRtkPath === "string" ? configuredRtkPath.trim() : "";
  const body = await readStdin(stdin);
  if (!rtkPath || body.length === 0) return { code: 0, reason: rtkPath ? "empty-payload" : "no-rtk-path" };
  const response = normalizeRtkHookResponse(await runner(rtkPath, body));
  if (!response) return { code: 0, reason: "no-rewrite" };
  try { stdout.write(`${response}\n`); } catch {}
  return { code: 0, reason: "rewritten" };
}

if (process.argv[1] === import.meta.filename) {
  main().then((result) => process.exit(result.code)).catch(() => process.exit(0));
}

export { main, runRtk, RTK_TIMEOUT_MS };
