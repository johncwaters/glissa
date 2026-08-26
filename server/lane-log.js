/*
 * The one logger wrapper every lane and lane source uses. IO-adjacent rather than a pure core: it holds
 * no decisions, it only puts a lane's prefix on a line and decides whether a debug line is wanted.
 *
 * PRIVACY RULE for every line any caller logs, debug-gated or not: buffer content, terminal output,
 * command text and event summaries NEVER reach the log. Sizes, counts, uris, roots, verdicts and reasons
 * do. The ingest rings are bounded and their summaries are scrubbed at publish time; a log file is
 * neither, so a summary logged once outlives every bound the lane put on it.
 */

'use strict';

/**
 * `debugFlag` is a boolean or a getter, because debugMode is settable from the dashboard while a lane
 * is constructed once at boot. `debugNote` takes a THUNK, so a line that is not wanted costs no
 * interpolation on a path that runs at typing cadence.
 */
/**
 * @param {{ prefix?: string, logger?: Pick<Console, 'log' | 'warn'> | null,
 *   debugFlag?: boolean | (() => boolean) }} [options]
 */
function createLaneLog({ prefix = '', logger = console, debugFlag = false } = {}) {
  function note(message) {
    if (!logger || typeof logger.log !== 'function') return;
    logger.log(`${prefix} ${message}`);
  }

  function warn(message) {
    if (!logger || typeof logger.warn !== 'function') return;
    logger.warn(`${prefix} ${message}`);
  }

  // A getter that throws reads as debug off: a logging decision must never fault whatever it rode in on.
  function isDebug() {
    if (typeof debugFlag !== 'function') return debugFlag === true;
    try {
      return debugFlag() === true;
    } catch {
      return false;
    }
  }

  /** @param {() => string} buildMessage */
  function debugNote(buildMessage) {
    if (!isDebug()) return;
    note(buildMessage());
  }

  return { note, warn, debugNote };
}

module.exports = { createLaneLog };
