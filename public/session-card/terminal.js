// Per-card terminal: xterm.js setup (fit/ResizeObserver, WebGL, scroll redraw,
// OSC-52 clipboard, custom key handling), terminal I/O wiring, and the data
// WebSocket that streams PTY bytes. Cross-card lifecycle (create/remove) lives
// in lifecycle.js; this module owns a single card's terminal and its socket.

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { isFocusAltShortcut } from '../focus-view/focus-shortcuts.mjs';
import { renderScheduler } from '../render-scheduler.mjs';
import { getTerminalTheme } from '../theme.js';
import { noteSessionOutput } from './activity.js';
import { sessionUIs } from './card-registry.js';
import { showErrorToast } from './toast.js';
import { tryLoadWebGL } from './webgl-pool.js';

// ── Constants ────────────────────────────────────────────────

const RECONNECT_DELAY_MS = 500;
const INPUT_QUEUE_MAX = 1024;

// Terminal defaults - cursorBlink updated from server settings on connect
// (applyTerminalSettings in lifecycle.js drives it through the setter below).
const TERMINAL_SCROLLBACK = 50000;
let _terminalCursorBlink = false;

export function setTerminalCursorBlink(v) {
  _terminalCursorBlink = v;
}

// ── OSC 52 clipboard ─────────────────────────────────────────

// atob returns a binary string; walk the bytes through TextDecoder so
// non-ASCII payloads survive the OSC 52 round-trip.
function decodeOsc52Payload(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function reportClipboardFailure(source, err) {
  const msg = err?.message || String(err);
  console.error(`[clipboard:${source}]`, err);
  showErrorToast(`Clipboard ${source} failed: ${msg}`);
}

// ── Data WebSocket ───────────────────────────────────────────

function connectDataWs(sessionId, ui, term) {
  const url = `ws://${location.host}/terminals/${encodeURIComponent(sessionId)}`;
  const ws = new WebSocket(url);
  ui.dataWs = ws;

  // Inbound PTY bytes go through the global render scheduler (Option A:
  // callback-gated round-robin) so heavy multi-session output can't starve typing.
  renderScheduler.register(sessionId, (data, cb) => term.write(data, cb));

  ws.addEventListener('message', (event) => {
    // Content-blind liveness tap: time the chunk's arrival to drive the working heartbeat.
    // Does not read event.data; the bytes still flow untouched through the render scheduler.
    noteSessionOutput(ui);
    renderScheduler.enqueue(sessionId, event.data);
  });

  ws.addEventListener('close', () => {
    renderScheduler.unregister(sessionId);
    // Only auto-reconnect if this ws is still the current one (not replaced by rename)
    if (ui.dataWs === ws) {
      ui.dataWs = null;
      setTimeout(() => {
        if (sessionUIs.has(sessionId)) {
          connectDataWs(sessionId, ui, term);
        }
      }, RECONNECT_DELAY_MS);
    }
  });

  ws.addEventListener('open', () => {
    // Clear terminal before replay to prevent duplicate content accumulation
    term.clear();
    // Push the current size to the PTY on every (re)connect so it can't
    // drift out of sync with the browser after a disconnect. Reset the cache
    // first so the send isn't skipped when cols/rows match the last value.
    ui._resetResizeCache?.();
    ui._applyFit?.();

    // Flush any keystrokes queued during disconnect.
    // Delay 50ms to let the server replay buffer arrive first.
    if (ui._inputQueue && ui._inputQueue.length > 0) {
      setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        for (const data of ui._inputQueue) {
          ws.send(JSON.stringify({ type: 'input', data }));
        }
        ui._inputQueue.length = 0;
      }, 50);
    }
  });
}

export function reconnectDataWs(id) {
  const ui = sessionUIs.get(id);
  if (ui?.dataWs) {
    ui.dataWs.close(); // close triggers auto-reconnect via the close handler
  }
}

// ── Terminal setup ───────────────────────────────────────────

