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
}
