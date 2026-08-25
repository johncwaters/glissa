'use strict';

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

const claudeCode = require('../session/adapters/claude-code');

const { mapHookToSignal, mapHookConfidence, mapHookPromptKind } = claudeCode;

class HookRouter {
  constructor() {
    this._sessions = new Map(); // glissaId -> { token, onSignal, hooks }
  }

  register(glissaId, { token, onSignal, hooks = claudeCode.hooks }) {
    if (!glissaId || !token || typeof onSignal !== 'function') {
      throw new Error('HookRouter.register requires glissaId, token, onSignal');
    }
    this._sessions.set(glissaId, { token, onSignal, hooks });
  }

  unregister(glissaId) {
    this._sessions.delete(glissaId);
  }

  // Handle one inbound hook callback. Returns { status, signal, reason }.
  // status: HTTP status to reply with. Never throws.
  handle({ glissaId, event, token, payload }) {
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
      console.warn(`[hook-source] onSignal threw for ${glissaId}: ${err.message}`);
    }
    return { status: 200, signal, reason: 'ok' };
  }
}

module.exports = { HookRouter, mapHookToSignal, mapHookConfidence, mapHookPromptKind };
