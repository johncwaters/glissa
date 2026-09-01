'use strict';

const { readStdin } = require('./relay-stdin');

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

const {
  MAX_RESPONSE_BYTES,
  decideRelayPost,
  decideHookStdout,
} = require('./core/hook-relay-core.ts');

// Bounded hard: the agent is waiting on this process, and the payload is telemetry.
const POST_TIMEOUT_MS = 1500;

// Never rejects and never outlives POST_TIMEOUT_MS. The body is the stdin bytes verbatim: translating
// a vendor's field names is the adapter's job on the server side, where the session's vocabulary is known.
function postPayload(url, body) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (response) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    /** @type {URL | null} */
    let target = null;
    try {
      target = new URL(url);
    } catch {
      done({ reason: 'bad-url', status: null, body: null });
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
          /** @type {Buffer[]} */
          const responseChunks = [];
          let responseBytes = 0;
          res.on('data', (chunk) => {
            if (settled) return;
            const bytes = Buffer.from(chunk);
            responseBytes += bytes.length;
            if (responseBytes > MAX_RESPONSE_BYTES) {
              res.destroy();
              done({ reason: 'response-too-large', status: res.statusCode, body: null });
              return;
            }
            responseChunks.push(bytes);
          });
          res.on('end', () => done({
            reason: `status-${res.statusCode}`,
            status: res.statusCode,
            body: Buffer.concat(responseChunks),
          }));
          res.on('error', () => done({ reason: 'response-error', status: res.statusCode, body: null }));
        },
      );
      req.on('error', () => done({ reason: 'request-error', status: null, body: null }));
      req.setTimeout(POST_TIMEOUT_MS, () => {
        req.destroy();
        done({ reason: 'timeout', status: null, body: null });
      });
      req.end(body);
    } catch {
      done({ reason: 'request-throw', status: null, body: null });
    }
  });
}

async function main(
  argv = process.argv.slice(2),
  stdin = process.stdin,
  env = process.env,
  stdout = process.stdout,
  hookStdoutDecision = decideHookStdout,
) {
  const [event] = argv;
  const body = await readStdin(stdin);
  const verdict = decideRelayPost({ env, event, payloadBytes: body.length });
  if (!verdict.post) return { code: 0, reason: verdict.reason };
  const response = await postPayload(verdict.url, body);
  const hookStdout = hookStdoutDecision(event, response.status, response.body);
  if (hookStdout) {
    try { stdout.write(`${hookStdout}\n`); } catch {}
  }
  return { code: 0, reason: response.reason };
}

if (require.main === module) {
  main().then((result) => process.exit(result.code)).catch(() => process.exit(0));
}

module.exports = { main, postPayload, POST_TIMEOUT_MS };
