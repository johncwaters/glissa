import { EventEmitter } from 'node:events';

import { NOTIFICATION_STATES as NS, NOTIFICATION_TRANSITIONS } from '../shared/notification-states.ts';
import type { NotificationState } from '../shared/notification-states.ts';

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

  constructor({ escalationIntervalMs = 300000, debounceMs = 3000, phoneEscalationMs = 300000 }: NotificationManagerOptions = {}) {
    super();
    this._entries = new Map();
    this._channels = [];
    this._focusSuppressed = false;
    this._escalationIntervalMs = escalationIntervalMs;
    this._debounceMs = debounceMs;
    this._phoneEscalationMs = phoneEscalationMs;
    this._recentCategories = new Map();
  }


  getNotificationState(sessionName: string): NotificationState {
    const entry = this._entries.get(sessionName);
    return entry ? entry.state : NS.IDLE;
  }

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


  _ensureEntry(sessionName: string): void {
    if (!this._entries.has(sessionName)) {
      this._entries.set(sessionName, {
        state: NS.IDLE,
        category: null,
        message: null,
        timer: null,
        escalationCount: 0,
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

    if (from === to) return true;

    this._exitHook(sessionName, entry, from);

    entry.state = to;

    this._entryHook(sessionName, entry, to);

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
        this._clearPhoneTimer(entry);
        entry.phoneEscalated = false;
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
        break;

      case NS.DELIVERED:
        if (entry.escalationCount === 0) {
          this._recordCategory(sessionName, entry.category);
        }
        this._deliverViaChannels(sessionName, entry);
        if (entry.category === 'waiting') {
          this._armEscalation(sessionName, entry);
        }
        this._armPhoneEscalation(sessionName, entry);
        break;

      case NS.ESCALATED:
        entry.escalationCount++;
        this._deliverViaChannels(sessionName, entry);
        this._armEscalation(sessionName, entry);
        break;

      case NS.ESCALATED_PHONE:
        entry.phoneEscalated = true;
        this._deliverViaChannels(sessionName, entry, { phoneEscalation: true }, (channel) => channel.offDashboard);
        if (entry.category === 'waiting') {
          this._armEscalation(sessionName, entry);
        }
        break;

      case NS.ACKNOWLEDGED:
        this._clearTimer(entry);
        this._clearPhoneTimer(entry);
        this._transition(sessionName, 'reset');
        break;

      case NS.IDLE:
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

  _armPhoneEscalation(sessionName: string, entry: NotificationEntry): void {
    if (entry.phoneEscalated) return;
    if (entry.phoneTimer !== null) return;
    if (!(this._phoneEscalationMs > 0)) return;
    if (!this._channels.some((channel) => channel.offDashboard && channel.canEscalate())) return;
    entry.phoneTimer = setTimeout(() => {
      entry.phoneTimer = null;
      this._transition(sessionName, 'phone_escalation');
    }, this._phoneEscalationMs);
    entry.phoneTimer.unref();
  }

  _exitHook(_sessionName: string, entry: NotificationEntry, state: NotificationState): void {
    if (state === NS.DELIVERED || state === NS.ESCALATED || state === NS.ESCALATED_PHONE) {
      this._clearTimer(entry);
    }
  }


  _deliverViaChannels(
    sessionName: string,
    entry: NotificationEntry,
    extraContext: { phoneEscalation?: boolean } | null = null,
    channelFilter: ((channel: RegisteredChannel) => boolean) | null = null,
  ): void {
    const { category, message } = entry;
    if (category === null || message === null) return;
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


  _isDebounced(sessionName: string, category: string | null): boolean {
    if (!category) return false;
    const now = Date.now();
    const lastFired = this._recentCategories.get(`${sessionName}\0${category}`);
    return lastFired !== undefined && (now - lastFired) < this._debounceMs;
  }

  _recordCategory(sessionName: string, category: string | null): void {
    if (!category) return;
    const now = Date.now();
    for (const [key, ts] of this._recentCategories) {
      if (now - ts >= this._debounceMs) this._recentCategories.delete(key);
    }
    this._recentCategories.set(`${sessionName}\0${category}`, now);
  }


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
