'use strict';

const { EventEmitter } = require('node:events');
const { NOTIFICATION_STATES: NS, NOTIFICATION_TRANSITIONS } = require('./shared/notification-states');

class NotificationManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} opts.escalationIntervalMs - Re-fire interval for WAITING notifications
   * @param {number} opts.debounceMs - Category debounce window
   */
  constructor({ escalationIntervalMs = 300000, debounceMs = 3000 } = {}) {
    super();
    this._entries = new Map();         // sessionName -> { state, category, message, timer }
    this._channels = [];               // [{ name, fn }]
    this._focusSuppressed = false;
    this._escalationIntervalMs = escalationIntervalMs;
    this._debounceMs = debounceMs;
    this._recentCategories = new Map(); // `${session}\0${category}` -> lastFireTimestamp (per-session)
  }

  // -- Public API --

  getNotificationState(sessionName) {
    const entry = this._entries.get(sessionName);
    return entry ? entry.state : NS.IDLE;
  }

  registerChannel(name, fn) {
    this._channels.push({ name, fn });
  }

  setFocusSuppressed(val) {
    const was = this._focusSuppressed;
    this._focusSuppressed = !!val;
    // Focus suppression DEFERS, it does not drop: on blur, every held notification
    // re-runs the deliver decision. Snapshot first - transitions mutate the map.
    if (was && !this._focusSuppressed) {
      for (const name of [...this._entries.keys()]) {
        const entry = this._entries.get(name);
        if (entry && entry.state === NS.SUPPRESSED) this._transition(name, 'unsuppress');
      }
    }
  }

  trigger(sessionName, category, message) {
    this._ensureEntry(sessionName);
    const entry = this._entries.get(sessionName);
    // Validate BEFORE mutating: a trigger the state machine rejects must not corrupt a
    // live entry (e.g. relabel a running 'waiting' escalation with the new category).
    const stateTransitions = NOTIFICATION_TRANSITIONS[entry.state];
    if (!stateTransitions || !('trigger' in stateTransitions)) return false;
    entry.category = category;
    entry.message = message;
    entry.escalationCount = 0;
    return this._transition(sessionName, 'trigger');
  }

  acknowledge(sessionName) {
    const entry = this._entries.get(sessionName);
    if (!entry || entry.state === NS.IDLE) return;
    this._transition(sessionName, 'acknowledge');
  }

  updateSettings({ escalationIntervalMs, debounceMs }) {
    if (escalationIntervalMs != null) this._escalationIntervalMs = escalationIntervalMs;
    if (debounceMs != null) this._debounceMs = debounceMs;
  }

  destroy() {
    for (const [, entry] of this._entries) {
      this._clearTimer(entry);
    }
    this._entries.clear();
    this._recentCategories.clear();
    this._channels = [];
    this.removeAllListeners();
  }

  // -- State machine core --

  _ensureEntry(sessionName) {
    if (!this._entries.has(sessionName)) {
      this._entries.set(sessionName, {
        state: NS.IDLE,
        category: null,
        message: null,
        timer: null,
        escalationCount: 0,
      });
    }
  }

  _transition(sessionName, event) {
    const entry = this._entries.get(sessionName);
    if (!entry) return false;

    const stateTransitions = NOTIFICATION_TRANSITIONS[entry.state];
    if (!stateTransitions || !(event in stateTransitions)) {
      return false;
    }

    const from = entry.state;
    const to = stateTransitions[event];

    // Self-transition: record but skip hooks (matching sessions.js pattern)
    if (from === to) return true;

    // Exit hook
    this._exitHook(sessionName, entry, from);

    // Update state
    entry.state = to;

    // Entry hook
    this._entryHook(sessionName, entry, to);

    // Emit for future dashboard use
    this.emit('notification-state-change', {
      session: sessionName,
      from, to, event,
      category: entry.category,
    });

    return true;
  }

  _entryHook(sessionName, entry, state) {
    switch (state) {
      case NS.PENDING:
        // Transient decision state: check suppression, debounce, then deliver
        if (this._focusSuppressed) {
          this._transition(sessionName, 'suppressed');
          return;
        }
        if (this._isDebounced(sessionName, entry.category)) {
          this._transition(sessionName, 'debounced');
          return;
        }
        this._transition(sessionName, 'deliver');
        break;

      case NS.SUPPRESSED:
        // Parked until blur (unsuppress) or the session leaves the trigger state
        // (acknowledge). No timer: delivery decisions re-run through PENDING.
        break;

      case NS.DELIVERED:
        // Deliver via all channels (only record debounce on first delivery, not escalation re-entries)
        if (entry.escalationCount === 0) {
          this._recordCategory(sessionName, entry.category);
        }
        this._deliverViaChannels(sessionName, entry);
        // Start escalation timer ONLY for 'waiting' category
        if (entry.category === 'waiting') {
          entry.timer = setTimeout(() => {
            entry.timer = null;
            this._transition(sessionName, 'escalation_tick');
          }, this._escalationIntervalMs);
        }
        break;

      case NS.ESCALATED:
        // Re-deliver via all channels
        entry.escalationCount++;
        this._deliverViaChannels(sessionName, entry);
        // Schedule next tick to ping-pong back to DELIVERED
        entry.timer = setTimeout(() => {
          entry.timer = null;
          this._transition(sessionName, 'escalation_tick');
        }, this._escalationIntervalMs);
        break;

      case NS.ACKNOWLEDGED:
        // Clear all timers, then auto-reset to IDLE
        this._clearTimer(entry);
        this._transition(sessionName, 'reset');
        break;

      case NS.IDLE:
        // Cleanup: remove entry from tracking map if coming from ACKNOWLEDGED
        this._clearTimer(entry);
        this._entries.delete(sessionName);
        break;
    }
  }

  _exitHook(_sessionName, entry, state) {
    // Belt and suspenders: clear timer on exit from DELIVERED or ESCALATED
    if (state === NS.DELIVERED || state === NS.ESCALATED) {
      this._clearTimer(entry);
    }
  }

  // -- Channel delivery --

  _deliverViaChannels(sessionName, entry) {
    const context = {
      escalationCount: entry.escalationCount,
      timestamp: Date.now(),
    };
    for (const channel of this._channels) {
      try {
        channel.fn(sessionName, entry.category, entry.message, context);
      } catch (err) {
        console.warn(`[channel:${channel.name}] delivery failed: ${err.message}`);
      }
    }
  }

  // -- Debounce (per-session + category, so one session's rapid re-fire is coalesced without
  //    cross-suppressing a different session that hits the same category within the window) --

  _isDebounced(sessionName, category) {
    if (!category) return false;
    const now = Date.now();
    const lastFired = this._recentCategories.get(`${sessionName}\0${category}`);
    return lastFired && (now - lastFired) < this._debounceMs;
  }

  _recordCategory(sessionName, category) {
    if (!category) return;
    const now = Date.now();
    // Lazy sweep: entries older than the window can never debounce again; without
    // this the map grows one key per session+category forever.
    for (const [key, ts] of this._recentCategories) {
      if (now - ts >= this._debounceMs) this._recentCategories.delete(key);
    }
    this._recentCategories.set(`${sessionName}\0${category}`, now);
  }

  // -- Timer helpers --

  _clearTimer(entry) {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }
}

module.exports = { NotificationManager };
