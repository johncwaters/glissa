/*
 * Pure decisions for `glissa visions install`: which editor CLIs to target, what goes inside the
 * packed extension, and whether an install actually took. The VS Code family all expose the same
 * `--install-extension` / `--list-extensions` CLI, so one table covers every fork the operator may run.
 */

'use strict';

const EDITOR_CANDIDATES = [
  { command: 'codium', label: 'VSCodium' },
  { command: 'code', label: 'VS Code' },
  { command: 'code-insiders', label: 'VS Code Insiders' },
  { command: 'cursor', label: 'Cursor' },
  { command: 'windsurf', label: 'Windsurf' },
];

/**
 * Every detected editor is a target, not just the first: a machine with two of them has no way to say
 * which one the operator will open the file in, and installing into one it does not use looks like the
 * extension silently never ran. An explicit `--editor` overrides that and fails loudly when it resolves
 * to nothing, since a typo there would otherwise install somewhere the operator did not ask for.
 */
function decideEditorTargets({ requested = null, resolvedByCommand = {} } = {}) {
  if (requested) {
    const commandPath = resolvedByCommand[requested];
    if (!commandPath) return { targets: [], reason: `editor not found on PATH: ${requested}` };
    const known = EDITOR_CANDIDATES.find((candidate) => candidate.command === requested);
    return { targets: [{ command: requested, label: known?.label || requested, commandPath }], reason: 'requested' };
  }

  const targets = [];
  for (const candidate of EDITOR_CANDIDATES) {
    const commandPath = resolvedByCommand[candidate.command];
    if (!commandPath) continue;
    targets.push({ ...candidate, commandPath });
  }
  if (targets.length === 0) return { targets: [], reason: 'no VS Code family editor found on PATH' };
  return { targets, reason: 'detected' };
}

function relayStamp(relayPath) {
  return `${JSON.stringify({ relayPath }, null, 2)}\n`;
}

/**
 * The packed extension carries the daemon's own copy of the LSP framing module rather than a second
 * spelling of it, which is why the relay path is STAMPED at pack time: the extension lives outside the
 * npm package once installed and can no longer resolve anything inside it.
 */
function visionsExtensionFiles({ manifestJson, extensionJs, convertJs, lspCoreJs, relayPath }) {
  return [
    { path: 'package.json', data: manifestJson },
    { path: 'extension.js', data: extensionJs },
    { path: 'lsp-convert.js', data: convertJs },
    { path: 'visions-lsp-core.js', data: lspCoreJs },
    { path: 'relay-path.json', data: relayStamp(relayPath) },
  ];
}

function parseInstalledExtensions(stdout) {
  return String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function isExtensionInstalled(stdout, extensionId) {
  const wanted = String(extensionId).toLowerCase();
  return parseInstalledExtensions(stdout).some((line) => line.toLowerCase() === wanted);
}

module.exports = {
  EDITOR_CANDIDATES,
  decideEditorTargets,
  isExtensionInstalled,
  parseInstalledExtensions,
  relayStamp,
  visionsExtensionFiles,
};
