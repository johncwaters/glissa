import type { FitAddon } from '@xterm/addon-fit';
import type { WebglAddon } from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';
import type { DeliveredPack } from './pack-stale-core.ts';

export type SessionCardElement = HTMLDivElement & { _cardHostClass?: string };

export interface SessionUi {
  term: Terminal | null;
  fitAddon: FitAddon | null;
  webglAddon: WebglAddon | null;
  needsWebGLReload: boolean;
  dataWs: WebSocket | null;
  card: SessionCardElement;
  nameEl: HTMLSpanElement;
  elapsedEl: HTMLSpanElement;
  path: string;
  stateSince: number;
  btnOverflow: HTMLButtonElement;
  overflowMenu: HTMLDivElement;
  termWrap: HTMLDivElement;
  btnDebug: HTMLButtonElement;
  btnRename: HTMLButtonElement;
  btnRestart: HTMLButtonElement;
  btnRestartFresh: HTMLButtonElement;
  btnResume: HTMLButtonElement;
  btnRemove: HTMLButtonElement;
  debugOverlay: HTMLDivElement | null;
  debugOpen: boolean;
  abortController: AbortController;
  currentState: string;
  effectiveBase?: string;
  activeAgents?: number;
  packs?: DeliveredPack[];
  resizeObserver?: ResizeObserver;

  renameTargetEl?: HTMLElement | null;

  _activity?: 'active' | 'quiet' | undefined;
  _activityGate?: number;
  _lastOutputAt?: number;

  _dataWsRetryAttempt?: number;
  _inputQueue?: string[];
  _repaintRafId?: number | null;
  _applyFit?: (options?: { repaintRequested?: boolean }) => void;
  _resetResizeCache?: () => void;
  _unviewTerminal?: () => void;
  _resetSoftKeyboardBuffer?: () => void;
}

export const sessionUIs = new Map<string, SessionUi>();

export function sessionIdOf(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

export function findSessionUi(value: unknown): SessionUi | undefined {
  return typeof value === 'string' ? sessionUIs.get(value) : undefined;
}

export const container = document.getElementById('sessions-container');
export const aggregateEl = document.getElementById('aggregate-status');
