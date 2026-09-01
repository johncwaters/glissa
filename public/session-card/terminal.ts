// Per-card terminal: xterm.js setup (fit/ResizeObserver, WebGL, scroll redraw,
// OSC-52 clipboard, custom key handling), terminal I/O wiring, and the data
// WebSocket that streams PTY bytes. Cross-card lifecycle (create/remove) lives
// in lifecycle.js; this module owns a single card's terminal and its socket.

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type { SessionUi } from './card-registry.ts';
import { writeClipboardText } from '../dom-helpers.ts';
import { isFocusAltShortcut } from '../focus-view/focus-shortcuts.ts';
import { nextReconnectDelayMs } from '../reconnect-backoff.ts';
import { renderScheduler } from '../render-scheduler.ts';
import { getTerminalTheme } from '../theme.ts';
import { buildWebSocketUrl } from '../ws-url-core.ts';
import { clearPageToken, loadPageToken, withPageToken } from '../ws-token.ts';
import { noteSessionOutput } from './activity.ts';
import { findSessionUi, sessionUIs } from './card-registry.ts';
import { decideFitAction } from './fit-core.ts';
import {
  bytesForBackwardDeletion,
  bytesForSoftKeyboardEdit,
  isImeProcessingKeydown,
  isTypedInputType,
} from './ime-core.ts';
import { osc8LinkHandler, registerUrlLinkProvider } from './terminal-links.ts';
import { showErrorToast } from './toast.ts';
import { wireTouchScroll } from './touch-scroll.ts';
import { reacquireWebglIfEvicted, tryLoadWebGL } from './webgl-pool.ts';

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

export function setTerminalCursorBlink(v: boolean) {
  _terminalCursorBlink = v;
}

// ── OSC 52 clipboard ─────────────────────────────────────────

// atob returns a binary string; walk the bytes through TextDecoder so
// non-ASCII payloads survive the OSC 52 round-trip.
function decodeOsc52Payload(b64: string) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function reportClipboardFailure(source: string, err: unknown) {
  const msg = (err instanceof Error ? err.message : '') || String(err);
  console.error(`[clipboard:${source}]`, err);
  showErrorToast(`Clipboard ${source} failed: ${msg}`);
}

// ── Data WebSocket ───────────────────────────────────────────

function connectDataWs(sessionId: string, ui: SessionUi, term: Terminal) {
  // The data socket carries the same page token as the control socket; by the time a card exists the
  // control socket has already delivered a snapshot, so the token is always loaded here.
  const url = buildWebSocketUrl(location, withPageToken(`/terminals/${encodeURIComponent(sessionId)}`));
  const ws = new WebSocket(url);
  ui.dataWs = ws;
  let hasEverOpened = false;

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
    if (ui.dataWs !== ws) return;
    renderScheduler.unregister(sessionId);
    ui.dataWs = null;
    // Never-opened socket was refused by a new per-process token from server restart; clear cache to refetch.
    if (!hasEverOpened) clearPageToken();
    const retryDelayMs = nextReconnectDelayMs(ui._dataWsRetryAttempt || 0);
    ui._dataWsRetryAttempt = (ui._dataWsRetryAttempt || 0) + 1;
    setTimeout(() => {
      if (sessionUIs.get(sessionId) !== ui) return;
      void loadPageToken().catch(() => {}).then(() => {
        if (sessionUIs.get(sessionId) !== ui) return;
        connectDataWs(sessionId, ui, term);
      });
    }, retryDelayMs);
  });

  ws.addEventListener('open', () => {
    hasEverOpened = true;
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
    const queued = ui._inputQueue;
    if (queued && queued.length > 0) {
      setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        for (const data of queued) {
          ws.send(JSON.stringify({ type: 'input', data }));
        }
        queued.length = 0;
      }, 50);
    }
  });
}

export function reconnectDataWs(id: unknown) {
  const ui = findSessionUi(id);
  if (ui?.dataWs) {
    ui.dataWs.close(); // close triggers auto-reconnect via the close handler
  }
}