export function setupTerminal(termWrap, ui) {
  const term = new Terminal({
    cursorBlink: _terminalCursorBlink,
    fontSize: 14,
    fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', 'Menlo', monospace",
    theme: getTerminalTheme(),
    scrollback: TERMINAL_SCROLLBACK,
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(termWrap);

  ui.term = term;
  ui.fitAddon = fitAddon;
  ui.webglAddon = null;
  ui.needsWebGLReload = false;

  // termWrap size → fit → push resize to PTY. RAF-coalesces burst fires
  // (window resize, focus borrow). The explicit send below the fit
  // covers the case where fit() proposes the same cols/rows xterm already
  // has (no onResize event) but the PTY hasn't caught up yet - most often
  // on first connect, where term starts at the default 80x24.
  let fitRafId = null;
  let lastSentCols = 0;
  let lastSentRows = 0;
  let lastFittedCols = 0;
  let lastFittedRows = 0;
  function applyFit() {
    fitRafId = null;
    if (!ui.fitAddon || !ui.term) return;
    // Skip fit when the card is off-screen (it lives in the hidden grid home until Focus borrows it
    // into the center); fitting a display:none card computes garbage dims. It gets a fresh fit on borrow.
    if (!ui.card.offsetParent) return;
    ui.fitAddon.fit();
    const { cols, rows } = ui.term;
    // When the buffer reflows after a dimension change, the WebGL renderer
    // can leave stale glyphs in cells that shifted (visible as ghost text
    // fragments at the left edge after window resize). clearTextureAtlas
    // invalidates the cached glyph atlas and triggers a full redraw.
    if (cols !== lastFittedCols || rows !== lastFittedRows) {
      ui.webglAddon?.clearTextureAtlas?.();
      lastFittedCols = cols;
      lastFittedRows = rows;
    }
    if (cols === lastSentCols && rows === lastSentRows) return;
    if (ui.dataWs?.readyState !== WebSocket.OPEN) return;
    ui.dataWs.send(JSON.stringify({ type: 'resize', cols, rows }));
    lastSentCols = cols;
    lastSentRows = rows;
  }
  const resizeObserver = new ResizeObserver(() => {
    if (fitRafId !== null) return;
    fitRafId = requestAnimationFrame(applyFit);
  });
  resizeObserver.observe(termWrap);
  ui.resizeObserver = resizeObserver;
  ui._applyFit = applyFit;
  // Reset the lastSent cache so the next _applyFit unconditionally pushes -
  // used on data-WS (re)connect, where the server-side PTY may have just
  // respawned and needs the current size even if the browser-side cols/rows
  // haven't changed.
  ui._resetResizeCache = () => { lastSentCols = 0; lastSentRows = 0; };

  // First-render fit: xterm's FitAddon silently no-ops if it's called before
  // the renderer has measured a cell, so the initial ResizeObserver fire can
  // leave the terminal stuck at the default 80×24. Re-fit once on first
  // render when the cell dimensions are guaranteed to be measurable.
  const firstRender = term.onRender(() => {
    firstRender.dispose();
    applyFit();
  });

  // Try WebGL - fall back to canvas silently
  tryLoadWebGL(ui);

  // Redraw all visible rows on scroll. RAF-coalesced so a burst of wheel
  // events still costs one refresh per frame.
  let scrollRafId = null;
  term.onScroll(() => {
    if (scrollRafId !== null) return;
    scrollRafId = requestAnimationFrame(() => {
      scrollRafId = null;
      if (!ui.term) return;
      ui.term.refresh(0, ui.term.rows - 1);
    });
  });

  // OSC 52: programs inside the terminal (e.g. Claude CLI) request the
  // emulator to write to the system clipboard via \x1b]52;c;<base64>\x07.
  // xterm.js has no built-in handler, so register one here. Payload format
  // is "<targets>;<base64>" where targets is "c" (clipboard) or "p"
  // (primary X11 selection) etc. - we accept any target and write once.
  term.parser.registerOscHandler(52, (data) => {
    const semi = data.indexOf(';');
    if (semi < 0) return true;
    const payload = data.slice(semi + 1);
    if (payload === '' || payload === '?') return true; // ignore read queries
    let text;
    try {
      text = decodeOsc52Payload(payload);
    } catch (err) {
      reportClipboardFailure('osc52 decode', err);
      return true;
    }
    // navigator.clipboard.writeText needs transient user activation. On refresh
    // the server replays the scrollback ring buffer, and any OSC-52 sequence still
    // in that window re-fires this handler with no activation - a doomed write the
    // browser rejects with "Write permission denied". Skip silently when there's no
    // activation (replayed/automated): the write would fail anyway, and the toast is
    // pure noise for something the user didn't do. A live OSC-52 right after the user
    // interacts still has activation and writes normally. userActivation is absent on
    // older engines; there we fall through and attempt the write as before.
    const hasActivation = document.hasFocus()
      && navigator.userActivation?.isActive !== false;
    if (!hasActivation) return true;
    navigator.clipboard.writeText(text).catch((err) => {
      reportClipboardFailure('osc52 write', err);
    });
    return true;
  });

  // Clipboard: Ctrl+C copies selection; Ctrl+V lets browser paste flow through
  // xterm's paste event → onData (returning false skips xterm's key processing
  // so it won't emit a raw \x16, but the browser paste event still fires)
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    // On the Focus tab the dashboard Alt shortcuts (Alt+W triage jump, Alt+Up/Down prev/next session,
    // Alt+0 Add Session, Alt+1..9 focus the Nth pill) are handled by the document keydown handler in
    // app.js, NOT the terminal. Skip them here so xterm neither writes an escape sequence to the PTY nor
    // consumes them; the keydown then bubbles to the document handler. This is what lets the shortcuts
    // work while the centered terminal holds focus. document.body.dataset.activeView is set by
    // activateView; isFocusAltShortcut is the single source of truth for which keys these are.
    if (ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey
        && document.body.dataset.activeView === 'focus'
        && isFocusAltShortcut(ev.key)) {
      return false;
    }
    const ctrl = ev.ctrlKey || ev.metaKey;
    if (ctrl && ev.key === 'c' && term.hasSelection()) {
      const selection = term.getSelection();
      term.clearSelection();
      navigator.clipboard.writeText(selection).catch((err) => {
        reportClipboardFailure('copy', err);
      });
      return false;
    }
    if (ctrl && ev.key === 'v') {
      return false;
    }
    // Ctrl+Backspace: send ESC+DEL so readline/bash deletes the previous word
    if (ctrl && ev.key === 'Backspace') {
      if (ui.dataWs?.readyState === WebSocket.OPEN) {
        ui.dataWs.send(JSON.stringify({ type: 'input', data: '\x1b\x7f' }));
      } else if (ui._inputQueue && ui._inputQueue.length < INPUT_QUEUE_MAX) {
        ui._inputQueue.push('\x1b\x7f');
      }
      return false;
    }
    return true;
  });

}

