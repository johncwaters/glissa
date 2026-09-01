<!-- Parent: ../AGENTS.md -->

# vscode-visions

## Purpose
Minimal VS Code extension that launches the Glissa Visions markdown LSP relay.

## For AI Agents

### Working In This Directory
- `extension.ts` and `lsp-convert.ts` stay CommonJS-shaped (`require` at the top, `module.exports` at the bottom): the dev-mode packer in `server/visions-setup.ts` only strips types, so whatever module shape the source has is what the VS Code extension host loads, and the host loads plain CJS. Pinned by `tests/visions-extension-package.test.ts`.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
