/*
 * The one logger wrapper every lane and lane source uses. IO-adjacent rather than a pure core: it holds
 * no decisions, it only puts a lane's prefix on a line and decides whether a debug line is wanted.
 *
 * PRIVACY RULE for every line any caller logs, debug-gated or not: buffer content, terminal output,
 * command text and event summaries NEVER reach the log. Sizes, counts, uris, roots, verdicts and reasons
 * do. The ingest rings are bounded and their summaries are scrubbed at publish time; a log file is
 * neither, so a summary logged once outlives every bound the lane put on it.
 */

// Partial by type as well as by guard: a caller wiring only one channel is supported, not a mistake.
type LaneLogger = Partial<Pick<Console, 'log' | 'warn'>>;

interface LaneLogOptions {
  prefix?: string;
  logger?: LaneLogger | null;
  debugFlag?: boolean | (() => boolean);
}

interface LaneLog {
  note(message: string): void;
  warn(message: string): void;
  debugNote(buildMessage: () => string): void;
}

/**
 * `debugFlag` is a boolean or a getter, because debugMode is settable from the dashboard while a lane
 * is constructed once at boot. `debugNote` takes a THUNK, so a line that is not wanted costs no
 * interpolation on a path that runs at typing cadence.
 */
function createLaneLog({ prefix = '', logger = console, debugFlag = false }: LaneLogOptions = {}): LaneLog {
  function note(message: string): void {
    if (!logger || typeof logger.log !== 'function') return;
    logger.log(`${prefix} ${message}`);
  }

  function warn(message: string): void {
    if (!logger || typeof logger.warn !== 'function') return;
    logger.warn(`${prefix} ${message}`);
  }

  // A getter that throws reads as debug off: a logging decision must never fault whatever it rode in on.
  function isDebug(): boolean {
    if (typeof debugFlag !== 'function') return debugFlag === true;
    try {
      return debugFlag() === true;
    } catch {
      return false;
    }
  }

  function debugNote(buildMessage: () => string): void {
    if (!isDebug()) return;
    note(buildMessage());
  }

  return { note, warn, debugNote };
}

export { createLaneLog };
export type { LaneLog, LaneLogger, LaneLogOptions };
