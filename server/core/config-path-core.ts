// One precedence for where config.json lives, so the seeding resolver, `glissa doctor` and the standalone
// relay cannot drift apart on it. Existence is injected: only the caller that MAY create the file knows.

import path from 'node:path';

export type ConfigPathSource = 'env' | 'local' | 'home' | 'none';

export interface ConfigPathDecision {
  path: string | null;
  source: ConfigPathSource;
  homePath: string;
  envPath: string | null;
}

function glissaHomeDir(homeDirectory: string): string {
  return path.join(homeDirectory, '.glissa');
}

/**
 * `source: 'env'` with a null path means GLISSA_CONFIG named a file that is not there, which is an
 * operator error rather than a reason to fall through to another config.
 */
function decideConfigPath(
  {
    env = {},
    homeDir,
    packageRoot,
  }: { env?: { GLISSA_CONFIG?: string }; homeDir: string; packageRoot: string },
  exists: (candidate: string) => boolean,
): ConfigPathDecision {
  const homePath = path.join(homeDir, 'config.json');
  if (env.GLISSA_CONFIG) {
    const envPath = path.resolve(env.GLISSA_CONFIG);
    if (exists(envPath)) return { path: envPath, source: 'env', homePath, envPath };
    return { path: null, source: 'env', homePath, envPath };
  }

  const localPath = path.join(packageRoot, 'config.json');
  if (exists(localPath)) return { path: localPath, source: 'local', homePath, envPath: null };
  if (exists(homePath)) return { path: homePath, source: 'home', homePath, envPath: null };
  return { path: null, source: 'none', homePath, envPath: null };
}

export { decideConfigPath, glissaHomeDir };
