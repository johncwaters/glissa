#!/usr/bin/env node
"use strict";

/**
 * Company-context MCP server (zero-dependency).
 *
 * Implements the OMC company-context contract: exactly one tool,
 *   get_company_context({ query }) -> { context: <markdown> }
 *
 * Transport: MCP stdio = newline-delimited JSON-RPC 2.0 (one message per line,
 * requests/responses on stdout, logs on stderr). No SDK, no npm install.
 *
 * The returned context is every .md file under ./context, concatenated.
 * Edit those files to change what OMC workflows see. The `query` argument is
 * accepted but currently unused (all context is returned); make it
 * query-aware later if the corpus grows.
 */

const fs = require("fs");
const path = require("path");

const CONTEXT_DIR = path.join(__dirname, "context");
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

function log(msg) {
  process.stderr.write(`[${SERVER_NAME}] ${msg}\n`);
}

function readContext() {
  let files;
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
  const parts = [];
  for (const f of files) {
    try {
      const body = fs.readFileSync(path.join(CONTEXT_DIR, f), "utf8").trim();
      if (body) parts.push(body);
    } catch {
      /* skip unreadable file */
    }
  }
  return parts.join("\n\n---\n\n") || "Company-context files are present but empty.";
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    const requested = params && params.protocolVersion;
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
    const name = params && params.name;
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

  // Notifications (no id) get no response.
  if (id === undefined || id === null) return;

  sendError(id, -32601, `Method not found: ${String(method)}`);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      log(`parse error: ${e.message}`);
      continue;
    }
    try {
      handle(msg);
    } catch (e) {
      log(`handler error: ${e.message}`);
      if (msg && msg.id != null) sendError(msg.id, -32603, String(e.message));
    }
  }
});
process.stdin.on("end", () => process.exit(0));

log(`ready (context: ${CONTEXT_DIR})`);
