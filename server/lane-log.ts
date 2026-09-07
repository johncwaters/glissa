type LaneLogger = Partial<Pick<Console, 'log' | 'warn'>>;
type LaneLogValue = string | number | boolean | null | undefined;
type LaneLogFields = Record<string, LaneLogValue>;

interface LaneLogOptions {
  prefix?: string;
  logger?: LaneLogger | null;
  debugFlag?: boolean | (() => boolean);
}

interface LaneLog {
  note(message: string, fields?: LaneLogFields): void;
  warn(message: string, fields?: LaneLogFields): void;
  warnOnce(key: string, message: string, fields?: LaneLogFields): void;
  debugNote(buildMessage: () => string, buildFields?: () => LaneLogFields): void;
}

const MAX_ONCE_KEYS = 256;

function renderFieldValue(value: Exclude<LaneLogValue, null | undefined>): string {
  if (typeof value !== 'string') return String(value);
  if (value !== '' && !/[ ="\u0000-\u001f\u007f]/.test(value)) return value;
  return JSON.stringify(value);
}

function renderLine(prefix: string, message: string, fields?: LaneLogFields): string {
  const renderedFields = Object.entries(fields ?? {})
    .flatMap(([key, value]) => {
      if (value === null || value === undefined) return [];
      return `${key}=${renderFieldValue(value)}`;
    });
  if (renderedFields.length === 0) return `${prefix} ${message}`;
  return `${prefix} ${message} ${renderedFields.join(' ')}`;
}

function createLaneLog({ prefix = '', logger = console, debugFlag = false }: LaneLogOptions = {}): LaneLog {
  const onceKeys = new Set<string>();

  function note(message: string, fields?: LaneLogFields): void {
    if (!logger || typeof logger.log !== 'function') return;
    logger.log(renderLine(prefix, message, fields));
  }

  function warn(message: string, fields?: LaneLogFields): void {
    if (!logger || typeof logger.warn !== 'function') return;
    logger.warn(renderLine(prefix, message, fields));
  }

  function warnOnce(key: string, message: string, fields?: LaneLogFields): void {
    if (onceKeys.has(key)) return;
    onceKeys.add(key);
    const [oldestKey] = onceKeys;
    if (onceKeys.size > MAX_ONCE_KEYS && oldestKey !== undefined) onceKeys.delete(oldestKey);
    warn(message, fields);
  }

  function isDebug(): boolean {
    if (typeof debugFlag !== 'function') return debugFlag === true;
    try {
      return debugFlag() === true;
    } catch {
      return false;
    }
  }

  function debugNote(buildMessage: () => string, buildFields?: () => LaneLogFields): void {
    if (!isDebug()) return;
    note(buildMessage(), buildFields?.());
  }

  return { note, warn, warnOnce, debugNote };
}

export { createLaneLog };
export type { LaneLog, LaneLogFields, LaneLogger, LaneLogOptions, LaneLogValue };
