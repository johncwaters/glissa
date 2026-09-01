import claudeCode from '../session/adapters/claude-code.ts';
import { HookEnvelope } from '../shared/contracts/index.ts';
import type { HookPayload } from '../shared/contracts/index.ts';

const { mapHookToSignal, mapHookConfidence, mapHookPromptKind } = claudeCode;

export interface HookProfile {
  mapSignal(event: string, payload?: HookPayload): string | null;
  mapConfidence(event: string, payload?: HookPayload): string | null;
  mapPromptKind(event: string, payload?: HookPayload): string | null;
  mapPayload?(event: string, payload: HookPayload): HookPayload;
}

export type HookSignal = {
  signal: string;
  source: 'hook';
  confidence?: string;
  promptKind?: string;
  ts: number;

  event?: string;
  payload?: HookPayload;
};

export interface HookRegistration {
  token: string;
  onSignal: (signal: HookSignal) => void;
  onEvent?: ((event: string, payload: Record<string, unknown>) => void) | null;
  hooks?: HookProfile;
}

export interface HookHandleResult {
  status: number;
  signal: string | null;
  reason: string;
}

class HookRouter {
  _sessions: Map<string, {
    token: string;
    onSignal: (signal: HookSignal) => void;
    onEvent: ((event: string, payload: Record<string, unknown>) => void) | null;
    hooks: HookProfile;
  }>;

  constructor() {
    this._sessions = new Map();
  }

  register(glissaId: string, { token, onSignal, onEvent = null, hooks = claudeCode.hooks }: HookRegistration): void {
    if (!glissaId || !token || typeof onSignal !== 'function') {
      throw new Error('HookRouter.register requires glissaId, token, onSignal');
    }
    this._sessions.set(glissaId, { token, onSignal, onEvent, hooks });
  }

  unregister(glissaId: string): void {
    this._sessions.delete(glissaId);
  }

  handle(envelope: unknown): HookHandleResult {
    const parsedEnvelope = HookEnvelope.safeParse(envelope);
    if (!parsedEnvelope.success) {
      console.warn(`[hook-source] Dropped invalid hook envelope: ${parsedEnvelope.error.issues[0]?.message || 'invalid payload'}`);
      return { status: 400, signal: null, reason: 'invalid-envelope' };
    }
    const { glissaId, event, token, payload } = parsedEnvelope.data;
    const entry = this._sessions.get(glissaId);
    if (!entry) {
      return { status: 404, signal: null, reason: 'unknown-session' };
    }
    if (!token || token !== entry.token) {
      return { status: 403, signal: null, reason: 'bad-token' };
    }
    const hooks = entry.hooks || claudeCode.hooks;
    const mappedPayload = typeof hooks.mapPayload === 'function'
      ? hooks.mapPayload(event, payload)
      : payload;
    const signal = hooks.mapSignal(event, mappedPayload);
    if (typeof entry.onEvent === 'function') {
      try {
        entry.onEvent(event, mappedPayload);
      } catch (err) {
        console.warn(`[hook-source] onEvent threw for ${glissaId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!signal) {
      return { status: 200, signal: null, reason: 'ignored-event' };
    }
    const confidence = hooks.mapConfidence(event, mappedPayload);
    const promptKind = signal === 'awaiting-input' ? hooks.mapPromptKind(event, mappedPayload) : null;
    try {
      entry.onSignal({
        signal, source: 'hook',
        ...(confidence ? { confidence } : {}),
        ...(promptKind ? { promptKind } : {}),
        ts: Date.now(), event, payload: mappedPayload,
      });
    } catch (err) {
      console.warn(`[hook-source] onSignal threw for ${glissaId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { status: 200, signal, reason: 'ok' };
  }
}

export { HookRouter, mapHookToSignal, mapHookConfidence, mapHookPromptKind };
