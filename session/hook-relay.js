'use strict';

// Hook relay, run standalone by a non-Claude agent CLI as a command-type hook, never required by the
// server (the session/statusline-relay.js mold). It reads the hook envelope from stdin, POSTs it
// UNTOUCHED to Glissa's local ingress, and exits 0 whatever happened: a hook that fails must never
// fail, delay or block the turn it was called from. Every decision it makes is in
// session/core/hook-relay-core.js; this file is the socket around them.
//
// Usage as a hook command: `node <path>/hook-relay.js <EventName>`, with GLISSA_HOOK_URL (token
// embedded) in the agent process's env, which hook children inherit. Without that variable the relay
// posts nothing, so an installed hooks file is inert for the operator's own unsupervised runs.

const http = require('node:http');

const { decideRelayPost } = require('./core/hook-relay-core');

// Bounded hard: the agent is waiting on this process, and the payload is telemetry.
const POST_TIMEOUT_MS = 1500;

function readStdin(stream) {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    };
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('end', finish);
    stream.on('error', finish);
    stream.on('close', finish);
  });
}

// Never rejects and never outlives POST_TIMEOUT_MS. The body is the stdin bytes verbatim: translating
// a vendor's field names is the adapter's job on the server side, where the session's vocabulary is known.
function postPayload(url, body) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (reason) => {
      if (settled) return;
      settled = true;
      resolve(reason);
    };
    let target = null;
    try {
      target = new URL(url);
    } catch {
      done('bad-url');
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
            'content-length': body.length,
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => done(`status-${res.statusCode}`));
          res.on('error', () => done('response-error'));
        },
      );
      req.on('error', () => done('request-error'));
      req.setTimeout(POST_TIMEOUT_MS, () => {
        req.destroy();
        done('timeout');
      });
      req.end(body);
    } catch {
      done('request-throw');
    }
  });
}

async function main(argv = process.argv.slice(2), stdin = process.stdin, env = process.env) {
  const [event] = argv;
  const body = await readStdin(stdin);
  const verdict = decideRelayPost({ env, event, payloadBytes: body.length });
  if (!verdict.post) return { code: 0, reason: verdict.reason };
  const outcome = await postPayload(verdict.url, body);
  return { code: 0, reason: outcome };
}

if (require.main === module) {
  main().then((result) => process.exit(result.code)).catch(() => process.exit(0));
}

module.exports = { main, postPayload, POST_TIMEOUT_MS };
