<!-- Generated: 2026-07-03 -->

# notifications

## Purpose
The notification domain: the lifecycle state machine deciding when the operator is notified, and the delivery channel adapters.

## Key Files

| File | Description |
|------|-------------|
| `notification-manager.js` | Notification lifecycle state machine (states in `../shared/notification-states.ts`); focus suppression defers, never drops |
| `channels/` | Delivery adapters: web-notification (primary, via control WS) and OS toast (opt-in fallback); see `channels/AGENTS.md` |

## For AI Agents
- The per-state notify decision lives in `../session/core/notify-gate.js`; the manager only owns entry lifecycle and timers.
- See root `AGENTS.md` ("Notifications (lifecycle + delivery)") for the delivery contract.

## Invariants

Each entry is a rule, its why, and where it is pinned. Mechanism lives in the code.

### Notifications

- Acknowledge the old entry BEFORE deciding the new one, or a WAITING to COMPLETE hop lands on a live DELIVERED entry and delivers nothing.
- Terminal categories fire once per WORK CYCLE, started only by a USER-driven RUNNING entry, so a lead waking N times per prompt fires once. `user_kill` is always silent.
- Focus suppression DEFERS, never drops, and is PER-CONNECTION: a global rule was right with one device and wrong once a paired phone existed. Zero connections never suppresses.
- Telegram pings are durable, browser notifications are not (operator ruling): a lost phone ping is unacceptable, a duplicate is a shrug. It gates on ZERO open control connections, not focus, an unfocused tab being what a browser notification is for.
