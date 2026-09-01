// Shared-state owner for the session-card modules. This holds ONLY state that
// genuinely crosses module boundaries; cluster-local state stays in its own module.
//
// This module is the deepest dependency in the session-card graph: every feature
// module imports it, so ESM evaluates it first and the DOM singletons below are
// resolved before any card is created.

import type { FitAddon } from '@xterm/addon-fit';
import type { WebglAddon } from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';
import type { DeliveredPack } from './pack-stale-core.ts';

// The card element carries the host marker card-host.ts parks on it while a surface borrows the card.
export type SessionCardElement = HTMLDivElement & { _cardHostClass?: string };

// One entry per session card. The card's own DOM refs and lifecycle state are built by
// createSessionCard; the underscored members are parked here by the modules named beside them, which
// is what keeps a card's terminal, heartbeat and soft-keyboard state reachable from every surface.
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
  // The phone Terminal screen borrows the card without its header and parks its own name node here.
  renameTargetEl?: HTMLElement | null;
  // activity.ts
  _activity?: 'active' | 'quiet' | undefined;
  _activityGate?: number;
  _lastOutputAt?: number;
  // terminal.ts
  _dataWsRetryAttempt?: number;
  _inputQueue?: string[];
  _repaintRafId?: number | null;
  _applyFit?: (options?: { repaintRequested?: boolean }) => void;
  _resetResizeCache?: () => void;
  _unviewTerminal?: () => void;
  _resetSoftKeyboardBuffer?: () => void;
}

// Keyed by the stable session id (UUID). The Map reference is const; only its contents mutate.
export const sessionUIs = new Map<string, SessionUi>();

// Session ids reach the card modules straight off the control contract, which is passthrough, so every
// field of a delta reads as unknown. These two are the single place a wire id is reconciled with the
// registry's string key, rather than each caller asserting a shape the wire never guaranteed.
export function sessionIdOf(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

export function findSessionUi(value: unknown): SessionUi | undefined {
  return typeof value === 'string' ? sessionUIs.get(value) : undefined;
}

// Dashboard DOM singletons, resolved once at module-eval.
export const container = document.getElementById('sessions-container');
export const aggregateEl = document.getElementById('aggregate-status');
