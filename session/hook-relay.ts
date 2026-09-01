import http from "node:http";

import { readStdin } from "./relay-stdin.ts";
import type { StdinLike } from "./relay-stdin.ts";

import {
  MAX_RESPONSE_BYTES,
  decideRelayPost,
  decideHookStdout,
} from "./core/hook-relay-core.ts";

const POST_TIMEOUT_MS = 1500;

interface PostResponse {
  reason: string;
  status: number | null | undefined;
  body: Buffer | null;
}

interface StdoutLike {
  write(text: string): unknown;
}

function postPayload(url: string, body: Buffer): Promise<PostResponse> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (response: PostResponse): void => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      done({ reason: "bad-url", status: null, body: null });
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
            "content-length": body.length,
          },
        },
        (res) => {
          const responseChunks: Buffer[] = [];
          let responseBytes = 0;
          res.on("data", (chunk: Buffer) => {
            if (settled) return;
            const bytes = Buffer.from(chunk);
            responseBytes += bytes.length;
            if (responseBytes > MAX_RESPONSE_BYTES) {
              res.destroy();
              done({ reason: "response-too-large", status: res.statusCode, body: null });
              return;
            }
            responseChunks.push(bytes);
          });
          res.on("end", () => done({
            reason: `status-${res.statusCode}`,
            status: res.statusCode,
            body: Buffer.concat(responseChunks),
          }));
          res.on("error", () => done({ reason: "response-error", status: res.statusCode, body: null }));
        },
      );
      req.on("error", () => done({ reason: "request-error", status: null, body: null }));
      req.setTimeout(POST_TIMEOUT_MS, () => {
        req.destroy();
        done({ reason: "timeout", status: null, body: null });
      });
      req.end(body);
    } catch {
      done({ reason: "request-throw", status: null, body: null });
    }
  });
}

async function main(
  argv: string[] = process.argv.slice(2),
  stdin: StdinLike = process.stdin,
  env: Record<string, string | undefined> = process.env,
  stdout: StdoutLike = process.stdout,
  hookStdoutDecision: (event: unknown, status: unknown, body: unknown) => string | null = decideHookStdout,
): Promise<{ code: number; reason: string }> {
  const [event] = argv;
  const body = await readStdin(stdin);
  const verdict = decideRelayPost({ env, event, payloadBytes: body.length });
  if (!verdict.post || !verdict.url) return { code: 0, reason: verdict.reason };
  const response = await postPayload(verdict.url, body);
  const hookStdout = hookStdoutDecision(event, response.status, response.body);
  if (hookStdout) {
    try { stdout.write(`${hookStdout}\n`); } catch {}
  }
  return { code: 0, reason: response.reason };
}

if (process.argv[1] === import.meta.filename) {
  main().then((result) => process.exit(result.code)).catch(() => process.exit(0));
}

export { main, postPayload, POST_TIMEOUT_MS };
