## Claude Code Session Manager — Glissa

---

### Glissa Backstory

Glissa's canonical role is tracking and interacting with Myr across Mirrodin. Memnarch orchestrates, Glissa watches and manages on the ground. That maps cleanly onto what this tool does: sitting between you (Memnarch) and the Myr sessions, keeping tabs on all of them.

`glissa` as a CLI command also just sounds good.

### What It Is

Glissa is a lightweight Node.js background process you start once. It spawns and owns all your Claude Code sessions, streams their output live to a browser dashboard at `localhost:3000`, and alerts you via Windows toast notifications when any session needs attention. Your VS Code windows stay open for editing. The terminals inside them are replaced by the manager.

---

### File Structure

```
claude-manager/
  server.js          # Express + WebSocket server, entry point
  sessions.js        # Process spawning, state machine, pattern detection
  notify.js          # Windows toast via PowerShell
  public/
    index.html       # Dashboard (single page)
    app.js           # WebSocket client + UI logic
    style.css        # Dashboard styling
  config.json        # Your projects + settings
  package.json
```

---

### Config

```json
{
  "port": 3000,
  "attentionTimeoutSeconds": 60,
  "waitingEscalationSeconds": 300,
  "startingWatchdogSeconds": 10,
  "projects": [
    { "name": "api-service", "path": "C:/dev/api-service" },
    { "name": "frontend",    "path": "C:/dev/frontend" },
    { "name": "infra",       "path": "C:/dev/infra" }
  ]
}
```

---

### Architecture & Data Flow

```
config.json
     ↓
server.js  ──spawns──▶  claude (api-service/)
     |      ──spawns──▶  claude (frontend/)
     |      ──spawns──▶  claude (infra/)
     |
     ├── stdout/stderr → sessions.js (pattern detection + state machine)
     ├── state changes → WebSocket broadcast → dashboard
     ├── WAITING state → notify.js → Windows toast
     |
     ▼
localhost:3000  (browser dashboard)
     ↓
user types response → WebSocket → server.js → stdin of that session
```

---

### Session State Machine

Every session has exactly one active state at all times. States own their behavior, define their valid transitions, and fire side effects on entry/exit. No state can be skipped. No implicit states.

#### The 7 States

**INITIALIZING** — Session object exists, process not yet spawned. Config validated, working directory confirmed.

- Entry: validate path exists, check `claude` is on PATH
- Exit: only when `process.spawn()` succeeds
- Renders: grey badge, "Preparing..."

**STARTING** — Process spawned, waiting for first stdout signal confirming Claude is alive.

- Entry: start 10s watchdog timer
- Exit triggers: first meaningful stdout → `RUNNING` / watchdog fires → `FAILED`
- Renders: animated pulse badge, "Starting..."

**RUNNING** — Claude is actively working, output is flowing. Nominal state.

- Entry: cancel watchdog timers, reset idle timer
- Exit triggers: prompt pattern detected → `WAITING` / silence > threshold → `IDLE` / exit code 0 → `DONE` / exit non-zero → `FAILED`
- Renders: green badge, "Running"

**WAITING** — Claude has paused and is asking for your input. Highest priority state.

- Entry: fire Windows toast, increment global alert counter, flash card border
- Exit triggers: user submits response → `RUNNING` / user clicks Skip → `RUNNING` / user clicks Kill → `FAILED` / escalation timer fires → stays `WAITING`, re-notifies
- Renders: amber badge, pulsing border, input box visible, "Needs Input"

**IDLE** — No output for longer than the configured threshold. Not necessarily bad, but flagged.

- Entry: log silence timestamp, show idle duration counter
- Exit triggers: new stdout → `RUNNING` / prompt detected → `WAITING` / exit code 0 → `DONE` / exit non-zero → `FAILED`
- Renders: yellow badge, ticking idle counter, "Quiet for 2m 14s"

**DONE** — Process exited cleanly with code 0. Terminal state until manually restarted.

- Entry: log completion timestamp, optional chime, decrement active count
- Exit triggers: only explicit Restart button → `INITIALIZING`
- Renders: blue badge, "Done", restart button visible

**FAILED** — Process exited non-zero, watchdog fired, or killed. Terminal state with diagnostics preserved.

- Entry: snapshot last 50 lines, log exit code, fire toast notification
- Exit triggers: only explicit Restart button → `INITIALIZING`
- Renders: red badge, "Failed (exit 2)", last error lines highlighted, restart button

---

#### Full Transition Table

