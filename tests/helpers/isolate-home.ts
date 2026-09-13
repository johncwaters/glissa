import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ENV_SECRET_BINDINGS } from '../../server/core/config-secrets-core.ts';

function resolveIsolatedTestHome(): string {
  const sharedByParent = process.env.GLIMMERVOID_TEST_HOME;
  if (sharedByParent) return sharedByParent;

  const mintedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-test-home-'));
  process.env.GLIMMERVOID_TEST_HOME = mintedHome;
  process.on('exit', () => {
    fs.rmSync(mintedHome, { recursive: true, force: true });
  });
  return mintedHome;
}

for (const binding of ENV_SECRET_BINDINGS) delete process.env[binding.environmentVariable];

process.env.GLIMMERVOID_HOME = resolveIsolatedTestHome();
