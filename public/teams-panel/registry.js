// Shared-state owner for the teams-panel modules: the single mounted view (or null when the Teams
// tab has never been mounted), the tab-activity dot state, and the running-instance key set.
// Deepest dependency in the teams-panel graph, mirroring session-card/card-registry.js.

// { container, stackEl, addBar, teams: Map, instances: Map<key, refs>, projects, activations }
export let mounted = null;

export function setMounted(next) { mounted = next; }

// Instance keys (teamId:projectId) with a run in flight - drives the tab activity dot.
export const runningKeys = new Set();

let tabActivityCb = null;

export function setTabActivityCallback(fn) { tabActivityCb = fn; }

export function notifyTabActivity() {
  if (tabActivityCb) tabActivityCb(runningKeys.size > 0);
}