```
FROM           EVENT                            TO
──────────────────────────────────────────────────────
INITIALIZING   spawn succeeds                   STARTING
INITIALIZING   path / binary invalid            FAILED

STARTING       first stdout received            RUNNING
STARTING       watchdog timeout (10s)           FAILED
STARTING       process exits                    FAILED

RUNNING        prompt pattern detected          WAITING
RUNNING        silence > threshold              IDLE
RUNNING        process exits code 0             DONE
RUNNING        process exits non-zero           FAILED

WAITING        user submits response            RUNNING
WAITING        user clicks Skip                 RUNNING
WAITING        user clicks Kill                 FAILED
WAITING        escalation timer fires           WAITING (re-notifies only)

IDLE           new stdout received              RUNNING
IDLE           prompt pattern detected          WAITING
IDLE           process exits code 0             DONE
IDLE           process exits non-zero           FAILED

DONE           user clicks Restart              INITIALIZING
FAILED         user clicks Restart              INITIALIZING
```

Any event that has no row for the current state is logged and dropped. No silent corruption.

---

#### Transition Guards

Before any transition executes, a guard runs to confirm it's actually valid:

```
canStart    → path exists on disk AND claude binary is on PATH
canRespond  → session's stdin is still writable
canRestart  → current state is DONE or FAILED
```

If a guard fails, the transition is rejected and the error is surfaced to the dashboard.

---

#### Entry / Exit Hooks

Side effects live exclusively in hooks, never inside transition logic. Keeps transitions pure.

```
WAITING.onEnter  → fire toast, start escalation timer, increment alert badge
WAITING.onExit   → cancel escalation timer, decrement alert badge
IDLE.onEnter     → start idle duration counter, log silence timestamp
IDLE.onExit      → stop idle duration counter
FAILED.onEnter   → snapshot last 50 lines, log exit code, fire toast
DONE.onEnter     → log completion time, optional chime
```

---

#### Prompt Pattern Detection (RUNNING → WAITING)

Applied in layers. Any match triggers `WAITING`.

**Layer 1 — Exact string matches** (fast, zero false positives)

```
"Do you want to proceed?"
"Allow this action?"
"Press Enter to confirm"
```

**Layer 2 — Regex patterns** (catches variations)

```
/\(y\/n\)/i
/\[yes\/no\]/i
/proceed\?/i
/allow .+ to .+\?/i
```

**Layer 3 — Structural heuristic** (catches novel prompts)
Output line ends with `?` or `:` and no new output arrives within 3 seconds. Catches prompts that don't match known patterns. False positives are acceptable — user hits Skip.

---

#### Session Audit Log

Every transition is appended to an in-memory log per session:

```
RUNNING  → WAITING  | trigger: pattern:y/n  | "Allow write to config.json? (y/n)"
WAITING  → RUNNING  | trigger: user_input   | response: "y"
RUNNING  → IDLE     | trigger: silence:60s  |
IDLE     → RUNNING  | trigger: stdout       | "Build complete."
```

Surfaced in the dashboard as a collapsible timeline per session. Tells you exactly what happened while you weren't watching.

---

### Dashboard UI

**Header (global)**
Derived from all session states combined, never stored independently:

```
any WAITING   →  🔴 "2 sessions need input"
any FAILED    →  ⚠️  "1 session failed"
all DONE      →  ✅  "All sessions complete"
otherwise     →  ●   "3 sessions running"
```

Browser tab title mirrors this: `(2) Claude Manager`

**Per-session card**

- Project name
- State badge with color and label
- Last ~10 lines of stdout, live-updating
- Idle duration counter (IDLE state only)
- Input box + Submit + Skip buttons (WAITING state only)
- Kill / Restart buttons
- Expandable full log
- Collapsible audit log timeline

---

### Notifications

`notify.js` fires when any session enters `WAITING` or `FAILED`:

```powershell
New-BurntToastNotification -Text "Claude Manager", "api-service needs your input"
```

Fallback to `msg * "api-service needs your input"` if BurntToast isn't installed. If a session stays in `WAITING` past the escalation threshold (default 300s), the toast re-fires.

---

### Build Order

Each step is independently testable before moving to the next.

1. **Spawn + pipe** — `server.js` launches one hardcoded session, stdout pipes to Node console. Proves process ownership works.
2. **State machine** — `sessions.js` wraps the process, pattern-matches output, tracks and logs all transitions.
3. **WebSocket broadcast** — state changes and stdout stream to the browser. Minimal `index.html` confirms it's working.
4. **Multi-session** — config-driven, all projects launch on startup.
5. **Dashboard UI** — cards, badges, live log, input box, audit timeline.
6. **Notifications** — `notify.js`, toast on `WAITING` and `FAILED`, tab title counter, escalation re-fire.

---

### What This Deliberately Excludes (v1)

- Persisting session history across restarts (in-memory only)
- Automatically approving any prompts (you always decide)
- Replacing VS Code for editing (it's purely a process + monitoring layer)
