# Glissa

Spawn and manage Claude Code sessions with a browser dashboard. Real-time terminal output via xterm.js, WebSocket streaming, and Windows toast notifications.

## Quick Start

```bash
npm install
npm run build
npm start
```

Open `http://localhost:3000` to view the dashboard.

## Development

```bash
npm start          # Express server on port 3000
npm run dev        # Vite dev server on port 5173 (HMR, proxies to Express)
npm run build      # Production build to dist/
```

For development, run both `npm start` and `npm run dev` in separate terminals. The Vite dev server proxies API and WebSocket connections to Express.

## Architecture

- **Server:** Node.js + Express + WebSocket (`ws`), CommonJS
- **Terminal:** `node-pty` spawns Claude Code with real PTY support
- **Frontend:** ES modules bundled by Vite, xterm.js for terminal rendering
- **Styling:** Tailwind CSS v4 (utilities) + vanilla CSS (state-driven rules, animations)

### WebSocket Channels

| Channel | Path | Purpose |
|---------|------|---------|
| Control | `/control` | JSON messages: state changes, snapshots, commands |
| Data | `/terminals/:name` | Raw PTY bytes, bidirectional |

### Session States

```
INITIALIZING -> STARTING -> RUNNING -> WAITING -> IDLE -> DONE
                                                       -> FAILED
```

## Configuration

Edit `config.json`:

```json
{
  "port": 3000,
  "projects": [
    { "name": "my-project", "path": "C:\\path\\to\\project" }
  ],
  "repoRoots": ["C:\\path\\to\\repos"],
  "attentionTimeoutSeconds": 60,
  "waitingEscalationSeconds": 300,
  "startingWatchdogSeconds": 30
}
```

Settings can also be changed from the dashboard via the Settings button.

## Requirements

- Node.js >= 18
- Windows 11 (uses Windows toast notifications)
- Visual Studio Build Tools (for `node-pty` native compilation)
