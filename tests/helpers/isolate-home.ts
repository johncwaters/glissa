import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function resolveIsolatedTestHome(): string {
  const sharedByParent = process.env.GLISSA_TEST_HOME;
  if (sharedByParent) return sharedByParent;

  const mintedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-test-home-'));
  process.env.GLISSA_TEST_HOME = mintedHome;
  process.on('exit', () => {
    fs.rmSync(mintedHome, { recursive: true, force: true });
  });
  return mintedHome;
}

process.env.GLISSA_HOME = resolveIsolatedTestHome();
