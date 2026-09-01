// Hook source - the AUTHORITATIVE status signal. Claude Code posts HTTP hooks
// (injected via --settings at spawn) to Glissa's localhost server. A single
// parameterized Express route `POST /hook/:glissaId/:event` dispatches here.
//
// The router is agent-NEUTRAL transport: the event vocabulary it translates with is the registered
// session's adapter hook profile (session/adapters/claude-code.js), moved out of here in M1 of
// docs/plan-agent-adapters.md. A registration that names none gets the Claude Code one.
//
// Security: localhost bind + origin guard are not enough (a local curl with no
// Origin passes the guard). Each session has an unguessable bearer token baked into
// the injected hook URLs; the router rejects any callback whose token does not match
// the live session's token. Trust level == "can read this session's settings file"
// == can read the PTY. See docs/postmortem-terminal-detection.md.

import claudeCode from '../session/adapters/claude-code.js';
import { HookEnvelope } from '../shared/contracts/index.ts';
import type { HookPayload } from '../shared/contracts/index.ts';

const { mapHookToSignal, mapHookConfidence, mapHookPromptKind } = claudeCode;

// Method shorthand on purpose: an adapter's hook profile is a plain JS object whose mappers are
// inferred, and bivariant parameter checking is what lets every adapter satisfy one type.
export interface HookProfile {
  mapSignal(event: string, payload: HookPayload): string | null;
  mapConfidence(event: string, payload: HookPayload): string | null;
  mapPromptKind(event: string, payload: HookPayload): string | null;
  mapPayload?(event: string, payload: HookPayload): HookPayload;
}

export interface HookSignal {
  signal: string;
  source: 'hook';
  confidence?: string;
  promptKind?: string;
  ts: number;
  event: string;
  payload: HookPayload;
}

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
  _sessions: Map<string, { token: string; onSignal: (signal: HookSignal) => void; hooks: HookProfile }>;

  constructor() {
    this._sessions = new Map(); // glissaId -> { token, onSignal, onEvent, hooks }
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

  // Handle one inbound hook callback. Returns { status, signal, reason }.
  // status: HTTP status to reply with. Never throws.
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
