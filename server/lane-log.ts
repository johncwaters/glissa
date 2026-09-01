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

function createLaneLog({ prefix = '', logger = console, debugFlag = false }: LaneLogOptions = {}): LaneLog {
  function note(message: string): void {
    if (!logger || typeof logger.log !== 'function') return;
    logger.log(`${prefix} ${message}`);
  }

  function warn(message: string): void {
    if (!logger || typeof logger.warn !== 'function') return;
    logger.warn(`${prefix} ${message}`);
  }

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
