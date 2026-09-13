import { isPlainObject } from './usage-number-core.ts';

interface EnvSecretBinding {
  blockName: string;
  secretKey: string;
  environmentVariable: string;
}

interface ResolvedEnvSecret extends EnvSecretBinding {
  value: string;
}

type ConfigBlocks = Record<string, unknown>;

const ENV_SECRET_BINDINGS: readonly EnvSecretBinding[] = Object.freeze([
  { blockName: 'posthog', secretKey: 'apiKey', environmentVariable: 'GLIMMERVOID_POSTHOG_API_KEY' },
  { blockName: 'telegram', secretKey: 'botToken', environmentVariable: 'GLIMMERVOID_TELEGRAM_BOT_TOKEN' },
]);

function readEnvSecrets(env: Record<string, string | undefined>): ResolvedEnvSecret[] {
  const resolvedSecrets: ResolvedEnvSecret[] = [];
  for (const binding of ENV_SECRET_BINDINGS) {
    const value = env[binding.environmentVariable];
    if (typeof value !== 'string' || value.length === 0) continue;
    resolvedSecrets.push({ ...binding, value });
  }
  return resolvedSecrets;
}

function copyOfBlock(config: ConfigBlocks, blockName: string): Record<string, unknown> {
  const block = config[blockName];
  if (!isPlainObject(block)) return {};
  return { ...block };
}

function withEnvSecrets<T extends ConfigBlocks>(config: T, envSecrets: readonly ResolvedEnvSecret[]): T {
  if (envSecrets.length === 0) return config;
  const overlaid: ConfigBlocks = { ...config };
  for (const secret of envSecrets) {
    overlaid[secret.blockName] = { ...copyOfBlock(overlaid, secret.blockName), [secret.secretKey]: secret.value };
  }
  return overlaid as T;
}

function withoutEnvSecrets<T extends ConfigBlocks>(config: T, envSecrets: readonly ResolvedEnvSecret[]): T {
  if (envSecrets.length === 0) return config;
  const stripped: ConfigBlocks = { ...config };
  for (const secret of envSecrets) {
    if (!isPlainObject(stripped[secret.blockName])) continue;
    const remaining = copyOfBlock(stripped, secret.blockName);
    delete remaining[secret.secretKey];
    if (Object.keys(remaining).length === 0) {
      delete stripped[secret.blockName];
      continue;
    }
    stripped[secret.blockName] = remaining;
  }
  return stripped as T;
}

function withSortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withSortedKeys);
  if (!isPlainObject(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = withSortedKeys(value[key]);
  return sorted;
}

function stableConfigKey(value: unknown): string {
  return JSON.stringify(withSortedKeys(value));
}

export { ENV_SECRET_BINDINGS, readEnvSecrets, stableConfigKey, withEnvSecrets, withoutEnvSecrets };
export type { EnvSecretBinding, ResolvedEnvSecret };
