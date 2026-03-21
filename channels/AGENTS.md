<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-21 -->

# channels/ — Notification Delivery Channels

## Purpose

Pluggable notification delivery adapters for `NotificationManager`. Each channel is a thin delivery pipe — it receives a notification and sends it via a specific transport. No debounce, suppression, or state logic; that lives in `notification-manager.js`.

## Key Files

| File | Description |
|------|-------------|
| `toast.js` | Windows toast notification channel via BurntToast PowerShell module with `msg *` fallback. Lazy-discovers BurntToast module path on first call. Exports `createToastChannel()` which returns the channel adapter function |

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
3. Register in `backend.js` via `notificationManager.registerChannel('<name>', channel)`

### Testing Requirements

No automated tests. Verify by triggering notifications via the dashboard (put a session into WAITING state) and checking that the channel fires.

## Dependencies

### Internal
- Consumed by `notification-manager.js` via `registerChannel()`

### External
- `child_process` (Node.js built-in) — `execFile`/`execFileSync` for PowerShell and msg.exe
- BurntToast PowerShell module (optional, runtime-detected)

<!-- MANUAL: -->
