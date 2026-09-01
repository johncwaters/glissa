import { EventEmitter } from 'node:events';

import { NOTIFICATION_STATES as NS, NOTIFICATION_TRANSITIONS } from '../shared/notification-states.ts';
import type { NotificationState } from '../shared/notification-states.ts';

// What every channel receives alongside the message: the round counter, when it was built, and the
// ladder's last-rung marker the off-dashboard channels read.
export interface NotificationContext {
  escalationCount: number;
  timestamp: number;
  phoneEscalation?: boolean;
}

export type NotificationChannelFn = (
  sessionName: string,
  category: string,
  message: string,
  context: NotificationContext,
) => unknown;

interface RegisteredChannel {
  name: string;
  fn: NotificationChannelFn;
  offDashboard: boolean;
  canEscalate: () => boolean;
}

interface NotificationEntry {
  state: NotificationState;
  category: string | null;
  message: string | null;
  timer: NodeJS.Timeout | null;
  escalationCount: number;
  phoneTimer: NodeJS.Timeout | null;
  phoneEscalated: boolean;
}

export interface NotificationManagerOptions {
  escalationIntervalMs?: number;
  debounceMs?: number;
  phoneEscalationMs?: number;
}

class NotificationManager extends EventEmitter {
  _entries: Map<string, NotificationEntry>;
  _channels: RegisteredChannel[];
  _focusSuppressed: boolean;
  _escalationIntervalMs: number;
  _debounceMs: number;
  _phoneEscalationMs: number;
  _recentCategories: Map<string, number>;

  /**
   * `phoneEscalationMs` is how long an unacknowledged notification waits before the
   * ladder's last rung fires to the off-dashboard channels.
   */
  constructor({ escalationIntervalMs = 300000, debounceMs = 3000, phoneEscalationMs = 300000 }: NotificationManagerOptions = {}) {
    super();
    this._entries = new Map();         // sessionName -> { state, category, message, timer }
    this._channels = [];
    this._focusSuppressed = false;
    this._escalationIntervalMs = escalationIntervalMs;
    this._debounceMs = debounceMs;
    // How long an unacknowledged notification waits before the ladder's last rung: the off-dashboard
    // channels, ignoring their usual nobody-is-watching gate.
    this._phoneEscalationMs = phoneEscalationMs;
    this._recentCategories = new Map(); // `${session}\0${category}` -> lastFireTimestamp (per-session)
  }

  // -- Public API --

  getNotificationState(sessionName: string): NotificationState {
    const entry = this._entries.get(sessionName);
    return entry ? entry.state : NS.IDLE;
  }

  /**
   * `offDashboard` marks a channel that reaches the operator when no dashboard would.
   *   Only these carry the ladder's last rung, so a phone escalation does not re-toast a browser that
   *   already showed the notification once and was ignored.
   * `canEscalate` says whether this channel WOULD deliver an escalation right
   *   now, read live. The Telegram channel is registered unconditionally and decides per delivery, so
   *   without this the ladder armed a five-minute timer per notification on installs that have
   *   Telegram switched off or never configured - a timer that can only ever fire into a channel that
   *   drops it.
   */
  registerChannel(
    name: string,
    fn: NotificationChannelFn,
    { offDashboard = false, canEscalate = () => true }: { offDashboard?: boolean; canEscalate?: () => boolean } = {},
  ): void {
    this._channels.push({ name, fn, offDashboard, canEscalate });
  }

