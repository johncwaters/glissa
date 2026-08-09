'use strict';

// Pure decision: how a "Restart Server" request should hand control to the replacement process.
//
// Glissa's original restart is a self-respawn (spawn argv detached, exit 0), which is right when
// nothing supervises the process: the operator started `node server.js` from a terminal or a shortcut
// and only Glissa itself can bring Glissa back. Under a supervisor it is wrong twice over: the clean
// exit 0 does not satisfy systemd's `Restart=on-failure`, and the detached child is either killed with
// the unit's cgroup or lives outside it holding the port with no supervision. The unit then sits
// stopped with nothing listening until someone notices.
//
// systemd sets INVOCATION_ID in the service environment for every invocation (it is per-start, not
// inherited from the operator's shell), so its presence is the supervision signal. Under it the
// restart becomes "exit non-zero and let the supervisor start the replacement".

// Distinct from 1 on purpose: journalctl should be able to tell an operator-requested restart from a
// crash. Any non-zero value satisfies `Restart=on-failure`.
const SUPERVISED_RESTART_EXIT_CODE = 75;

/**
 * @param {Record<string, string|undefined>} env - process.env (or a fake in tests)
 * @returns {'respawn'|'exit-for-supervisor'}
 */
function decideRestartStrategy(env) {
  const invocationId = env ? env.INVOCATION_ID : undefined;
  // Present but empty is not a real invocation id (an operator exporting INVOCATION_ID= by hand, or a
  // shell that keeps the name with no value); treat it as unsupervised so the respawn still happens.
  if (typeof invocationId === 'string' && invocationId !== '') return 'exit-for-supervisor';
  return 'respawn';
}

module.exports = { decideRestartStrategy, SUPERVISED_RESTART_EXIT_CODE };