// THE write path into a session's PTY: send on the live data WS, or queue for the reconnect flush.
// Every producer (xterm onData, the Ctrl+Backspace key handler, the touch key strip) goes through
// here so a disconnected socket has one queueing rule instead of one per caller.
export function sendTerminalInput(ui: SessionUi | null | undefined, data: string | null | undefined, options?: { fromSoftKeyboard?: boolean }) {
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

// Same-size term.resize is xterm 6.0.0's public re-measure trigger; its own IntersectionObserver would
// only re-measure a hidden-built card a frame after it becomes visible, one frame too late for this fit.
function measureTerminalCell(fitAddon: FitAddon, term: Terminal) {
  if (fitAddon.proposeDimensions()) return true;
  term.resize(term.cols, term.rows);
  return !!fitAddon.proposeDimensions();
}

export function setupTerminal(termWrap: HTMLElement, ui: SessionUi) {
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
    // OSC 8 hyperlinks open on the VIEWING device (xterm's default is a
    // confirm() prompt; without any handler nothing opens on a paired phone).
    linkHandler: osc8LinkHandler(),
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(termWrap);
  // Plain-text URLs in Claude output are not links until a provider says so.
  registerUrlLinkProvider(term);

  ui.term = term;
  ui.fitAddon = fitAddon;
  ui.webglAddon = null;
  ui.needsWebGLReload = false;

  // This is the only geometry path: visible fit, browser repaint, then PTY resize.
  let fitRafId: number | null = null;
  let lastSentCols = 0;
  let lastSentRows = 0;
  let lastFittedCols = 0;
  let lastFittedRows = 0;
  // Whether this card has told the server a size the PTY may still be wearing. A board-only phone or a
  // card that has never been visible has claimed nothing, so it has nothing to hand back.
  let hasClaimedViewerSize = false;
  function applyFit({ repaintRequested = false } = {}) {
    fitRafId = null;
    const liveFitAddon = ui.fitAddon;
    const liveTerm = ui.term;
    if (!liveFitAddon || !liveTerm) return;
    // Skip fit when the card is off-screen (it lives in the hidden grid home until Focus borrows it
    // into the center); fitting a display:none card computes garbage dims. It gets a fresh fit on borrow.
    if (!ui.card.offsetParent) return;
    const measured = measureTerminalCell(liveFitAddon, liveTerm);
    if (measured) liveFitAddon.fit();
    const { cols, rows } = liveTerm;
    const action = decideFitAction({
      measured, cols, rows, lastFittedCols, lastFittedRows, lastSentCols, lastSentRows,
      repaintRequested,
    });
    if (action.repaint) {
      lastFittedCols = cols;
      lastFittedRows = rows;
      scheduleTerminalRepaint(ui);
    }
    if (!action.send) return;
    if (ui.dataWs?.readyState !== WebSocket.OPEN) return;
    ui.dataWs.send(JSON.stringify({ type: 'resize', cols, rows }));
    lastSentCols = cols;
    lastSentRows = rows;
    hasClaimedViewerSize = true;
  }
  const resizeObserver = new ResizeObserver(() => {
    if (fitRafId !== null) return;
    fitRafId = requestAnimationFrame(() => applyFit());
  });
  resizeObserver.observe(termWrap);
  ui.resizeObserver = resizeObserver;
  ui._applyFit = applyFit;
  // Reset the lastSent cache so the next _applyFit unconditionally pushes -
  // used on data-WS (re)connect, where the server-side PTY may have just
  // respawned and needs the current size even if the browser-side cols/rows
  // haven't changed.
  const resetResizeCache = () => { lastSentCols = 0; lastSentRows = 0; };
  ui._resetResizeCache = resetResizeCache;

  // A session owns one PTY but any number of viewers (a second tab, a paired phone), and resize is
  // last-write-wins, so a phone opening a session reflows the desktop's terminal to phone width. The
  // desktop cannot notice: its own box never changed, so the cache above suppresses any re-send. The
  // viewer that STOPS looking therefore hands its claim back and the server re-applies the most recent
  // surviving viewer's size (server/core/viewer-size-core.ts). The cache is dropped with it because
  // this card may become the visible viewer again at exactly the dimensions it just gave up, and the
  // fit that follows would otherwise early-return and leave the PTY at the other viewer's size.
  ui._unviewTerminal = () => {
    if (!hasClaimedViewerSize) return;
    hasClaimedViewerSize = false;
    resetResizeCache();
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
  let scrollRafId: number | null = null;
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
    let text: string;
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
function wireSoftKeyboardInput(termWrap: HTMLElement, term: Terminal, ui: SessionUi) {
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
  const resetSoftKeyboardBuffer = () => {
    alreadySentText = '';
    if (!isPhoneLayout()) return;
    if (textarea.value === '') return;
    textarea.value = '';
  };
  ui._resetSoftKeyboardBuffer = resetSoftKeyboardBuffer;

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
  const listenBeforeXterm = <EventName extends keyof HTMLElementEventMap>(
    type: EventName,
    handler: (event: HTMLElementEventMap[EventName]) => void,
  ) => {
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
    queueMicrotask(resetSoftKeyboardBuffer);
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
      queueMicrotask(resetSoftKeyboardBuffer);
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

export function wireTerminalIO(ui: SessionUi, sessionId: string) {
  // Queue keystrokes during WebSocket disconnection for replay on reconnect
  ui._inputQueue = [];

  const term = ui.term;
  if (!term) return;
  term.onData((data) => { sendTerminalInput(ui, data); });

  connectDataWs(sessionId, ui, term);
}

// First-time terminal setup for cards that started life as DORMANT.
export function ensureTerminalSetup(ui: SessionUi, sessionId: string) {
  if (ui.term) return;
  setupTerminal(ui.termWrap, ui);
  wireTerminalIO(ui, sessionId);
}

export function activateTerminalViewer(ui: SessionUi | null | undefined, sessionId: string) {
  if (!ui) return;
  ensureTerminalSetup(ui, sessionId);
  reacquireWebglIfEvicted(ui);
  ui._applyFit?.({ repaintRequested: true });
}

function scheduleTerminalRepaint(ui: SessionUi | null | undefined) {
  if (!ui) return;
  if (ui._repaintRafId != null) {
    cancelAnimationFrame(ui._repaintRafId);
    ui._repaintRafId = null;
  }
  ui._repaintRafId = requestAnimationFrame(() => {
    ui._repaintRafId = null;
    if (!ui.term) return;
    ui.term.refresh(0, ui.term.rows - 1);
  });
}

export function cancelTerminalRepaint(ui: SessionUi | null | undefined) {
  if (ui?._repaintRafId == null) return;
  cancelAnimationFrame(ui._repaintRafId);
  ui._repaintRafId = null;
}
