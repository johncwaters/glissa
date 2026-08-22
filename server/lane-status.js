'use strict';

// Synthesized status for a poller lane that has never ticked: the connect-time replay and the
// settings-toggle broadcast both need one so a client can tell off from waiting-for-first-poll.
function emptyLaneStatus(type, gate) {
  return { type, ts: Date.now(), configured: gate.start, reason: gate.reason, projects: [] };
}

module.exports = { emptyLaneStatus };
