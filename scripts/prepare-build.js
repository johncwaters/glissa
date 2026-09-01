'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const viteBin = path.join(__dirname, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite');

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

spawnSync(process.execPath, [path.join(__dirname, 'postinstall.mjs')], { stdio: 'inherit' });
