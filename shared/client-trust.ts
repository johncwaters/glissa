export type ClientTrust = 'local' | 'remote';

export function normalizeClientTrust(trust: unknown): ClientTrust {
  return trust === 'remote' ? 'remote' : 'local';
}

export function shouldShowServerAction(actionId: string, trust: unknown): boolean {
  if (normalizeClientTrust(trust) === 'local') return true;
  return actionId !== 'shutdown';
}
