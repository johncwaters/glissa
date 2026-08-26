// Pure decisions for `glissa visions install`. Every VS Code fork exposes the same install CLI, so one
// candidate table covers them all.

'use strict';

const EDITOR_CANDIDATES = [
  { command: 'codium', label: 'VSCodium' },
  { command: 'code', label: 'VS Code' },
  { command: 'code-insiders', label: 'VS Code Insiders' },
  { command: 'cursor', label: 'Cursor' },
  { command: 'windsurf', label: 'Windsurf' },
];

// EVERY detected editor is a target: nothing here can know which one the operator will open the file
// in, and installing into the other one looks exactly like an extension that never ran.
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

// The relay path is STAMPED and the framing module COPIED because an installed extension lives outside
// this package and can resolve nothing inside it.
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
