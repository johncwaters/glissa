<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# components

## Purpose
Static HTML fragments for dialogs, imported by `dialogs.js` via Vite's `?raw` suffix and injected into dialog shells at runtime.

## Key Files

| File | Description |
|------|-------------|
| `add-session-dialog.html` | Add Session dialog markup |
| `settings-dialog.html` | Settings dialog markup (tabs: general, sounds, theme, shortcuts) |

## For AI Agents

### Working In This Directory
- These are fragments, not documents: no `<html>`/`<head>`. Tailwind utilities plus semantic classes from `style.css`.
- Element ids/classes here are queried by `dialogs.js`; change both sides together.
- Adding a shortcut row? The Shortcuts tab renders from `../shortcuts.mjs`, not from static markup here.

### Testing Requirements
- Open the dialogs under `npm run dev`.

## Dependencies

### Internal
- `../dialogs.js` - the only importer

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
