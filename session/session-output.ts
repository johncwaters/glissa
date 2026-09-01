import { createOutputRing } from "./core/output-ring.ts";
import type { OutputRingSlice, OutputRingStats } from "./core/output-ring.ts";
import { STATES, RESTARTABLE_STATES } from "../shared/states.ts";
import type { SessionState } from "../shared/states.ts";

const PASTE_READY_STATES: Set<SessionState> = new Set([
  STATES.IDLE,
  STATES.RUNNING,
  STATES.WAITING,
  STATES.COMPLETE,
]);

interface StateChange {
  to: SessionState;
}

/**
 * The two Session events this module binds. Spelled as an overload rather than `unknown[]`, so a
 * state-change listener keeps its payload type instead of re-asserting it.
 */
interface SessionEventBinder {
  (event: "state-change", listener: (change: StateChange) => void): void;
  (event: "exit", listener: () => void): void;
}

interface SessionOutputOptions {
  maxBytes: number;
  getState: () => SessionState;
  isDestroyed: () => boolean;
  hasLivePty: () => boolean;
  write: (text: string) => void;
  start: () => void;
  restart: () => void;
  on: SessionEventBinder;
  once: SessionEventBinder;
  off: SessionEventBinder;
}

// An alias, not an interface: the worktree lifecycle's paste port takes an indexable result.
type PasteResult = {
  ok: boolean;
  reason?: string;
  deferred?: boolean;
};

interface SessionOutput {
  push(chunk: string): void;
  replay(): string;
  since(offset: number): OutputRingSlice;
  reset(): void;
  setMax(bytes: number): void;
  stats(): OutputRingStats;
  pasteText(text: string): PasteResult;
  pasteTextWhenReady(text: string, options?: { timeoutMs?: number }): PasteResult;
  clearPendingPaste(): void;
  rememberSize(cols: number, rows: number): boolean;
  spawnSize(): { cols: number; rows: number };
}

function createSessionOutput(options: SessionOutputOptions): SessionOutput {
  const ring = createOutputRing(options.maxBytes);
  let pendingPaste: {
    timer: NodeJS.Timeout;
    onStateChange: (change: StateChange) => void;
    onExit: () => void;
  } | null = null;
  let lastCols: number | null = null;
  let lastRows: number | null = null;

  function clearPendingPaste(): void {
    if (!pendingPaste) return;
    const pending = pendingPaste;
    pendingPaste = null;
    clearTimeout(pending.timer);
    options.off("state-change", pending.onStateChange);
    options.off("exit", pending.onExit);
  }

  function pasteText(text: string): PasteResult {
    if (!options.hasLivePty()) return { ok: false, reason: "no-pty" };
    options.write(`\x1b[200~${text}\x1b[201~`);
    return { ok: true };
  }

  function pasteTextWhenReady(text: string, { timeoutMs = 120000 }: { timeoutMs?: number } = {}): PasteResult {
    if (options.isDestroyed()) return { ok: false, reason: "destroyed" };
    const stateBeforeWaiting = options.getState();
    if (options.hasLivePty() && PASTE_READY_STATES.has(stateBeforeWaiting)) return pasteText(text);
    clearPendingPaste();
    const onStateChange = ({ to }: StateChange): void => {
      if (!PASTE_READY_STATES.has(to)) return;
      clearPendingPaste();
      pasteText(text);
    };
    const onExit = (): void => clearPendingPaste();
    const timer = setTimeout(() => clearPendingPaste(), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    pendingPaste = { timer, onStateChange, onExit };
    options.on("state-change", onStateChange);
    options.once("exit", onExit);
    if (stateBeforeWaiting === STATES.DORMANT) options.start();
    if (RESTARTABLE_STATES.includes(stateBeforeWaiting)) options.restart();
    return { ok: true, deferred: true };
  }

  function rememberSize(cols: number, rows: number): boolean {
    const changed = lastCols !== cols || lastRows !== rows;
    lastCols = cols;
    lastRows = rows;
    return changed;
  }

  function spawnSize(): { cols: number; rows: number } {
    return { cols: lastCols ?? 80, rows: lastRows ?? 24 };
  }

  return {
    push: (chunk) => ring.push(chunk),
    replay: () => ring.replay(),
    since: (offset) => ring.since(offset),
    reset: () => ring.reset(),
    setMax: (bytes) => ring.setMax(bytes),
    stats: () => ring.stats(),
    pasteText,
    pasteTextWhenReady,
    clearPendingPaste,
    rememberSize,
    spawnSize,
  };
}

export { createSessionOutput };
export type { SessionOutput, SessionOutputOptions, SessionEventBinder, PasteResult };
