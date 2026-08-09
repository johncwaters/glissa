// ESM twin of shared/client-trust.js for Vite import resolution.
// Server-side code uses client-trust.js (CommonJS). Vite aliases /shared/client-trust.mjs to this
// file for the bundled build; a no-build production server serves it from the route of the same name.
//
// The twins are deliberately ASYMMETRIC. The server only needs normalizeClientTrust, so the CJS twin
// stops there; everything below it is presentation only the browser performs. Keep
// normalizeClientTrust itself identical in both.
//
// The action gate decides PRESENTATION only. A paired device is full-trust by design (its pairing
// cookie is documented as RCE-equivalent), so hiding an action here removes a control the operator
// could not act on; it does not deny them anything.

// Server-machine actions with no remote recovery path. Shutting the server down from a phone strands
// the operator: nothing remains listening to start it again. Restarting does not belong here - the
// production restart respawns the process detached and the dashboard reconnects on its own.
export const REMOTE_HIDDEN_SERVER_ACTIONS = Object.freeze(['shutdown']);

// 'local' is the machine Glissa runs on, 'remote' a paired device reaching the second listener.
// Anything else, including a connection remote mode never stamped (remote mode off) or a server too
// old to send the label at all, is local by definition.
export function normalizeClientTrust(trust) {
  return trust === 'remote' ? 'remote' : 'local';
}

export function shouldShowServerAction(actionId, trust) {
  if (normalizeClientTrust(trust) === 'local') return true;
  return !REMOTE_HIDDEN_SERVER_ACTIONS.includes(actionId);
}
