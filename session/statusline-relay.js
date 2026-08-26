'use strict';

const { readStdin } = require('./relay-stdin');

// Managed statusLine relay, run standalone by Claude Code per assistant/tool step, never required by
// the server. In PARALLEL (any delay is a visible TUI stall): fire-and-forget the stdin blob to the
// local hook ingress, and chain the statusLine command the operator already had, since a per-session
// statusLine REPLACES the global one (live-verified 2.1.235) and must not delete their HUD.

const http = require('node:http');
// Via the shared wrapper: this spawns a console child several times per turn, windowsHide matters.
const { spawn } = require('../server/child-process-safe');

// Bounded hard: the POST is telemetry, and the status line is the operator's. Anything slower than
// this is abandoned, not waited on.
const POST_TIMEOUT_MS = 1500;
// Argv marker for "the operator had no statusLine of their own".
const NO_CHAIN = '-';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

// Never resolves to a rejection and never outlives POST_TIMEOUT_MS. The loopback check is a guard on
// our own argv: this process only ever talks to the local Glissa.
function postPayload(url, body) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(undefined);
    };
    let target = null;
    try {
      target = new URL(url);
    } catch {
      done();
      return;
    }
    if (target.protocol !== 'http:' || !LOOPBACK_HOSTS.has(target.hostname)) {
      done();
      return;
    }
    try {
      const req = http.request(
        {
          hostname: target.hostname,
          port: target.port,
          path: `${target.pathname}${target.search}`,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        },
        (res) => {
          res.resume();
          res.on('end', done);
          res.on('error', done);
        },
      );
      req.on('error', done);
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

function decodeChainCommand(encoded) {
  if (!encoded || encoded === NO_CHAIN) return null;
  try {
    const command = Buffer.from(encoded, 'base64').toString('utf8').trim();
    return command || null;
  } catch {
    return null;
  }
}

// Used only with nothing to chain; minimal because Glissa stands in for the HUD, not competing.
function fallbackLine(payload) {
  const parts = [];
  const model = payload?.model?.display_name;
  if (typeof model === 'string' && model.trim()) parts.push(model.trim());
  const cost = payload?.cost?.total_cost_usd;
  if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0) parts.push(`$${cost.toFixed(2)}`);
  return parts.join('  ');
}

function parsePayload(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}

// stdout is inherited so the chained command's own buffering and colors reach the TUI untouched, and
// its stdin is fed the blob we already consumed (a stream cannot be read twice).
function runChain(command, stdinBody) {
  return new Promise((resolve) => {
    let child = null;
    try {
      child = spawn(command, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
    } catch {
      resolve(0);
      return;
    }
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolve(typeof code === 'number' ? code : 0);
    };
    child.on('error', () => finish(0));
    child.on('close', (code) => finish(code));
    child.stdin?.on('error', () => {});
    try {
      child.stdin?.end(stdinBody);
    } catch {
      // A command that closed stdin immediately is not our problem to report.
    }
  });
}

async function main(argv = process.argv.slice(2), stdin = process.stdin, stdout = process.stdout) {
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

if (require.main === module) {
  main().then((code) => process.exit(code)).catch(() => process.exit(0));
}

module.exports = { main, fallbackLine, decodeChainCommand, parsePayload, NO_CHAIN, POST_TIMEOUT_MS };
