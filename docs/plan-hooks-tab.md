# Plan: Hooks Tab

Status: shipped 2026-08-30.

## Why

Glissa already injects Claude Code hooks into every session it spawns: a per-session `--settings` file (`detection/settings-injector.js`) carrying HTTP hooks that POST to the status router, plus the rtk PreToolUse rewrite and the statusLine relay when those lanes are on. An operator who wants a hook of their own (lint after every edit, a desktop ping on Stop, a webhook on SessionEnd) had two choices, both bad:

- Put it in `~/.claude/settings.json`. It then fires in every Claude Code session on the machine, Glissa-spawned or not, and the dashboard has no idea it exists.
- Put it in a project's `.claude/settings.json`. It is committed with the repo, so it follows the code rather than the operator, and Codex trust bypass refuses to inject at all when such a file could contribute hooks (`session/session-hook-lifecycle.js` `findProjectAgentConfig`).

Neither says "this hook runs in the sessions Glissa manages", which is the scope an operator running a fleet from a dashboard actually wants. And nothing anywhere showed what Glissa itself was already injecting, so an operator debugging a slow turn could not see that four HTTP hooks were firing on it.

## What

A primary view, `Hooks`, between Visions and Settings in the header tab strip, and a `Hooks` destination in the phone More sheet. Three sections:

1. Totals. Yours / enabled / built in, with the one-line rule that matters: a change reaches a session at its next start or restart, Claude Code sessions only.
2. Your hooks. One row per record: name, `Event / matcher` chip, the command or URL, type, timeout and scope (all projects, or the named ones). An enable toggle, Edit and Delete per row; `+ New hook` opens the inline editor above the list.
3. Glissa's own hooks. Read-only: every event the status router subscribes to, the wakeup-tracking PostToolUse matcher, and the rtk PreToolUse entry when an rtk binary actually resolved. Derived from the same constants the injector uses, never a second list.

Rows group under an event heading (the chip then carries only the matcher), a filter box appears once there are four or more, and each row offers On, Edit, Duplicate, Delete and a Preview disclosure showing the exact settings entry the record becomes. The empty state is the template row (lint after edits, notify on Stop, guard destructive Bash, log every prompt): the recipes are the instructions, and the same row heads a new-hook form.

The editor is an inline form, not a modal (`DESIGN.md`: "Don't reach for a modal when an inline or progressive disclosure will do"). Name, event (picker built from the catalog the server sends, with each event's description as its tooltip), matcher (disabled with a note for events that take none, hinted with what it matches otherwise), type (command or HTTP), command or URL, timeout, project scope, enabled. Client-side `draftProblem` catches what it can before the round trip; the server's core is the validator of record and its message lands in the same error line.

Keyboard: `Esc` cancels (a dirty draft, a template or a duplicate asks first), `Ctrl+Enter` saves, focus returns to `+ New hook` on close.

Phone: the same DOM re-parented into the More sheet's Hooks screen (`public/phone/phone-shell.js`), styled under `[data-layout="phone"]` only: stacked fields, 16px inputs so iOS does not zoom, 44px targets, a full-width action strip per row, the save bar sticky above the nav with safe-area padding, commands wrapping instead of truncating. Verified in headless Firefox with `ui.primaryPointerCapabilities` set coarse so `decideLayout` picks the phone layout.

## Shape

| Piece | Where | Role |
|---|---|---|
| Record + catalog + rules | `session/core/user-hooks-core.js` | Pure. `HOOK_EVENT_CATALOG` (event, what its matcher matches, description), `normalizeHook`, `readStoredHooks`, `upsertHook`, `removeHook`, `hooksForProject`, `appendUserHooks` |
| Persistence | `config.json` `hooks: UserHook[]` | Zod shape `UserHook` in `shared/contracts/hooks.js`; hidden from the Settings projection (`HIDDEN_CONFIG_KEYS`) because the Hooks tab is its surface |
| Wire | `shared/contracts/control-messages.js` | Client `request-hooks-report`, `save-hook`, `delete-hook`; server `hooks-report`, `save-hook-result`, `delete-hook-result`, broadcast `hooks-updated` |
| Handlers | `server/control-handlers.js` | Report assembles records, catalog, built-in rows and projects; save mints the id, validates, writes through `configStore.save` and reloads like a hand edit; delete drops the key when none remain |
| Live config | `server/config-store.js` `applySettings` | Copies `hooks` (absent means empty) so the next spawn reads the saved list |
| Spawn | `server/session-factory.js` -> `session/sessions.js` -> `session/session-hook-lifecycle.js` -> `detection/settings-injector.js` | `getUserHooks()` is a function read at every inject, so an edit reaches a live session's next restart without recreating it; `appendUserHooks` lands the entries after Glissa's own |
| Browser | `public/hooks-view-core.mjs` + `public/hooks-panel.js` | Pure strings, ordering, draft rules; DOM shell in the house pull-surface shape (Mill) |

## Decisions

- Command and HTTP only. Claude Code also accepts `prompt` and `agent` hook types and per-hook conditions; those stay a hand edit. The tab covers the two kinds an operator reaches for from a dashboard, and a smaller record is a smaller validator.
- Appended, never merged. Operator entries go after Glissa's under the same event so a status callback cannot be displaced, and a session with no hooks writes a byte-identical settings file (pinned).
- Scope is a project list, empty meaning every project. Per-project files were the thing being avoided; a list on the record keeps one home for the rule and lets a hook follow the operator, not the repo.
- Applies on next start. Claude Code reads its settings at launch, so nothing is pasted into a live PTY; the tab says so in one line rather than pretending otherwise.
- Claude Code only. Codex and Grok inject through argv or a home hooks file and have no per-session settings file to append to; the report's project list carries each project's agent so a scoped hook on a Codex project can be shown for what it is.
- Pull surface. Like Mill: the report is fetched when the tab is looked at and after each write, and `hooks-updated` only says "fetch again", so two open dashboards converge without either trusting the other's copy.

## Tests

`tests/user-hooks-core.test.js`, `tests/settings-injector-user-hooks.test.js`, `tests/control-hooks.test.js`, `tests/frontend-hooks-view.test.js`, plus the contract pins in `tests/contracts-control-messages.test.js` and `tests/contracts-config.test.js`.
