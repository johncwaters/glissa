<!-- Generated: 2026-07-03 -->

# notifications

## Purpose
The notification domain: the lifecycle state machine deciding when the operator is notified, and the delivery channel adapters.

## Key Files

| File | Description |
|------|-------------|
| `notification-manager.js` | Notification lifecycle state machine (states in `../shared/notification-states.js`); focus suppression defers, never drops |
| `channels/` | Delivery adapters: web-notification (primary, via control WS) and OS toast (opt-in fallback); see `channels/AGENTS.md` |

## For AI Agents
- The per-state notify decision lives in `../session/core/notify-gate.js`; the manager only owns entry lifecycle and timers.
- See root `AGENTS.md` ("Notifications (lifecycle + delivery)") for the delivery contract.
