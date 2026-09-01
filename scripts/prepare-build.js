'use strict';

// Stays plain .js: npm runs this inside node_modules on a git install, where Node refuses type stripping.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const viteBin = path.join(__dirname, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite');

// Node 20.12+ refuses to spawn .cmd shims without a shell (CVE-2024-27980
// hardening, EINVAL), so npm.cmd can never be spawned directly on Windows.
// Under an npm lifecycle, npm_execpath points at npm's own JS entry, which the
// current node can run shell-free on every platform; outside a lifecycle fall
// back to the PATH npm through a shell on Windows only.
function npmInvocation(args) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && /\.[cm]?js$/.test(npmExecPath)) {
    return { command: process.execPath, args: [npmExecPath, ...args], shell: false };
  }
  if (process.platform === 'win32') {
    return { command: 'npm', args, shell: true };
  }
  return { command: 'npm', args, shell: false };
}

function runNpm(args, env = {}) {
  const invocation = npmInvocation(args);
  const child = spawnSync(invocation.command, invocation.args, {
    env: { ...process.env, ...env, npm_config_global: 'false' },
    stdio: 'inherit',
    shell: invocation.shell,
  });
  if (child.error) {
    console.error(`prepare-build: npm failed to start: ${child.error.message}`);
    process.exit(1);
  }
  if (child.status === 0) return;
  process.exit(child.status || 1);
}

if (!fs.existsSync(viteBin)) {
  runNpm(['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
}
runNpm(['run', 'build']);
