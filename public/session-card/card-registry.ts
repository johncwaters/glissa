import type { FitAddon } from '@xterm/addon-fit';
import type { WebglAddon } from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';
import type { PlanReviewState } from '#shared/contracts/plan-review.ts';
import type { createPlanFace } from '../plan/plan-face.ts';
import type { SessionCardFace } from './face-core.ts';
import type { TerminalGrid } from './grid-core.ts';
import type { DeliveredPack } from './pack-stale-core.ts';

export type SessionCardElement = HTMLDivElement & { _cardHostClass?: string };

export type PlanFaceController = ReturnType<typeof createPlanFace>;

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
  btnTrace: HTMLButtonElement;
  btnPlan: HTMLButtonElement;
  btnOverflowPlan: HTMLButtonElement;
  btnRemove: HTMLButtonElement;
  debugOverlay: HTMLDivElement | null;
  debugOpen: boolean;
  abortController: AbortController;
  currentState: string;
  face: SessionCardFace;
  isBorrowed: boolean;
  hasPlan: boolean;
  pendingPromptKind: string | null;
  planReviewState: PlanReviewState;
  planFace: PlanFaceController;
  effectiveBase?: string;
  activeAgents?: number;
  packs?: DeliveredPack[];
  resizeObserver?: ResizeObserver;
  ptySize?: TerminalGrid | null;

  renameTargetEl?: HTMLElement | null;

  _activity?: 'active' | 'quiet' | undefined;
  _activityGate?: number;
  _lastOutputAt?: number;

  _dataWsRetryAttempt?: number;
  _inputQueue?: string[];
  _syncGrid?: (options?: { isActivationEdge?: boolean }) => void;
  _resetGridClaim?: () => void;
  _syncGridOnEngagementEdge?: () => void;
  _setActiveViewer?: (isActive: boolean) => void;
  _resetSoftKeyboardBuffer?: () => void;
  _ensureTerminalReady?: () => void;
  _setBorrowed?: (isBorrowed: boolean) => void;
  _showPreferredFace?: () => void;
  _showTerminalFace?: () => void;
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
