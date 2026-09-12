import path from 'node:path';

export type ConfigPathSource = 'env' | 'home' | 'none';

export interface ConfigPathDecision {
  path: string | null;
  source: ConfigPathSource;
  homePath: string;
  envPath: string | null;
}

function glimmervoidHomeDir(homeDirectory: string, env: { GLIMMERVOID_HOME?: string }): string {
  if (env.GLIMMERVOID_HOME) return path.resolve(env.GLIMMERVOID_HOME);
  return path.join(homeDirectory, '.glimmervoid');
}

function decideConfigPath(
  {
    env = {},
    homeDir,
  }: { env?: { GLIMMERVOID_CONFIG?: string }; homeDir: string },
  exists: (candidate: string) => boolean,
): ConfigPathDecision {
  const homePath = path.join(homeDir, 'config.json');
  if (env.GLIMMERVOID_CONFIG) {
    const envPath = path.resolve(env.GLIMMERVOID_CONFIG);
    if (exists(envPath)) return { path: envPath, source: 'env', homePath, envPath };
    return { path: null, source: 'env', homePath, envPath };
  }

  if (exists(homePath)) return { path: homePath, source: 'home', homePath, envPath: null };
  return { path: null, source: 'none', homePath, envPath: null };
}

export { decideConfigPath, glimmervoidHomeDir };
