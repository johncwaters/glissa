
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
import type { DataFrameState, TerminalGrid } from './grid-core.ts';
import { decideGridActions, isFollowingGrid, readDataFrame } from './grid-core.ts';
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
const GRID_SETTLE_MS = 250;
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
  ws.binaryType = 'arraybuffer';
  ui.dataWs = ws;
  let hasEverOpened = false;
  const frameState: DataFrameState = { hasSeenSize: false, lastSeq: 0 };

  renderScheduler.register(sessionId, (data, cb) => term.write(data, cb));

  ws.addEventListener('message', (event) => {
    const frame = readDataFrame(event.data, frameState);
    if (frame.kind === 'bytes') {
      noteSessionOutput(ui);
      renderScheduler.enqueue(sessionId, frame.data);
      return;
    }
    if (frame.kind === 'attach-size') {
      frameState.hasSeenSize = true;
      frameState.lastSeq = frame.seq;
      term.reset();
      ui.ptySize = { cols: frame.cols, rows: frame.rows };
      ui._syncGrid?.();
      return;
    }
    if (frame.kind !== 'size') return;
    frameState.lastSeq = frame.seq;
    const nextSize = { cols: frame.cols, rows: frame.rows };
    renderScheduler.enqueueAction(sessionId, () => {
      ui.ptySize = nextSize;
      ui._syncGrid?.();
    });
  });

  ws.addEventListener('close', () => {
    if (ui.dataWs !== ws) return;
    renderScheduler.unregister(sessionId);
    ui.dataWs = null;
    ui._resetGridClaim?.();
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

  let gridRafId: number | null = null;
  let settleTimerId: ReturnType<typeof setTimeout> | null = null;
  let isActiveViewer = false;
  let lastClaim: TerminalGrid | null = null;

  function cancelSettle() {
    if (settleTimerId === null) return;
    clearTimeout(settleTimerId);
    settleTimerId = null;
  }

  function measureProposal(): TerminalGrid | null {
    if (!isActiveViewer) return null;
    const liveFitAddon = ui.fitAddon;
    if (!liveFitAddon) return null;
    const proposed = liveFitAddon.proposeDimensions();
    if (!proposed) return null;
    return { cols: proposed.cols, rows: proposed.rows };
  }

  function sendGridClaim(grid: TerminalGrid) {
    if (ui.dataWs?.readyState !== WebSocket.OPEN) return;
    ui.dataWs.send(JSON.stringify({ type: 'claim', cols: grid.cols, rows: grid.rows }));
    lastClaim = grid;
    const following = isFollowingGrid({ authoritative: ui.ptySize ?? null, isActiveViewer, lastClaim });
    ui.card.dataset.grid = following ? 'following' : 'exact';
  }

  function syncGrid({ isActivationEdge = false }: { isActivationEdge?: boolean } = {}) {
    const liveTerm = ui.term;
    if (!liveTerm) return;
    const actions = decideGridActions({
      authoritative: ui.ptySize ?? null,
      applied: { cols: liveTerm.cols, rows: liveTerm.rows },
      proposal: measureProposal(),
      isActiveViewer,
      isDataWsOpen: ui.dataWs?.readyState === WebSocket.OPEN,
      lastClaim,
    });
    if (actions.resizeTo) liveTerm.resize(actions.resizeTo.cols, actions.resizeTo.rows);
    ui.card.dataset.grid = actions.isFollowing ? 'following' : 'exact';
    cancelSettle();
    if (actions.sendUnview) {
      lastClaim = null;
      ui.dataWs?.send(JSON.stringify({ type: 'unview' }));
    }
    if (!actions.claim) return;
    if (isActivationEdge) {
      sendGridClaim(actions.claim);
      return;
    }
    const settling = actions.claim;
    settleTimerId = setTimeout(() => {
      settleTimerId = null;
      sendGridClaim(settling);
    }, GRID_SETTLE_MS);
  }

  const resizeObserver = new ResizeObserver(() => {
    if (gridRafId !== null) return;
    gridRafId = requestAnimationFrame(() => {
      gridRafId = null;
      syncGrid();
    });
  });
  resizeObserver.observe(termWrap);
  ui.resizeObserver = resizeObserver;
  ui._syncGrid = syncGrid;
  ui._resetGridClaim = () => {
    cancelSettle();
    lastClaim = null;
  };
  ui._setActiveViewer = (isActive: boolean) => {
    if (isActiveViewer === isActive) return;
    isActiveViewer = isActive;
    cancelSettle();
    if (isActive) reacquireWebglIfEvicted(ui);
    syncGrid({ isActivationEdge: true });
  };

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

export function ensureTerminalReady(ui: SessionUi | null | undefined, sessionId: string) {
  if (!ui) return;
  ensureTerminalSetup(ui, sessionId);
  reacquireWebglIfEvicted(ui);
  const term = ui.term;
  if (!term) return;
  term.refresh(0, term.rows - 1);
}

export function setTerminalActiveViewer(ui: SessionUi | null | undefined, sessionId: string, isActive: boolean) {
  if (!ui) return;
  if (isActive) ensureTerminalSetup(ui, sessionId);
  ui._setActiveViewer?.(isActive);
}
