<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# components

## Purpose
Static HTML fragments imported by `dialogs.ts` via Vite's `?raw` suffix and injected into dialog shells at runtime.

## Key Files

| File | Description |
|------|-------------|
| `add-session-dialog.html` | Add Session dialog markup |

## For AI Agents

### Working In This Directory
- These are fragments, not documents: no `<html>`/`<head>`. Tailwind utilities plus semantic classes from `style.css`.
- Element ids/classes here are queried by `dialogs.ts`; change both sides together.

### Testing Requirements
- Open the dialogs under `npm run dev`.

## Dependencies

### Internal
- `../dialogs.ts` - the only importer

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
