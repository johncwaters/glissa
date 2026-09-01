export type ClientTrust = 'local' | 'remote';

export const REMOTE_HIDDEN_SERVER_ACTIONS: readonly string[] = Object.freeze(['shutdown']);

export function normalizeClientTrust(trust: unknown): ClientTrust {
  return trust === 'remote' ? 'remote' : 'local';
}

export function shouldShowServerAction(actionId: string, trust: unknown): boolean {
  if (normalizeClientTrust(trust) === 'local') return true;
  return !REMOTE_HIDDEN_SERVER_ACTIONS.includes(actionId);
}
