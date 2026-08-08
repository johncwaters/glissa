'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const viteBin = path.join(__dirname, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite');

function runNpm(args, env = {}) {
  const child = spawnSync(npmBin, args, {
    env: { ...process.env, ...env, npm_config_global: 'false' },
    stdio: 'inherit',
    shell: false,
  });
  if (child.error) {
    console.error(`prepare-build: ${npmBin} failed to start: ${child.error.message}`);
    process.exit(1);
  }
  if (child.status === 0) return;
  process.exit(child.status || 1);
}

if (!fs.existsSync(viteBin)) {
  runNpm(['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
}
runNpm(['run', 'build']);
