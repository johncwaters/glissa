// Canonical client-trust module - single source of truth for server and browser.
// Server-side: import from '../shared/client-trust.ts' (re-exported from server/core/request-trust).
// Browser-side: import from '#shared/client-trust.ts'.
//
// The action gate decides PRESENTATION only. A paired device is full-trust by design (its pairing
// cookie is documented as RCE-equivalent), so hiding an action here removes a control the operator
// could not act on; it does not deny them anything.

export type ClientTrust = 'local' | 'remote';

// Server-machine actions with no remote recovery path. Shutting the server down from a phone strands
// the operator: nothing remains listening to start it again. Restarting does not belong here - the
// production restart respawns the process detached and the dashboard reconnects on its own.
export const REMOTE_HIDDEN_SERVER_ACTIONS: readonly string[] = Object.freeze(['shutdown']);

// 'local' is the machine Glissa runs on, 'remote' a paired device reaching the second listener.
// Anything else, including a connection remote mode never stamped (remote mode off) or a server too
// old to send the label at all, is local by definition.
export function normalizeClientTrust(trust: unknown): ClientTrust {
  return trust === 'remote' ? 'remote' : 'local';
}

export function shouldShowServerAction(actionId: string, trust: unknown): boolean {
  if (normalizeClientTrust(trust) === 'local') return true;
  return !REMOTE_HIDDEN_SERVER_ACTIONS.includes(actionId);
}