  setFocusSuppressed(val: unknown): void {
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

  trigger(sessionName: string, category: string, message: string): boolean {
    this._ensureEntry(sessionName);
    const entry = this._entries.get(sessionName);
    if (!entry) return false;
    // Validate BEFORE mutating: a trigger the state machine rejects must not corrupt a
    // live entry (e.g. relabel a running 'waiting' escalation with the new category).
    const stateTransitions = NOTIFICATION_TRANSITIONS[entry.state];
    if (!stateTransitions || !('trigger' in stateTransitions)) return false;
    entry.category = category;
    entry.message = message;
    entry.escalationCount = 0;
    return this._transition(sessionName, 'trigger');
  }

  acknowledge(sessionName: string): void {
    const entry = this._entries.get(sessionName);
    if (!entry || entry.state === NS.IDLE) return;
    this._transition(sessionName, 'acknowledge');
  }

  updateSettings({ escalationIntervalMs, debounceMs, phoneEscalationMs }: NotificationManagerOptions): void {
    if (escalationIntervalMs != null) this._escalationIntervalMs = escalationIntervalMs;
    if (debounceMs != null) this._debounceMs = debounceMs;
    if (phoneEscalationMs != null) this._phoneEscalationMs = phoneEscalationMs;
  }

  destroy(): void {
    for (const [, entry] of this._entries) {
      this._clearTimer(entry);
      this._clearPhoneTimer(entry);
    }
    this._entries.clear();
    this._recentCategories.clear();
    this._channels = [];
    this.removeAllListeners();
  }

  // -- State machine core --

  _ensureEntry(sessionName: string): void {
    if (!this._entries.has(sessionName)) {
      this._entries.set(sessionName, {
        state: NS.IDLE,
        category: null,
        message: null,
        timer: null,
        escalationCount: 0,
        // The ladder's last rung, armed on first delivery and latched once fired: an unacknowledged
        // notification reaches the phone ONCE, not every escalation round.
        phoneTimer: null,
        phoneEscalated: false,
      });
    }
  }

  _transition(sessionName: string, event: string): boolean {
    const entry = this._entries.get(sessionName);
    if (!entry) return false;

    const stateTransitions = NOTIFICATION_TRANSITIONS[entry.state];
    if (!stateTransitions || !(event in stateTransitions)) {
      return false;
    }

    const from = entry.state;
    const to = stateTransitions[event];
    if (!to) return false;

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

  _entryHook(sessionName: string, entry: NotificationEntry, state: NotificationState): void {
    switch (state) {
      case NS.PENDING:
        // A fresh trigger REPLACES a live entry, so the previous entry's phone rung must not fire
        // against the new one: it re-arms below on delivery.
        this._clearPhoneTimer(entry);
        entry.phoneEscalated = false;
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
          this._armEscalation(sessionName, entry);
        }
        this._armPhoneEscalation(sessionName, entry);
        break;

      case NS.ESCALATED:
        // Re-deliver via all channels
        entry.escalationCount++;
        this._deliverViaChannels(sessionName, entry);
        // Schedule next tick to ping-pong back to DELIVERED
        this._armEscalation(sessionName, entry);
        break;

      case NS.ESCALATED_PHONE:
        /*
         * The ladder's last rung. OFF-DASHBOARD channels only, and they are told to ignore their
         * nobody-is-watching gate: the operator had a browser notification and did not act on it, so
         * a dashboard being open somewhere is precisely what this rung disbelieves. Re-toasting the
         * browser here would only repeat what was already ignored.
         */
        entry.phoneEscalated = true;
        this._deliverViaChannels(sessionName, entry, { phoneEscalation: true }, (channel) => channel.offDashboard);
        // A 'waiting' entry returns to its browser ping-pong: being reached on the phone does not end
        // an escalation that exists because the agent is still blocked.
        if (entry.category === 'waiting') {
          this._armEscalation(sessionName, entry);
        }
        break;

      case NS.ACKNOWLEDGED:
        // Clear all timers, then auto-reset to IDLE
        this._clearTimer(entry);
        this._clearPhoneTimer(entry);
        this._transition(sessionName, 'reset');
        break;

      case NS.IDLE:
        // Cleanup: remove entry from tracking map if coming from ACKNOWLEDGED
        this._clearTimer(entry);
        this._clearPhoneTimer(entry);
        this._entries.delete(sessionName);
        break;
    }
  }

  _armEscalation(sessionName: string, entry: NotificationEntry): void {
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this._transition(sessionName, 'escalation_tick');
    }, this._escalationIntervalMs);
  }

  /*
   * Armed on the FIRST delivery of an entry and latched once fired, so an operator who never
   * acknowledges gets one phone ping per notification rather than one per escalation round. It
   * deliberately survives the DELIVERED/ESCALATED ping-pong (a 'waiting' entry crosses that boundary
   * repeatedly and the rung is about the ENTRY, not the round), which is why it is cleared only on a
   * fresh trigger, an acknowledgement, or teardown.
   */
  _armPhoneEscalation(sessionName: string, entry: NotificationEntry): void {
    if (entry.phoneEscalated) return;
    if (entry.phoneTimer !== null) return;
    if (!(this._phoneEscalationMs > 0)) return;
    // Not just "an off-dashboard channel exists" but "one would actually deliver", read live: the
    // Telegram channel is registered unconditionally and gates per delivery, so an install with it
    // switched off would otherwise arm a timer per notification for a channel that drops every one.
    if (!this._channels.some((channel) => channel.offDashboard && channel.canEscalate())) return;
    entry.phoneTimer = setTimeout(() => {
      entry.phoneTimer = null;
      this._transition(sessionName, 'phone_escalation');
    }, this._phoneEscalationMs);
    // unref'd: a pending escalation is advisory, and it must never be the reason the process stays
    // alive for five minutes after everything else has shut down.
    if (typeof entry.phoneTimer.unref === 'function') entry.phoneTimer.unref();
  }

  _exitHook(_sessionName: string, entry: NotificationEntry, state: NotificationState): void {
    // Belt and suspenders: clear timer on exit from DELIVERED, ESCALATED or ESCALATED_PHONE. The
    // phone timer is deliberately NOT cleared here: it spans the whole entry, across every round of
    // the DELIVERED/ESCALATED ping-pong.
    if (state === NS.DELIVERED || state === NS.ESCALATED || state === NS.ESCALATED_PHONE) {
      this._clearTimer(entry);
    }
  }

  // -- Channel delivery --

  _deliverViaChannels(
    sessionName: string,
    entry: NotificationEntry,
    extraContext: { phoneEscalation?: boolean } | null = null,
    channelFilter: ((channel: RegisteredChannel) => boolean) | null = null,
  ): void {
    const { category, message } = entry;
    if (category === null || message === null) return; // only reachable before a trigger set them
    const context = {
      escalationCount: entry.escalationCount,
      timestamp: Date.now(),
      ...(extraContext || {}),
    };
    for (const channel of this._channels) {
      if (channelFilter && !channelFilter(channel)) continue;
      try {
        channel.fn(sessionName, category, message, context);
      } catch (err) {
        console.warn(`[channel:${channel.name}] delivery failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // -- Debounce (per-session + category, so one session's rapid re-fire is coalesced without
  //    cross-suppressing a different session that hits the same category within the window) --

  _isDebounced(sessionName: string, category: string | null): boolean {
    if (!category) return false;
    const now = Date.now();
    const lastFired = this._recentCategories.get(`${sessionName}\0${category}`);
    return lastFired !== undefined && (now - lastFired) < this._debounceMs;
  }

  _recordCategory(sessionName: string, category: string | null): void {
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

  _clearTimer(entry: NotificationEntry): void {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  _clearPhoneTimer(entry: NotificationEntry): void {
    if (entry.phoneTimer != null) {
      clearTimeout(entry.phoneTimer);
      entry.phoneTimer = null;
    }
  }
}

export { NotificationManager };
