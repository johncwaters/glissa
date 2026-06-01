// ── Health monitor footer panel ──────────────────────────────
// Renders memory + leak telemetry from server health-snapshot messages.
// Always shows a compact summary; click to expand into a detailed panel.

import { el, escapeHtml } from './dom-helpers.js';
import { sendControlMsg } from './control-ws.js';

const STATE_ABBREV = {
  DORMANT: 'DOR', INITIALIZING: 'INI', STARTING: 'STA',
  RUNNING: 'RUN', WAITING: 'WAI', IDLE: 'IDL',
  COMPLETE: 'CMP', DONE: 'DON', FAILED: 'FAI',
};

let _latest = null;
let _expanded = false;
let _root = null;
let _summaryEl = null;
let _detailEl = null;

function formatBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatUptime(s) {
  if (s == null) return '—';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function buildPanel() {
  const root = el('div', 'health-footer');
  root.dataset.expanded = 'false';
  // Hidden until debug mode turns it on (see setHealthMonitorVisible). Default
  // matches config debugMode: false, so it stays hidden through initial load.
  root.hidden = true;

  const summary = el('button', 'health-summary');
  summary.type = 'button';
  summary.setAttribute('aria-expanded', 'false');
  summary.setAttribute('aria-controls', 'health-detail');

  const detail = el('div', 'health-detail');
  detail.id = 'health-detail';
  detail.hidden = true;

  summary.addEventListener('click', () => {
    _expanded = !_expanded;
    root.dataset.expanded = String(_expanded);
    summary.setAttribute('aria-expanded', String(_expanded));
    detail.hidden = !_expanded;
    if (_expanded) {
      sendControlMsg({ type: 'request-health-snapshot' });
      renderDetail();
    }
  });

  root.append(summary, detail);
  _root = root;
  _summaryEl = summary;
  _detailEl = detail;
  return root;
}

function anomalyCount(a) {
  if (!a) return 0;
  let n = 0;
  if (a.listenerMismatch) n++;
  if (a.orphanPty) n++;
  if (a.destroyedReachable) n++;
  return n;
}

function renderSummary() {
  if (!_summaryEl || !_latest) return;
  const s = _latest;
  const anomalies = anomalyCount(s.anomalies);
  _summaryEl.innerHTML = `
    <span class="health-chev" aria-hidden="true">${_expanded ? '▼' : '▲'}</span>
    <span class="health-stat" title="V8 heap used"><span class="health-stat-label">Heap</span> ${formatBytes(s.process.heapUsed)}</span>
    <span class="health-stat" title="Resident set size (process memory)"><span class="health-stat-label">RSS</span> ${formatBytes(s.process.rss)}</span>
    <span class="health-stat" title="External buffers — PTY data lives here"><span class="health-stat-label">Ext</span> ${formatBytes(s.process.external)}</span>
    <span class="health-stat" title="Active resources (handles + requests)"><span class="health-stat-label">Hdl</span> ${s.process.activeResources}</span>
    <span class="health-stat" title="Sessions: alivePty / sleeping / total"><span class="health-stat-label">Sess</span> ${s.sessions.alivePty}/${s.sessions.sleeping}/${s.sessions.total}</span>
    <span class="health-stat" title="WebSockets: control + data"><span class="health-stat-label">WS</span> ${s.websockets.control}+${s.websockets.data}</span>
    <span class="health-stat" title="Server uptime"><span class="health-stat-label">Up</span> ${formatUptime(s.uptimeSeconds)}</span>
    ${anomalies > 0 ? `<span class="health-anomaly" title="${anomalies} anomaly type(s) — expand for details">⚠ ${anomalies}</span>` : ''}
  `;
}

function renderDetail() {
  if (!_detailEl || !_latest) return;
  const s = _latest;
  const p = s.process;
  const w = s.websockets;
  const sess = s.sessions;
  const a = s.anomalies || {};

  let anomaliesHtml = '';
  if (anomalyCount(a) > 0) {
    const lines = [];
    if (a.listenerMismatch) lines.push('Listener count mismatch — data WS listener leaked or missing');
    if (a.orphanPty) lines.push('Orphan PTY — session has live PTY but state is DONE/FAILED/DORMANT');
    if (a.destroyedReachable) lines.push('Destroyed session still reachable in sessions map');
    anomaliesHtml = `
      <div class="health-section health-section-warn">
        <div class="health-section-title">⚠ Anomalies</div>
        ${lines.map((l) => `<div class="health-row">${l}</div>`).join('')}
      </div>
    `;
  }

  const sessionRows = sess.list.map((sx) => {
    const flags = [];
    if (sx.sleeping) flags.push('sleeping');
    if (sx.autoKilled) flags.push('autoKilled');
    if (sx.destroyed) flags.push('destroyed');
    if (sx.pendingRestart) flags.push('pendingRestart');
    const timers = Object.entries(sx.timers).filter(([, v]) => v).map(([k]) => k).join(',') || 'none';
    return `
      <tr>
        <td>${escapeHtml(sx.name)}</td>
        <td class="health-mono">${STATE_ABBREV[sx.state] || sx.state}</td>
        <td class="health-mono">${sx.hasPty ? sx.ptyPid : '—'}</td>
        <td class="health-mono">${formatBytes(sx.outputBufferBytes)}</td>
        <td class="health-mono">${sx.outputBufferEntries}</td>
        <td class="health-mono">${sx.dataListenerCount}</td>
        <td class="health-mono health-dim">${timers}</td>
        <td class="health-mono health-dim">${flags.join(' ') || ''}</td>
      </tr>
    `;
  }).join('');

  _detailEl.innerHTML = `
    ${anomaliesHtml}
    <div class="health-section">
      <div class="health-section-title">Process</div>
      <div class="health-grid">
        <div class="health-row"><span class="health-label">Heap used</span><span class="health-mono">${formatBytes(p.heapUsed)}</span></div>
        <div class="health-row"><span class="health-label">Heap total</span><span class="health-mono">${formatBytes(p.heapTotal)}</span></div>
        <div class="health-row"><span class="health-label">RSS</span><span class="health-mono">${formatBytes(p.rss)}</span></div>
        <div class="health-row"><span class="health-label">External</span><span class="health-mono">${formatBytes(p.external)}</span></div>
        <div class="health-row"><span class="health-label">Array buffers</span><span class="health-mono">${formatBytes(p.arrayBuffers)}</span></div>
        <div class="health-row"><span class="health-label">Active resources</span><span class="health-mono">${p.activeResources}</span></div>
        <div class="health-row"><span class="health-label">Uptime</span><span class="health-mono">${formatUptime(s.uptimeSeconds)}</span></div>
      </div>
    </div>

    <div class="health-section">
      <div class="health-section-title">WebSockets</div>
      <div class="health-grid">
        <div class="health-row"><span class="health-label">Control clients</span><span class="health-mono">${w.control}</span></div>
        <div class="health-row"><span class="health-label">Data clients</span><span class="health-mono">${w.data}</span></div>
        <div class="health-row"><span class="health-label">Tracked per session</span><span class="health-mono">${w.dataPerSessionTotal}</span></div>
      </div>
    </div>

    <div class="health-section">
      <div class="health-section-title">Sessions (${sess.total} total · ${sess.alivePty} alive PTY · ${sess.sleeping} sleeping)</div>
      <div class="health-row health-dim">Listeners ${sess.totalDataListeners} · Output buffer ${formatBytes(sess.totalOutputBufferBytes)}</div>
      <table class="health-table">
        <thead>
          <tr>
            <th>Name</th><th>State</th><th>PID</th><th>Buffer</th><th>Entries</th><th>Listeners</th><th>Timers</th><th>Flags</th>
          </tr>
        </thead>
        <tbody>${sessionRows || '<tr><td colspan="8" class="health-dim">No sessions</td></tr>'}</tbody>
      </table>
    </div>
  `;
}

export function setHealthMonitorVisible(on) {
  if (_root) _root.hidden = !on;
}

export function mountHealthMonitor(parent) {
  if (_root) return _root;
  const panel = buildPanel();
  parent.appendChild(panel);
  return panel;
}

export function applyHealthSnapshot(stats) {
  _latest = stats;
  renderSummary();
  if (_expanded) renderDetail();
}
