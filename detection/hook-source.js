'use strict';

// Hook source - the AUTHORITATIVE status signal. Claude Code posts HTTP hooks
// (injected via --settings at spawn) to Glissa's localhost server. A single
// parameterized Express route `POST /hook/:glissaId/:event` dispatches here.
//
// Security: localhost bind + origin guard are not enough (a local curl with no
// Origin passes the guard). Each session has an unguessable bearer token baked into
// the injected hook URLs; the router rejects any callback whose token does not match
// the live session's token. Trust level == "can read this session's settings file"
// == can read the PTY. See docs/postmortem-terminal-detection.md.

// Map a Claude Code hook event (+ payload) to a normalized StatusSource signal.
// Returns null for events that should be ignored.
function mapHookToSignal(event, payload) {
  const e = String(event || '').toLowerCase();
  switch (e) {
    case 'sessionstart':
      return 'session-start';
    case 'sessionend':
      return 'session-end';
    case 'userpromptsubmit':
      return 'resume';
    case 'stop':
      // Main-agent turn end only. NOT SubagentStop: a sub-agent (Task tool)
      // finishing mid-turn must not mark the whole session COMPLETE. This `ready`
      // is gated downstream on the live background sub-agent count (see below).
      return 'ready';
    case 'subagentstart':
      // A background sub-agent (Task run_in_background / Ctrl+B) began. NOT a state
      // transition: tracked as a live-count delta so a later main-agent Stop fired while
      // it is still running does not falsely COMPLETE the card (see Session._trackSubagent
      // and the activeAgents gate in session-core/status-mapper.js).
      return 'subagent-start';
    case 'subagentstop':
      // A sub-agent finished. Drops the live count; never completes the session itself
      // (the main agent's own Stop does that, gated on the count).
      return 'subagent-stop';
    case 'permissionrequest':
      return 'awaiting-input';
    case 'posttooluse': {
      // Scheduled-revival bookkeeping (subscribed with a ScheduleWakeup|CronCreate|CronDelete
      // matcher; see settings-injector.WAKEUP_TOOL_MATCHER). Tracking-only signals, never
      // transitions (Session._trackWakeup). The tool_name switch is defense in depth: if a
      // Claude version ignores the matcher and floods every tool call, everything else maps
      // to null (ignored-event).
      const tool = String(payload && payload.tool_name || '');
      if (tool === 'ScheduleWakeup') return 'wakeup-scheduled';
      if (tool === 'CronCreate') return 'cron-created';
      if (tool === 'CronDelete') return 'cron-deleted';
      return null;
    }
    case 'notification': {
      // Only act on subtypes with a clear meaning; ignore the rest (e.g.
      // auth_success) rather than firing a false WAITING.
      const t = String(payload && (payload.notification_type || payload.notificationType) || '').toLowerCase();
      if (t === 'idle_prompt') return 'ready';
      if (t === 'permission_prompt' || t.startsWith('elicitation')) return 'awaiting-input';
      return null;
    }
    default:
      return null;
  }
}

class HookRouter {
  constructor() {
    this._sessions = new Map(); // glissaId -> { token, onSignal }
  }

  register(glissaId, { token, onSignal }) {
    if (!glissaId || !token || typeof onSignal !== 'function') {
      throw new Error('HookRouter.register requires glissaId, token, onSignal');
    }
    this._sessions.set(glissaId, { token, onSignal });
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
    const signal = mapHookToSignal(event, payload);
    if (!signal) {
      return { status: 200, signal: null, reason: 'ignored-event' };
    }
    try {
      entry.onSignal({ signal, source: 'hook', ts: Date.now(), event, payload });
    } catch (err) {
      console.warn(`[hook-source] onSignal threw for ${glissaId}: ${err.message}`);
    }
    return { status: 200, signal, reason: 'ok' };
  }
}

module.exports = { HookRouter, mapHookToSignal };
