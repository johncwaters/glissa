// Header chip for the Headroom proxy supervisor. Renders the supervisor's lifecycle state
// (driven by headroom-status control messages) and sends start/stop over the control WS.
// Reuse note: searched public/ and public/session-card/ for an existing header chip or status
// pill module; chip-like patterns live inline in cards, so this is the first standalone one.
//
// Visibility rule: hidden until there is something to show. A not-installed supervisor only
// surfaces (dimmed, with an install hint) when the easy-start setting is on; every other state
// is always visible because the user (or the boot path) made the proxy exist.

import { sendControlMsg } from './control-ws.js';

let chipEl = null;
let btnEl = null;
let routeEl = null;
let statsEl = null;

let lastStatus = null; // latest headroom-status payload
let lastStats = null; // latest /stats summary (headroom-stats broadcast or status.stats)
let easyStart = false; // settings.headroomEasyStart (drives not-installed visibility)
let proxyBaseUrl = ''; // settings.proxyBaseUrl (drives the Use-for-sessions action)
let confirmTimer = null; // two-click stop confirm window

const CONFIRM_MS = 3000;

function disarmConfirm() {
  if (confirmTimer) clearTimeout(confirmTimer);
  confirmTimer = null;
}

function armConfirm() {
  disarmConfirm();
  confirmTimer = setTimeout(() => { confirmTimer = null; render(); }, CONFIRM_MS);
}

function labelFor(state, port) {
  if (state === 'starting') return 'Headroom starting';
  if (state === 'running') return confirmTimer ? 'Stop Headroom?' : `Headroom :${port}`;
  if (state === 'running-external') return `Headroom :${port} (external)`;
  if (state === 'failed') return 'Headroom failed';
  if (state === 'not-installed') return 'Headroom';
  return 'Headroom'; // stopped
}

function titleFor(status) {
  const { state, error, logTail } = status;
  if (state === 'not-installed') {
    return "Headroom is not installed. Install it separately: pip install 'headroom-ai[proxy]'";
  }
  if (state === 'failed') {
    const tail = (logTail || []).slice(-5).join('\n');
    return `${error || 'Headroom proxy failed'}${tail ? `\n\n${tail}` : ''}\nClick to restart.`;
  }
  if (state === 'running') return confirmTimer ? 'Click again to stop' : 'Headroom proxy is running. Click to stop.';
  if (state === 'running-external') return 'A Headroom proxy is already running on this port (not started by Glissa).';
  if (state === 'starting') return 'Waiting for the proxy to answer /livez';
  return 'Start the Headroom proxy';
}

function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// Compact savings readout. Compression earning its keep is the headline; until it has
// removed anything, the request count is the "traffic is flowing through the proxy" proof.
function statsLabel(s) {
  if (s.tokensRemoved > 0) {
    const pct = s.savingsPct > 0 ? ` (${s.savingsPct.toFixed(1)}%)` : '';
    return `${fmtTokens(s.tokensRemoved)} tok saved${pct}`;
  }
  return `${s.requests} req`;
}

function statsTitle(s) {
  return [
    'Headroom analytics',
    `Requests proxied: ${s.requests} (${s.compressedRequests} compressed)`,
    `Tokens removed: ${fmtTokens(s.tokensRemoved)}`,
    `Compression saved: $${s.savedUsd.toFixed(2)} (${s.savingsPct.toFixed(1)}%)`,
    `Cache reads saved: $${s.cacheSavedUsd.toFixed(2)}`,
    'Click to open the full Headroom dashboard.',
  ].join('\n');
}

function render() {
  if (!chipEl) return;
  if (!lastStatus) return;
  const { state, port } = lastStatus;

  const visible = state === 'not-installed' ? easyStart : true;
  chipEl.hidden = !visible;
  if (!visible) return;

  chipEl.dataset.state = confirmTimer ? 'confirm-stop' : state;
  btnEl.textContent = labelFor(state, port);
  btnEl.title = titleFor(lastStatus);
  btnEl.disabled = state === 'starting' || state === 'not-installed' || state === 'running-external';

  const usable = state === 'running' || state === 'running-external';
  const routable = usable && !proxyBaseUrl;
  routeEl.hidden = !routable;

  // Savings readout, linking to the proxy's own /dashboard for the full picture. The element
  // guard covers a cached pre-stats index.html served alongside the new module.
  if (!statsEl) return;
  const showStats = usable && !!lastStats;
  statsEl.hidden = !showStats;
  if (showStats) {
    statsEl.textContent = statsLabel(lastStats);
    statsEl.title = statsTitle(lastStats);
    statsEl.href = `http://127.0.0.1:${port}/dashboard`;
  }
}

function onChipClick() {
  if (!lastStatus) return;
  const { state } = lastStatus;
  if (state === 'stopped' || state === 'failed') {
    sendControlMsg({ type: 'start-headroom' });
    return;
  }
  if (state !== 'running') return;
  if (!confirmTimer) {
    // First click arms the inline confirm; stopping a proxy that live sessions may be routed
    // through deserves a second click.
    armConfirm();
    render();
    return;
  }
  disarmConfirm();
  sendControlMsg({ type: 'stop-headroom' });
  render();
}

function onRouteClick() {
  if (!lastStatus) return;
  const url = `http://127.0.0.1:${lastStatus.port}`;
  // Goes through the validated update-settings path; only the one key is touched. The
  // settings-updated broadcast loops back into applyHeadroomSettings and hides this button.
  sendControlMsg({ type: 'update-settings', settings: { proxyBaseUrl: url } });
}

export function initHeadroomChip() {
  chipEl = document.getElementById('headroom-chip');
  btnEl = document.getElementById('headroom-chip-btn');
  routeEl = document.getElementById('headroom-chip-route');
  statsEl = document.getElementById('headroom-chip-stats');
  if (!chipEl) return;
  btnEl.addEventListener('click', onChipClick);
  routeEl.addEventListener('click', onRouteClick);
}

export function applyHeadroomStatus(status) {
  if (!status || typeof status.state !== 'string') return;
  // A state change invalidates an armed stop-confirm (the thing being confirmed moved).
  if (lastStatus && lastStatus.state !== status.state) disarmConfirm();
  lastStatus = status;
  // status payloads carry the supervisor's stats snapshot (null after leaving running);
  // absent key (older payload shape) leaves the live broadcast value alone.
  if ('stats' in status) lastStats = status.stats;
  render();
}

export function applyHeadroomStats(stats) {
  lastStats = stats || null;
  render();
}

export function applyHeadroomSettings(settings) {
  if (!settings) return;
  if (typeof settings.headroomEasyStart === 'boolean') easyStart = settings.headroomEasyStart;
  if (typeof settings.proxyBaseUrl === 'string') proxyBaseUrl = settings.proxyBaseUrl;
  render();
}
