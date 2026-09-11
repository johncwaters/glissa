export const CARD_REGISTRY_URL = '/session-card/card-registry.ts';

export interface GridReading {
  cols: number;
  rows: number;
  ptySize: { cols: number; rows: number } | null;
  dataGrid: string | null;
  face: string | null;
  dataWsState: number | null;
  bufferLength: number;
  viewportY: number;
  lines: string[];
}

export interface LayoutReading {
  layout: string | null;
  keyboard: string | null;
  appReady: boolean;
}

export interface ReadGridRequest {
  sessionId: string;
  registryUrl: string;
}

interface ProbedBufferLine {
  translateToString(trimRight: boolean): string;
}

interface ProbedBuffer {
  length: number;
  viewportY: number;
  getLine(index: number): ProbedBufferLine | undefined;
}

interface ProbedTerminal {
  cols: number;
  rows: number;
  buffer: { active: ProbedBuffer };
}

interface ProbedSessionUi {
  term?: ProbedTerminal | null;
  ptySize?: { cols: number; rows: number } | null;
  dataWs?: { readyState: number; close(): void } | null;
  card?: { dataset: { grid?: string; face?: string } } | null;
}

export async function readGrid({ sessionId, registryUrl }: ReadGridRequest): Promise<GridReading | null> {
  const imported: unknown = await import(registryUrl);
  if (typeof imported !== 'object' || imported === null) return null;
  const registryModule = imported as { sessionUIs?: unknown };
  const sessionUIs = registryModule.sessionUIs;
  if (!(sessionUIs instanceof Map)) return null;
  const found: unknown = sessionUIs.get(sessionId);
  if (typeof found !== 'object' || found === null) return null;
  const sessionUi = found as ProbedSessionUi;
  const term = sessionUi.term;
  const card = sessionUi.card;
  if (!term || !card) return null;
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let offset = 0; offset < term.rows; offset += 1) {
    lines.push(buffer.getLine(buffer.viewportY + offset)?.translateToString(true) ?? '');
  }
  return {
    cols: term.cols,
    rows: term.rows,
    ptySize: sessionUi.ptySize ?? null,
    dataGrid: card.dataset.grid ?? null,
    face: card.dataset.face ?? null,
    dataWsState: sessionUi.dataWs ? sessionUi.dataWs.readyState : null,
    bufferLength: buffer.length,
    viewportY: buffer.viewportY,
    lines,
  };
}

export async function dropDataSocket({ sessionId, registryUrl }: ReadGridRequest): Promise<boolean> {
  const imported: unknown = await import(registryUrl);
  if (typeof imported !== 'object' || imported === null) return false;
  const registryModule = imported as { sessionUIs?: unknown };
  const sessionUIs = registryModule.sessionUIs;
  if (!(sessionUIs instanceof Map)) return false;
  const found: unknown = sessionUIs.get(sessionId);
  if (typeof found !== 'object' || found === null) return false;
  const sessionUi = found as ProbedSessionUi;
  const socket = sessionUi.dataWs;
  if (!socket) return false;
  socket.close();
  return true;
}

export function readLayout(): LayoutReading {
  const shell = document.querySelector('#phone-shell');
  return {
    layout: document.documentElement.dataset.layout ?? null,
    keyboard: shell ? shell.getAttribute('data-keyboard') : null,
    appReady: document.body.classList.contains('app-ready'),
  };
}

export function boardRowIds(): string[] {
  const found: string[] = [];
  for (const element of document.querySelectorAll('button.phone-row')) {
    const value = element.getAttribute('data-id');
    if (value) found.push(value);
  }
  return found;
}

export function pillIds(): string[] {
  const found: string[] = [];
  for (const element of document.querySelectorAll('button.focus-pill')) {
    const value = element.getAttribute('data-id');
    if (value) found.push(value);
  }
  return found;
}
