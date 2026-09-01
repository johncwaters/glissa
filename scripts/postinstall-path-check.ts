// Best-effort PATH notice printed after a GLOBAL `npm install -g github:johncwaters/glissa`.
//
// Contract: print-only. It never edits the operator's PATH and must NEVER fail an install: every path
// is wrapped so we always exit 0. It stays silent for local, dev, and dependency installs (gated on
// npm_config_global), and is skipped entirely under `npm install --ignore-scripts` (the bundled
// node-pty prebuild still loads at runtime, so glissa is unaffected).
//
// Reached through scripts/postinstall.mjs, which is the plain-JS half npm can run before dist exists.

import os from 'node:os';

import { formatPathNotice, npmGlobalBinDir, onPath } from '../bin/path-doctor.ts';

function printPathNotice(): void {
  if (process.env.npm_config_global !== 'true') return;

  const platform = process.platform;
  const binDir = npmGlobalBinDir({ env: process.env, platform, homedir: os.homedir() });
  if (!binDir) return;

  const pathEnv = process.env.PATH || process.env.Path || '';
  const onPathFlag = onPath(binDir, { pathEnv, platform });
  process.stdout.write(`\n${formatPathNotice({ installedBinDir: binDir, onPathFlag, platform })}\n\n`);
}

try {
  printPathNotice();
} catch {
  // Install hardening must never break an install.
}
