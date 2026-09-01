'use strict';

// Stays plain .js: npm runs this inside node_modules on a git install, where Node refuses type stripping.
//
// Best-effort PATH notice printed after a GLOBAL `npm install -g github:johncwaters/glissa`.
//
// Contract: print-only. It never edits the user's PATH and must NEVER fail an
// install: every path is wrapped so we always exit 0. It stays silent for local,
// dev, and dependency installs (gated on npm_config_global), and is skipped
// entirely under `npm install --ignore-scripts` (the bundled node-pty prebuild
// still loads at runtime, so glissa is unaffected).

try {
  if (process.env.npm_config_global === 'true') {
    const os = require('node:os');
    const { npmGlobalBinDir, onPath, formatPathNotice } = require('../bin/path-doctor.ts');

    const platform = process.platform;
    const binDir = npmGlobalBinDir({ env: process.env, platform, homedir: os.homedir() });

    if (binDir) {
      const pathEnv = process.env.PATH || process.env.Path || '';
      const onPathFlag = onPath(binDir, { pathEnv, platform });
      const notice = formatPathNotice({ installedBinDir: binDir, onPathFlag, platform });
      process.stdout.write(`\n${notice}\n\n`);
    }
  }
} catch {
  // Install hardening must never break an install.
}

process.exit(0);
