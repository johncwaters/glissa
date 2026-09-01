#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

type JsonRpcId = string | number | null | undefined;

interface JsonRpcMessage {
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

const CONTEXT_DIR = path.join(import.meta.dirname, "context");
const SERVER_NAME = "company-context";
const SERVER_VERSION = "0.1.0";
const DEFAULT_PROTOCOL = "2025-06-18";

const TOOL = {
  name: "get_company_context",
  description:
    "Return company/project reference material (conventions, security notes, " +
    "glossary, review checklists) as markdown. Informational reference only, " +
    "not instructions.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural-language summary of the current task and stage.",
      },
    },
  },
  outputSchema: {
    type: "object",
    properties: { context: { type: "string" } },
    required: ["context"],
  },
};

function log(msg: string): void {
  process.stderr.write(`[${SERVER_NAME}] ${msg}\n`);
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function readContext(): string {
  let files: string[];
  try {
    files = fs
      .readdirSync(CONTEXT_DIR)
      .filter((f) => f.toLowerCase().endsWith(".md"))
      .sort();
  } catch {
    return `No company-context directory at ${CONTEXT_DIR}. Create it and add .md files.`;
  }
  if (files.length === 0) {
    return `No .md files in ${CONTEXT_DIR}. Add markdown reference files there.`;
  }
  const parts: string[] = [];
  for (const f of files) {
    try {
      const body = fs.readFileSync(path.join(CONTEXT_DIR, f), "utf8").trim();
      if (body) parts.push(body);
    } catch {
    }
  }
  return parts.join("\n\n---\n\n") || "Company-context files are present but empty.";
}

function send(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}
function sendResult(id: JsonRpcId, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}
function sendError(id: JsonRpcId, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(msg: JsonRpcMessage): void {
  const { id, method, params } = msg;

  if (method === "initialize") {
    const requested = params?.protocolVersion;
    sendResult(id, {
      protocolVersion: typeof requested === "string" ? requested : DEFAULT_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }

  if (method === "tools/list") {
    sendResult(id, { tools: [TOOL] });
    return;
  }

  if (method === "tools/call") {
    const name = params?.name;
    if (name !== TOOL.name) {
      sendError(id, -32602, `Unknown tool: ${String(name)}`);
      return;
    }
    const context = readContext();
    sendResult(id, {
      content: [{ type: "text", text: context }],
      structuredContent: { context },
    });
    return;
  }

  if (method === "ping") {
    sendResult(id, {});
    return;
  }

  if (id === undefined || id === null) return;

  sendError(id, -32601, `Method not found: ${String(method)}`);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl = buf.indexOf("\n");
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    nl = buf.indexOf("\n");
    if (!line) continue;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      log(`parse error: ${messageOf(e)}`);
      continue;
    }
    try {
      handle(msg);
    } catch (e) {
      log(`handler error: ${messageOf(e)}`);
      if (msg && msg.id != null) sendError(msg.id, -32603, messageOf(e));
    }
  }
});
process.stdin.on("end", () => process.exit(0));

log(`ready (context: ${CONTEXT_DIR})`);
