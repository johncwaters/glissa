
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


const INPUT_QUEUE_MAX = 1024;
const MOBILE_WIDTH_QUERY = '(max-width: 768px)';
const MOBILE_FONT_SIZE = 12;
const DESKTOP_FONT_SIZE = 14;

const TERMINAL_SCROLLBACK = 50000;
let _terminalCursorBlink = false;

export function setTerminalCursorBlink(v: boolean) {
  _terminalCursorBlink = v;
}


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


function connectDataWs(sessionId: string, ui: SessionUi, term: Terminal) {
  const url = buildWebSocketUrl(location, withPageToken(`/terminals/${encodeURIComponent(sessionId)}`));
  const ws = new WebSocket(url);
  ui.dataWs = ws;
  let hasEverOpened = false;

  renderScheduler.register(sessionId, (data, cb) => term.write(data, cb));

  ws.addEventListener('message', (event) => {
    noteSessionOutput(ui);
    renderScheduler.enqueue(sessionId, event.data);
  });

  ws.addEventListener('close', () => {
    if (ui.dataWs !== ws) return;
    renderScheduler.unregister(sessionId);
    ui.dataWs = null;
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
    term.reset();
    ui._resetResizeCache?.();
    ui._applyFit?.();

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
    ui.dataWs.close();
  }
}

export function sendTerminalInput(ui: SessionUi | null | undefined, data: string | null | undefined, options?: { fromSoftKeyboard?: boolean }) {
  if (!ui || data == null || data === '') return false;
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


function measureTerminalCell(fitAddon: FitAddon, term: Terminal) {
  if (fitAddon.proposeDimensions()) return true;
  term.resize(term.cols, term.rows);
  return !!fitAddon.proposeDimensions();
}

export function setupTerminal(termWrap: HTMLElement, ui: SessionUi) {
  const fontSize = window.matchMedia?.(MOBILE_WIDTH_QUERY).matches ? MOBILE_FONT_SIZE : DESKTOP_FONT_SIZE;
  const term = new Terminal({
    cursorBlink: _terminalCursorBlink,
    fontSize,
    fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', 'Menlo', monospace",
    theme: getTerminalTheme(),
    scrollback: TERMINAL_SCROLLBACK,
    allowProposedApi: true,
    linkHandler: osc8LinkHandler(),
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(termWrap);
  registerUrlLinkProvider(term);

  ui.term = term;
  ui.fitAddon = fitAddon;
  ui.webglAddon = null;
  ui.needsWebGLReload = false;

  let fitRafId: number | null = null;
  let lastSentCols = 0;
  let lastSentRows = 0;
  let lastFittedCols = 0;
  let lastFittedRows = 0;
  let hasClaimedViewerSize = false;
  function applyFit({ repaintRequested = false } = {}) {
    fitRafId = null;
    const liveFitAddon = ui.fitAddon;
    const liveTerm = ui.term;
    if (!liveFitAddon || !liveTerm) return;
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
  const resetResizeCache = () => { lastSentCols = 0; lastSentRows = 0; };
  ui._resetResizeCache = resetResizeCache;

  ui._unviewTerminal = () => {
    if (!hasClaimedViewerSize) return;
    hasClaimedViewerSize = false;
    resetResizeCache();
    if (ui.dataWs?.readyState !== WebSocket.OPEN) return;
    ui.dataWs.send(JSON.stringify({ type: 'unview' }));
  };

  const firstRender = term.onRender(() => {
    firstRender.dispose();
    applyFit();
  });

  tryLoadWebGL(ui);

  let scrollRafId: number | null = null;
  term.onScroll(() => {
    if (scrollRafId !== null) return;
    scrollRafId = requestAnimationFrame(() => {
      scrollRafId = null;
      if (!ui.term) return;
      ui.term.refresh(0, ui.term.rows - 1);
    });
  });

  term.parser.registerOscHandler(52, (data) => {
    const semi = data.indexOf(';');
    if (semi < 0) return true;
    const payload = data.slice(semi + 1);
    if (payload === '' || payload === '?') return true;
    let text: string;
    try {
      text = decodeOsc52Payload(payload);
    } catch (err) {
      reportClipboardFailure('osc52 decode', err);
      return true;
    }
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

  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
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
    if (ctrl && ev.key === 'Backspace') {
      sendTerminalInput(ui, '\x1b\x7f');
      return false;
    }
    return true;
  });

  wireSoftKeyboardInput(termWrap, term, ui);
  wireTouchScroll(termWrap, term);
}

function wireSoftKeyboardInput(termWrap: HTMLElement, term: Terminal, ui: SessionUi) {
  const textarea = term.textarea;
  if (!textarea) return;

  let alreadySentText = '';

  const isPhoneLayout = () => document.documentElement.dataset.layout === 'phone';
  const resyncBaseline = () => { alreadySentText = textarea.value; };

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
    term.scrollToBottom();
    return true;
  };

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
    sendTypedText();
    queueMicrotask(resetSoftKeyboardBuffer);
  });

  listenBeforeXterm('compositionstart', (event) => {
    event.stopPropagation();
  });

  listenBeforeXterm('compositionupdate', (event) => {
    event.stopPropagation();
  });

  listenBeforeXterm('compositionend', (event) => {
    event.stopPropagation();
    setTimeout(sendTypedText, 0);
  });

  listenBeforeXterm('input', (event) => {
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
  ui._inputQueue = [];

  const term = ui.term;
  if (!term) return;
  term.onData((data) => { sendTerminalInput(ui, data); });

  connectDataWs(sessionId, ui, term);
}

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
