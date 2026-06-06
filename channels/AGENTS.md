<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-21 -->

# channels/ — Notification Delivery Channels

## Purpose

Pluggable notification delivery adapters for `NotificationManager`. Each channel is a thin delivery pipe — it receives a notification and sends it via a specific transport. No debounce, suppression, or state logic; that lives in `notification-manager.js`.

## Key Files

| File | Description |
|------|-------------|
| `web-notification.js` | **Primary channel.** Broadcasts a `notify` control message over the existing control WebSocket; each dashboard client raises a native browser Notification (the browser routes it to the Windows Action Center). No external deps, no PowerShell, no install step. Exports `createWebNotificationChannel(broadcast)`. Registered by default in `backend.js`. |
| `toast.js` | **Opt-in fallback** (`config.osToast === true`, default off). Windows OS toast via the BurntToast PowerShell module with `msg *` fallback. Lazy-discovers BurntToast module path on first call. Unreliable across machines (depends on an unbundled PowerShell module + flaky `msg`), which is why it is no longer the default; kept for the edge case where no dashboard tab is open. Exports `createToastChannel()`. |

## For AI Agents

### Working In This Directory

- Channels follow a uniform signature: `(sessionName, category, message, context) => void`
- `context` contains `{ escalationCount, timestamp }`
- Channels must NOT throw — errors are caught by `NotificationManager._deliverViaChannels()`, but prefer internal try/catch for robustness
- Channel functions are stateless delivery pipes. All state management (debounce, suppression, escalation) belongs in `notification-manager.js`
- `toast.js` was extracted from the original `notify.js` (now deprecated) during the NotificationManager refactor

### Adding a New Channel

1. Create `channels/<name>.js` exporting a `create<Name>Channel()` factory
2. Factory returns a function matching `(sessionName, category, message, context) => void`
3. Register in `backend.js` via `notificationManager.registerChannel('<name>', channel)`. A channel that needs to reach the dashboard (rather than the OS) takes the control-WS `broadcast` function as a factory arg, like `web-notification.js`.

### Testing Requirements

No automated tests. Verify by triggering notifications via the dashboard (put a session into WAITING state) and checking that the channel fires.

## Dependencies

### Internal
- Consumed by `notification-manager.js` via `registerChannel()`

### External
- `web-notification.js`: none (server-side). Client side uses the browser Notifications API (`public/notifications.js`); localhost is a secure context, so no HTTPS is needed.
- `toast.js`: `child_process` (Node.js built-in) — `execFile`/`execFileSync` for PowerShell and msg.exe; BurntToast PowerShell module (optional, runtime-detected)

<!-- MANUAL: -->