export function wireTerminalIO(ui, sessionId) {
  // Queue keystrokes during WebSocket disconnection for replay on reconnect
  ui._inputQueue = [];

  ui.term.onData((data) => {
    if (ui.dataWs?.readyState === WebSocket.OPEN) {
      ui.dataWs.send(JSON.stringify({ type: 'input', data }));
    } else if (ui._inputQueue.length < INPUT_QUEUE_MAX) {
      ui._inputQueue.push(data);
    }
  });

  // Note: term.onResize is intentionally not wired - the ResizeObserver
  // path in setupTerminal owns all "fit and notify server" duties via
  // ui._applyFit, which both fits and pushes cols/rows to the PTY.

  connectDataWs(sessionId, ui, ui.term);
}

// First-time terminal setup for cards that started life as DORMANT.
export function ensureTerminalSetup(ui, sessionId) {
  if (ui.term) return;
  setupTerminal(ui.termWrap, ui);
  wireTerminalIO(ui, sessionId);
}

// Force a full-viewport repaint after a transition that re-parents the card DOM
// (borrow into / release out of the Focus center). xterm only repaints rows it
// marks dirty, so after a re-parent the WebGL canvas can keep stale glyphs in
// quiescent rows (ghosts). Deferred one rAF so the card is on-screen when the
// refresh runs - a refresh issued while still off-screen is suppressed by
// xterm's _isPaused. Single in-flight rAF per card, mirroring the fit/scroll
// coalescing in setupTerminal.
export function forceTerminalRepaint(ui) {
  if (!ui || ui._repaintRafId != null) return;
  ui._repaintRafId = requestAnimationFrame(() => {
    ui._repaintRafId = null;
    if (!ui.term) return;
    ui.webglAddon?.clearTextureAtlas?.();
    ui.term.refresh(0, ui.term.rows - 1);
  });
}
