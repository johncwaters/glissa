// ── Client trust (pure) ───────────────────────────────────────
// The dashboard's view of its own control-WS connection: 'local' (the machine Glissa runs on) or
// 'remote' (a paired device reaching the second listener). The server stamps it per connection and
// sends it as `client-trust`; anything else, including a server too old to send the message at all,
// is local by definition, matching the server-side convention.
//
// This decides PRESENTATION only. A paired device is full-trust by design (its pairing cookie is
// documented as RCE-equivalent), so hiding an action here removes a control the operator could not
// act on, it does not deny them anything.

// Server-machine actions with no remote recovery path. Shutting the server down from a phone strands
// the operator: nothing remains listening to start it again. Restarting does not belong here - the
// production restart respawns the process detached and the dashboard reconnects on its own.
const REMOTE_HIDDEN_SERVER_ACTIONS = Object.freeze(['shutdown']);

export function normalizeClientTrust(trust) {
  return trust === 'remote' ? 'remote' : 'local';
}

export function shouldShowServerAction(actionId, trust) {
  if (normalizeClientTrust(trust) === 'local') return true;
  return !REMOTE_HIDDEN_SERVER_ACTIONS.includes(actionId);
}
