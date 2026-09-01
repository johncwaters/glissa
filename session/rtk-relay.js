'use strict';

const { readStdin } = require('./relay-stdin');

const { spawn } = require('../server/child-process-safe');

const { MAX_RTK_STDOUT_BYTES, RTK_PATH_ENV, normalizeRtkHookResponse } = require('./core/rtk-hook-core.ts');

// The agent's tool call blocks on this process and the rewrite is only an optimization.
const RTK_TIMEOUT_MS = 3000;

function runRtk(rtkPath, body) {
  return new Promise((resolve) => {
    let settled = false;
    /** @type {NodeJS.Timeout|null} */
    let timer = null;
    const done = (text) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(text);
    };
    /** @type {import('node:child_process').ChildProcess|null} */
    let child = null;
    try {
      child = spawn(rtkPath, ['hook', 'claude'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      done('');
      return;
    }
    const childStdout = child.stdout;
    const childStdin = child.stdin;
    if (!childStdout || !childStdin) {
      try { child.kill(); } catch {}
      done('');
      return;
    }
    timer = setTimeout(() => {
      if (child) {
        try { child.kill(); } catch {}
      }
      done('');
    }, RTK_TIMEOUT_MS);
    const chunks = [];
    let stdoutBytes = 0;
    childStdout.on('data', (chunk) => {
      const bytes = Buffer.from(chunk);
      stdoutBytes += bytes.length;
      if (stdoutBytes > MAX_RTK_STDOUT_BYTES) {
        try { child.kill(); } catch {}
        done('');
        return;
      }
      chunks.push(bytes);
    });
    childStdout.on('error', () => done(''));
    child.on('error', () => done(''));
    child.on('close', (code) => done(code === 0 ? Buffer.concat(chunks).toString('utf8') : ''));
    childStdin.on('error', () => {});
    try {
      childStdin.end(body);
    } catch {
      done('');
    }
  });
}

async function main(
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  runner = runRtk,
) {
  const configuredRtkPath = env[RTK_PATH_ENV];
  const rtkPath = typeof configuredRtkPath === 'string' ? configuredRtkPath.trim() : '';
  const body = await readStdin(stdin);
  if (!rtkPath || body.length === 0) return { code: 0, reason: rtkPath ? 'empty-payload' : 'no-rtk-path' };
  const response = normalizeRtkHookResponse(await runner(rtkPath, body));
  if (!response) return { code: 0, reason: 'no-rewrite' };
  try { stdout.write(`${response}\n`); } catch {}
  return { code: 0, reason: 'rewritten' };
}

if (require.main === module) {
  main().then((result) => process.exit(result.code)).catch(() => process.exit(0));
}

module.exports = { main, runRtk, RTK_TIMEOUT_MS };
