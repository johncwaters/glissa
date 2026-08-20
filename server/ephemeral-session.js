'use strict';

// Register an ephemeral (never persisted) Session in its lane's map with guaranteed cleanup:
// removal + data-client close on 'exit', and a wrapped destroy() because callers'
// removeAllListeners can pre-empt the 'exit' cleanup (every orchestrator/poller finish path
// calls destroy()). logPrefix names the lane in error logs (e.g. 'pr-review', 'posthog').
function registerEphemeralSession({ map, id, sess, closeSessionDataClients, logPrefix, name, recordLane = null }) {
  map.set(id, sess);
  /*
   * Lane attribution. Every ephemeral lane registers here and already names itself via logPrefix, so this is
   * the one place that knows both the lane and the Claude session id it spawned. Hooks do fire for these
   * headless `-p` sessions (live-verified: UserPromptSubmit, Stop and SessionEnd all arrive carrying
   * session_id), which is what makes the lanes attributable at all.
   */
  if (typeof recordLane === 'function') {
    sess.on('claude-session-id', ({ id: claudeSessionId }) => recordLane(claudeSessionId, logPrefix));
  }
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
