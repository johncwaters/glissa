'use strict';

// Register an ephemeral (never persisted) Session in its lane's map with guaranteed cleanup:
// removal + data-client close on 'exit', and a wrapped destroy() because callers'
// removeAllListeners can pre-empt the 'exit' cleanup (every orchestrator/poller finish path
// calls destroy()). logPrefix names the lane in error logs (e.g. 'team', 'pr-review').
function registerEphemeralSession({ map, id, sess, closeSessionDataClients, logPrefix, name }) {
  map.set(id, sess);
  sess.on('error', (err) => console.error(`[${logPrefix} ${name}] error: ${err.message}`));
  const removeFromMap = () => {
    if (map.get(id) === sess) {
      map.delete(id);
      closeSessionDataClients(id);
    }
  };
  sess.on('exit', removeFromMap);
  const origDestroy = sess.destroy.bind(sess);
  sess.destroy = () => { origDestroy(); removeFromMap(); };
}

module.exports = { registerEphemeralSession };
