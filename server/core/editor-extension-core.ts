export interface EditorCandidate {
  command: string;
  label: string;
}

export interface EditorTarget extends EditorCandidate {
  commandPath: string;
}

export interface EditorTargetDecision {
  targets: EditorTarget[];
  reason: string;
}

export interface ExtensionFile {
  path: string;
  data: string;
}

const EDITOR_CANDIDATES: EditorCandidate[] = [
  { command: 'codium', label: 'VSCodium' },
  { command: 'code', label: 'VS Code' },
  { command: 'code-insiders', label: 'VS Code Insiders' },
  { command: 'cursor', label: 'Cursor' },
  { command: 'windsurf', label: 'Windsurf' },
];

function decideEditorTargets({
  requested = null,
  resolvedByCommand = {},
}: {
  requested?: string | null;
  resolvedByCommand?: Record<string, string | undefined>;
} = {}): EditorTargetDecision {
  if (requested) {
    const commandPath = resolvedByCommand[requested];
    if (!commandPath) return { targets: [], reason: `editor not found on PATH: ${requested}` };
    const known = EDITOR_CANDIDATES.find((candidate) => candidate.command === requested);
    return { targets: [{ command: requested, label: known?.label || requested, commandPath }], reason: 'requested' };
  }

  const targets: EditorTarget[] = [];
  for (const candidate of EDITOR_CANDIDATES) {
    const commandPath = resolvedByCommand[candidate.command];
    if (!commandPath) continue;
    targets.push({ ...candidate, commandPath });
  }
  if (targets.length === 0) return { targets: [], reason: 'no VS Code family editor found on PATH' };
  return { targets, reason: 'detected' };
}

function relayStamp(relayPath: string): string {
  return `${JSON.stringify({ relayPath }, null, 2)}\n`;
}

function visionsExtensionFiles({
  manifestJson,
  extensionJs,
  convertJs,
  lspCoreJs,
  relayPath,
}: {
  manifestJson: string;
  extensionJs: string;
  convertJs: string;
  lspCoreJs: string;
  relayPath: string;
}): ExtensionFile[] {
  return [
    { path: 'package.json', data: manifestJson },
    { path: 'extension.js', data: extensionJs },
    { path: 'lsp-convert.js', data: convertJs },
    { path: 'visions-lsp-core.js', data: lspCoreJs },
    { path: 'relay-path.json', data: relayStamp(relayPath) },
  ];
}

function parseInstalledExtensions(stdout: unknown): string[] {
  return String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function isExtensionInstalled(stdout: unknown, extensionId: string): boolean {
  const wanted = String(extensionId).toLowerCase();
  return parseInstalledExtensions(stdout).some((line) => line.toLowerCase() === wanted);
}

export {
  EDITOR_CANDIDATES,
  decideEditorTargets,
  isExtensionInstalled,
  parseInstalledExtensions,
  relayStamp,
  visionsExtensionFiles,
};
