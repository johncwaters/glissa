'use strict';

// Pure core of the Headroom proxy supervisor (the seam pattern used by agent-tracker.js /
// spawn-command.js). Zero I/O: the transition table, the detection candidate list, and the
// proxy arg builder live here so headroom-service.js stays a thin stateful shell and the
// lifecycle rules are unit-testable without fakes. No service import, no child_process.

// States: not-installed | stopped | starting | running | running-external | stopping | failed.
// running-external means something already answers /livez on the configured port: Glissa uses
// it but does not own it, so stop/spawn are forbidden from that state (the table returns null
// and the service refuses, never signaling a process it did not start).
//
// Transition table: state -> event -> next state. Anything absent is an illegal transition
// (nextState returns null and the caller treats it as a refused no-op). Notes:
// - detect-missing lands in not-installed, NEVER failed: failed is reserved for a present
//   binary whose proxy crashed or never became ready, so the chip can distinguish "install it"
//   from "it broke".
// - probe-external is legal from starting/failed too: a spawn that loses the dev+prod startup
//   race (EADDRINUSE) re-probes /livez and adopts the sibling's proxy instead of going red.
// - exit-clean during starting is still failed (the proxy died before ever answering /livez).
// - any exit while stopping resolves to stopped (we asked it to die; how it died is noise).
const TRANSITIONS = {
  'not-installed': {
    'detect-ok': 'stopped',
    'detect-missing': 'not-installed',
  },
  stopped: {
    'detect-missing': 'not-installed',
    spawn: 'starting',
    'probe-external': 'running-external',
  },
  starting: {
    ready: 'running',
    'probe-external': 'running-external',
    'exit-clean': 'failed',
    'exit-crash': 'failed',
    stop: 'stopping',
  },
  running: {
    'exit-clean': 'stopped',
    'exit-crash': 'failed',
    stop: 'stopping',
  },
  'running-external': {
    // stop and spawn are deliberately absent: never signal or shadow an external proxy.
  },
  stopping: {
    stopped: 'stopped',
    'exit-clean': 'stopped',
    'exit-crash': 'stopped',
  },
  failed: {
    spawn: 'starting',
    stop: 'stopped',
    'detect-missing': 'not-installed',
    'probe-external': 'running-external',
  },
};

// Pure transition lookup. Returns the next state, or null when the event is illegal from the
// given state (including stop from running-external, which the service surfaces as an error
// reply instead of a kill).
function nextState(state, event) {
  const row = TRANSITIONS[state];
  if (!row) return null;
  return row[event] || null;
}

// Ordered detection candidates for an externally installed Headroom CLI. Pure: no fs/glob, so
// the per-version APPDATA paths are generated (313 first: the install this feature was built
// against), and the service's async execFile simply fails fast down the list. The py launcher
// fallback covers a Scripts dir that never made it onto PATH.
const APPDATA_PYTHON_VERSIONS = ['313', '314', '312', '311', '310'];

function candidateCommands(env = {}) {
  const candidates = [{ file: 'headroom', args: [] }];
  const appData = typeof env.APPDATA === 'string' ? env.APPDATA : '';
  if (appData) {
    for (const v of APPDATA_PYTHON_VERSIONS) {
      candidates.push({
        file: `${appData}\\Python\\Python${v}\\Scripts\\headroom.exe`,
        args: [],
      });
    }
  }
  candidates.push({ file: 'py', args: ['-3.13', '-m', 'headroom'] });
  return candidates;
}

// Default proxy port (Headroom's own default).
const DEFAULT_HEADROOM_PORT = 8787;

// Build the `headroom proxy` argv. The port is re-validated here even though update-settings
// already gates it: this is the last hop before a command line, so no user-controlled string
// may pass through. A non-integer or out-of-range value falls back to the default port.
function buildProxyArgs(port) {
  const valid = Number.isInteger(port) && port >= 1024 && port <= 65535;
  const p = valid ? port : DEFAULT_HEADROOM_PORT;
  return ['proxy', '--port', String(p)];
}

module.exports = {
  nextState,
  candidateCommands,
  buildProxyArgs,
  DEFAULT_HEADROOM_PORT,
};
