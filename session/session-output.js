"use strict";

const { createOutputRing } = require("./core/output-ring.ts");
const { STATES, RESTARTABLE_STATES } = require("../shared/states.ts");

/** @type {Set<string>} */
const PASTE_READY_STATES = new Set([
  STATES.IDLE,
  STATES.RUNNING,
  STATES.WAITING,
  STATES.COMPLETE,
]);

/**
 * @typedef {object} SessionOutputOptions
 * @property {number} maxBytes
 * @property {() => typeof STATES[keyof typeof STATES]} getState
 * @property {() => boolean} isDestroyed
 * @property {() => boolean} hasLivePty
 * @property {(text: string) => void} write
 * @property {() => void} start
 * @property {() => void} restart
 * @property {SessionEventBinder} on
 * @property {SessionEventBinder} once
 * @property {SessionEventBinder} off
 */

/**
 * The two Session events this module binds. Spelled as an overload rather than `unknown[]`, so a
 * state-change listener keeps its payload type instead of re-asserting it.
 * @typedef {((event: 'state-change', listener: (change: { to: typeof STATES[keyof typeof STATES] }) => void) => void)
 *   & ((event: 'exit', listener: () => void) => void)} SessionEventBinder
 */

/** @param {SessionOutputOptions} options */
function createSessionOutput(options) {
  const ring = createOutputRing(options.maxBytes);
  /** @type {{ timer: NodeJS.Timeout, onStateChange: (change: { to: typeof STATES[keyof typeof STATES] }) => void, onExit: () => void } | null} */
  let pendingPaste = null;
  /** @type {number | null} */
  let lastCols = null;
  /** @type {number | null} */
  let lastRows = null;

  function clearPendingPaste() {
    if (!pendingPaste) return;
    const pending = pendingPaste;
    pendingPaste = null;
    clearTimeout(pending.timer);
    options.off("state-change", pending.onStateChange);
    options.off("exit", pending.onExit);
  }

  /** @param {string} text */
  function pasteText(text) {
    if (!options.hasLivePty()) return { ok: false, reason: "no-pty" };
    options.write(`\x1b[200~${text}\x1b[201~`);
    return { ok: true };
  }

  /** @param {string} text @param {{ timeoutMs?: number }} [pasteOptions] */
  function pasteTextWhenReady(text, { timeoutMs = 120000 } = {}) {
    if (options.isDestroyed()) return { ok: false, reason: "destroyed" };
    const stateBeforeWaiting = options.getState();
    if (options.hasLivePty() && PASTE_READY_STATES.has(stateBeforeWaiting)) return pasteText(text);
    clearPendingPaste();
    /** @param {{ to: typeof STATES[keyof typeof STATES] }} change */
    const onStateChange = ({ to }) => {
      if (!PASTE_READY_STATES.has(to)) return;
      clearPendingPaste();
      pasteText(text);
    };
    const onExit = () => clearPendingPaste();
    const timer = setTimeout(() => clearPendingPaste(), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    pendingPaste = { timer, onStateChange, onExit };
    options.on("state-change", onStateChange);
    options.once("exit", onExit);
    if (stateBeforeWaiting === STATES.DORMANT) options.start();
    if (RESTARTABLE_STATES.includes(stateBeforeWaiting)) options.restart();
    return { ok: true, deferred: true };
  }

  /** @param {number} cols @param {number} rows */
  function rememberSize(cols, rows) {
    const changed = lastCols !== cols || lastRows !== rows;
    lastCols = cols;
    lastRows = rows;
    return changed;
  }

  function spawnSize() {
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

module.exports = { createSessionOutput };
