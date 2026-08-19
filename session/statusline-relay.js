'use strict';

/*
 * Managed statusLine relay. Claude Code runs this as a standalone process (via git-bash on Windows)
 * once at startup and then per assistant/tool step, handing it the statusLine JSON blob on stdin. It is
 * NOT required by the server: the only thing it shares with Glissa is the URL it was given.
 *
 * Two jobs, run in PARALLEL, because this process sits in front of the operator's status line and any
 * delay here is a visible stall in the TUI:
 *
 *   1. Fire-and-forget the raw blob to Glissa's hook ingress on 127.0.0.1. Every failure is swallowed:
 *      Glissa being down, restarting, or slow must never cost the operator their status line.
 *   2. Chain the statusLine command the operator already had. A statusLine in a per-session --settings
 *      file REPLACES the one in ~/.claude/settings.json (live-verified, 2.1.235), so without this the
 *      feature would silently delete their HUD. The chained command inherits our stdout directly and we
 *      exit with its code.
 *
 * With no command to chain, a compact line is printed instead so the status line is never blank.
 */

const http = require('node:http');
// Through the shared wrapper, not node:child_process, for the reason that module exists: this spawns a
// console child several times per turn, and windowsHide:true is what keeps each one from flashing its own
// window. Requiring one leaf utility does not make the relay part of the server; it is still a standalone
// process that the server never requires.
const { spawn } = require('../server/child-process-safe');

// Bounded hard: the POST is telemetry, and the status line is the operator's. Anything slower than
// this is abandoned, not waited on.
const POST_TIMEOUT_MS = 1500;
// Argv marker for "the operator had no statusLine of their own".
const NO_CHAIN = '-';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function readStdin(stream) {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('end', finish);
    stream.on('error', finish);
    stream.on('close', finish);
  });
}

// Never resolves to a rejection and never outlives POST_TIMEOUT_MS. The loopback check is a guard on
// our own argv: this process only ever talks to the local Glissa.
function postPayload(url, body) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
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

/*
 * The fallback status line, used only when there is nothing to chain. Deliberately minimal: Glissa is
 * standing in for the operator's own status line here, not competing with it.
 */
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
