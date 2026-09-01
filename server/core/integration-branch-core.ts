export function configuredIntegrationBranch(config: { integrationBranch?: unknown } | null | undefined): string | null {
  const configuredBranch = config?.integrationBranch;
  if (typeof configuredBranch !== 'string') return null;
  return configuredBranch || null;
}
