<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-15 -->

# components/ — HTML Dialog Templates

## Purpose

Contains HTML template fragments loaded at build time via Vite's `?raw` import. Each file is the inner markup for a dialog, injected into a programmatically created overlay by `dialogs.js`.

## Key Files

| File | Description |
|------|-------------|
| `add-session-dialog.html` | Form markup for the Add Session dialog — name input, path picker/manual entry, repo root selector |
| `settings-dialog.html` | Form markup for the Settings dialog — timeout fields, theme picker, alert sound selector, repo root management |

## For AI Agents

### Working In This Directory

- These are **not standalone HTML pages** — they are fragments inserted into a dialog container by `dialogs.js`
- IDs in these templates (e.g., `#settings-theme`, `#settings-sound`) are queried by `dialogs.js` after injection
- Use semantic CSS classes from `style.css` (`dialog-label`, `dialog-input`, `dialog-field-error`, `dialog-hint`)
- Vite's `?raw` import returns the file contents as a string — no HTML parsing at build time

### Testing Requirements

Manual browser testing only. Open the relevant dialog and verify form layout, validation, and interaction.

## Dependencies

### Internal
- Consumed by `../dialogs.js` via `import settingsHTML from './components/settings-dialog.html?raw'`
- Styled by `../style.css` (dialog classes)

<!-- MANUAL: -->
