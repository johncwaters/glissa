// Per-card terminal: xterm.js setup (fit/ResizeObserver, WebGL, scroll redraw,
// OSC-52 clipboard, custom key handling), terminal I/O wiring, and the data
// WebSocket that streams PTY bytes. Cross-card lifecycle (create/remove) lives
// in lifecycle.js; this module owns a single card's terminal and its socket.

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { writeClipboardText } from '../dom-helpers.js';
import { isFocusAltShortcut } from '../focus-view/focus-shortcuts.mjs';
import { nextReconnectDelayMs } from '../reconnect-backoff.mjs';
import { renderScheduler } from '../render-scheduler.mjs';
import { getTerminalTheme } from '../theme.js';
import { buildWebSocketUrl } from '../ws-url-core.mjs';
import { noteSessionOutput } from './activity.js';
import { sessionUIs } from './card-registry.js';
import {
  bytesForBackwardDeletion,
  bytesForSoftKeyboardEdit,
  isImeProcessingKeydown,
  isTypedInputType,
} from './ime-core.mjs';
import { showErrorToast } from './toast.js';
import { wireTouchScroll } from './touch-scroll.js';
import { tryLoadWebGL } from './webgl-pool.js';

// ── Constants ────────────────────────────────────────────────

const INPUT_QUEUE_MAX = 1024;
// Phone-width terminals get a smaller cell so a usable column count fits in ~390px.
const MOBILE_WIDTH_QUERY = '(max-width: 768px)';
const MOBILE_FONT_SIZE = 12;
const DESKTOP_FONT_SIZE = 14;

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
  const url = buildWebSocketUrl(location, `/terminals/${encodeURIComponent(sessionId)}`);
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
    // Only act if this ws is still the active one: guards concurrent reconnect races
    // and suppresses stale timers when the card is rebuilt under the same id (e.g. restart).
    if (ui.dataWs === ws) {
      renderScheduler.unregister(sessionId);
      ui.dataWs = null;
      const retryDelayMs = nextReconnectDelayMs(ui._dataWsRetryAttempt || 0);
      ui._dataWsRetryAttempt = (ui._dataWsRetryAttempt || 0) + 1;
      setTimeout(() => {
        if (sessionUIs.get(sessionId) === ui) {
          connectDataWs(sessionId, ui, term);
        }
      }, retryDelayMs);
    }
  });

  ws.addEventListener('open', () => {
    ui._dataWsRetryAttempt = 0;
    // Full reset, not clear(), before the server's replay frame. The replay starts at whatever chunk
    // boundary the session ring still retains, so it can open mid-escape-sequence and it carries no
    // preamble re-establishing the emulator's modes. clear() keeps every one of them: a live parser
    // state, the alternate buffer, the scroll region, the SGR attributes and the application cursor
    // mode all survive it, so replaying into a terminal that was already inside Claude's alt-screen TUI
    // renders mush that only a page reload (a brand new Terminal) clears. reset() puts the emulator
    // back where a fresh one starts, which is the state the replay is implicitly written against.
    term.reset();
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

// THE write path into a session's PTY: send on the live data WS, or queue for the reconnect flush.
// Every producer (xterm onData, the Ctrl+Backspace key handler, the touch key strip) goes through
// here so a disconnected socket has one queueing rule instead of one per caller.
export function sendTerminalInput(ui, data, options) {
  if (!ui || data == null || data === '') return false;
  // Bytes from anywhere but the soft keyboard (the touch key strip, a paste, xterm's own key handling)
  // change the terminal's input line without touching the helper textarea the phone path diffs against,
  // so they invalidate that diff baseline.
  if (!options?.fromSoftKeyboard) ui._resetSoftKeyboardBuffer?.();
  if (ui.dataWs?.readyState === WebSocket.OPEN) {
    ui.dataWs.send(JSON.stringify({ type: 'input', data }));
    return true;
  }
  if (ui._inputQueue && ui._inputQueue.length < INPUT_QUEUE_MAX) {
    ui._inputQueue.push(data);
    return true;
  }
  return false;
}

// ── Terminal setup ───────────────────────────────────────────

export function setupTerminal(termWrap, ui) {
  // Cell size is chosen once, at construction: xterm re-measures its whole grid on a font change, so
  // a live switch would reflow every buffer mid-session. A window resized across the breakpoint
  // therefore keeps the size it was built with until the card is rebuilt.
  const fontSize = window.matchMedia?.(MOBILE_WIDTH_QUERY).matches ? MOBILE_FONT_SIZE : DESKTOP_FONT_SIZE;
  const term = new Terminal({
    cursorBlink: _terminalCursorBlink,
    fontSize,
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
  // Whether this card has told the server a size the PTY may still be wearing. A board-only phone or a
  // card that has never been visible has claimed nothing, so it has nothing to hand back.
  let hasClaimedViewerSize = false;
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
    hasClaimedViewerSize = true;
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

  // A session owns one PTY but any number of viewers (a second tab, a paired phone), and resize is
  // last-write-wins, so a phone opening a session reflows the desktop's terminal to phone width. The
  // desktop cannot notice: its own box never changed, so the cache above suppresses any re-send. The
  // viewer that STOPS looking therefore hands its claim back and the server re-applies the most recent
  // surviving viewer's size (server/core/viewer-size-core.js). The cache is dropped with it because
  // this card may become the visible viewer again at exactly the dimensions it just gave up, and the
  // fit that follows would otherwise early-return and leave the PTY at the other viewer's size.
  ui._unviewTerminal = () => {
    if (!hasClaimedViewerSize) return;
    hasClaimedViewerSize = false;
    ui._resetResizeCache();
    if (ui.dataWs?.readyState !== WebSocket.OPEN) return;
    ui.dataWs.send(JSON.stringify({ type: 'unview' }));
  };

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
    const write = writeClipboardText(text);
    if (!write) return true;
    write.catch((err) => {
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
      const write = writeClipboardText(selection);
      if (!write) return false;
      write.catch((err) => {
        reportClipboardFailure('copy', err);
      });
      return false;
    }
    if (ctrl && ev.key === 'v') {
      return false;
    }
    // Ctrl+Backspace: send ESC+DEL so readline/bash deletes the previous word
    if (ctrl && ev.key === 'Backspace') {
      sendTerminalInput(ui, '\x1b\x7f');
      return false;
    }
    return true;
  });

  wireSoftKeyboardInput(termWrap, term, ui);
  wireTouchScroll(termWrap, term);
}

// Predictive text, autocorrect and word deletion reach a phone keyboard's terminal through composition
// and input events that xterm 6.0.0 gets wrong: CompositionHelper._handleAnyTextareaChanges diffs the
// helper textarea with an unanchored String.replace (so a corrected word is appended to the one it
// replaced rather than replacing it) and collapses every shrink to a single DEL however many characters
// went away, while CoreBrowserTerminal._inputEvent forwards only inputType 'insertText' and so drops a
// suggestion pick outright. Upstream xtermjs/xterm.js#3600 is open and unowned. On the phone layout the
// text path therefore comes off xterm: these capture-phase listeners sit on an ancestor of the helper
// textarea, so they run before xterm's own listeners on the textarea itself and stopPropagation keeps
// the fragile path from ever seeing the event. The bytes come from diffing the textarea instead, which
// is read rather than cancelled because a beforeinput raised by autocorrect or an IME is allowed to be
// non-cancelable. Nothing is intercepted on desktop, where the same takeover would regress CJK
// composition (the regression that kept the equivalent upstream fix, xtermjs/xterm.js#4173, out).
function wireSoftKeyboardInput(termWrap, term, ui) {
  const textarea = term.textarea;
  if (!textarea) return;

  // The textarea holds what the soft keyboard has typed into the terminal's current input line, and
  // alreadySentText is the part of it the PTY has already been given. xterm blanks the textarea itself
  // on Enter and Ctrl+C, which is what keeps this bounded to one line.
  let alreadySentText = '';

  const isPhoneLayout = () => document.documentElement.dataset.layout === 'phone';
  const resyncBaseline = () => { alreadySentText = textarea.value; };

  // Reaching a blank slate needs the textarea blanked too, or the next diff measures against text the
  // terminal's line no longer holds. Never on desktop: xterm's CompositionHelper reads that value to
  // resolve a CJK composition.
  ui._resetSoftKeyboardBuffer = () => {
    alreadySentText = '';
    if (!isPhoneLayout()) return;
    if (textarea.value === '') return;
    textarea.value = '';
  };

  const sendTypedText = () => {
    const bytes = bytesForSoftKeyboardEdit(alreadySentText, textarea.value);
    alreadySentText = textarea.value;
    if (bytes === '') return false;
    sendTerminalInput(ui, bytes, { fromSoftKeyboard: true });
    // xterm's own scrollOnUserInput lives in the keydown handler this path bypasses.
    term.scrollToBottom();
    return true;
  };

  // Desktop never intercepts: every event only resyncs the diff baseline and passes through to xterm.
  const listenBeforeXterm = (type, handler) => {
    termWrap.addEventListener(type, (event) => {
      if (!isPhoneLayout()) {
        resyncBaseline();
        return;
      }
      handler(event);
    }, true);
  };

  listenBeforeXterm('keydown', (event) => {
    if (isImeProcessingKeydown(event)) {
      event.stopPropagation();
      return;
    }
    // A real key (Enter, Backspace, an arrow, a Ctrl combo) is xterm's to handle, but it edits the line
    // without editing the textarea, so any composed text still pending goes first and the baseline is
    // dropped after. The microtask runs once xterm's listener has had the event.
    sendTypedText();
    queueMicrotask(() => ui._resetSoftKeyboardBuffer());
  });

  listenBeforeXterm('compositionstart', (event) => {
    event.stopPropagation();
  });

  // The textarea is not updated yet when compositionupdate fires, so the value is read from the input
  // event that follows instead of from here.
  listenBeforeXterm('compositionupdate', (event) => {
    event.stopPropagation();
  });

  listenBeforeXterm('compositionend', (event) => {
    event.stopPropagation();
    // Engines disagree on whether the committed text lands before or after this event, so it is read
    // on the next task rather than here.
    setTimeout(sendTypedText, 0);
  });

  listenBeforeXterm('input', (event) => {
    // Text xterm's own paste handler already sent; the browser inserts a copy of it afterwards.
    if (!isTypedInputType(event.inputType)) {
      queueMicrotask(() => ui._resetSoftKeyboardBuffer());
      return;
    }
    event.stopPropagation();
    if (sendTypedText()) return;
    const deletion = bytesForBackwardDeletion(event.inputType);
    if (deletion === '') return;
    sendTerminalInput(ui, deletion, { fromSoftKeyboard: true });
    term.scrollToBottom();
  });
}

export function wireTerminalIO(ui, sessionId) {
  // Queue keystrokes during WebSocket disconnection for replay on reconnect
  ui._inputQueue = [];

  ui.term.onData((data) => { sendTerminalInput(ui, data); });

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
//
// `force` re-arms an already-pending repaint instead of collapsing into it. A caller that has just
// made the card visible and re-fitted it knows the pending repaint was armed against the PREVIOUS
// geometry, and the coalescing would otherwise silently drop the newer, better-informed request.
export function forceTerminalRepaint(ui, { force = false } = {}) {
  if (!ui) return;
  if (ui._repaintRafId != null) {
    if (!force) return;
    cancelAnimationFrame(ui._repaintRafId);
    ui._repaintRafId = null;
  }
  ui._repaintRafId = requestAnimationFrame(() => {
    ui._repaintRafId = null;
    if (!ui.term) return;
    ui.webglAddon?.clearTextureAtlas?.();
    ui.term.refresh(0, ui.term.rows - 1);
  });
}
