<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# channels

## Purpose
Notification delivery adapters consumed by `notification-manager.js`. Channels are dumb pipes: all debounce, suppression, and escalation logic lives in the NotificationManager, not here.

## Key Files

| File | Description |
|------|-------------|
| `web-notification.js` | PRIMARY channel: broadcasts a `notify` message over the control WebSocket; each connected browser raises a native Notification (routed to Windows Action Center by the browser) |
| `toast.js` | Opt-in fallback (`config.osToast`): Windows OS toast via BurntToast/`msg`; off by default because it is unreliable across machines |

## For AI Agents

### Working In This Directory
- Keep channels stateless delivery pipes. New suppression/dedup logic goes in `notification-manager.js`.
- A new channel should expose the same adapter shape the manager already consumes (see `web-notification.js`).
- `toast.js` shells out to PowerShell; escape single quotes (`escapeForPowerShell`) and never interpolate untrusted text unescaped.

### Testing Requirements
- `tests/notification-manager.test.js` covers the manager; channel changes are verified by triggering a notification in `npm run dev`.

## Dependencies

### Internal
- `../notification-manager.js` - the only consumer
- `../backend.js` - control-WS broadcast used by `web-notification.js`

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
