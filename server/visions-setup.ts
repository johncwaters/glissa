// Visions is one switch: turning it on wires every editor on the machine and turning it off unwires
// them, because a lane whose input needs a per-editor setup chore is a lane nobody has running.

import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { resolvePathCommandMatches } from '../session/core/spawn-command.ts';
import { execFileAsync, execSync } from './child-process-safe.ts';
import { isUnder, underTestRunner } from './core/db-path-guard.ts';
import {
  EDITOR_CANDIDATES, decideEditorTargets, isExtensionInstalled, visionsExtensionFiles,
} from './core/editor-extension-core.ts';
import type { EditorTarget as ExtensionEditorTarget } from './core/editor-extension-core.ts';
import { relayInvocation } from './core/editor-setup-core.ts';
import type { Invocation } from './core/editor-setup-core.ts';
import { applyChanges, decideImpliedDefaults } from './core/visions-defaults-core.ts';
import type { ImpliedChange } from './core/visions-defaults-core.ts';
import { buildVsix, extensionIdOf } from './core/vsix-core.ts';
import type { VsixManifest } from './core/vsix-core.ts';
import { unwireEditors, wireEditors } from './editor-wire.ts';
import type { EditorOutcome } from './editor-wire.ts';
import { createLaneLog } from './lane-log.ts';
import type { LaneLogger } from './lane-log.ts';
import { bundled, cliPath, extensionDir, packageRoot, relayPath } from './runtime-paths.ts';

const EXTENSION_DIR = extensionDir;
const RELAY_PATH = relayPath('visions-relay');
// Bundled, the extension's three files are already built CJS beside its manifest; from a checkout they
// are the .ts sources this module strips at pack time.
const LSP_CORE_PATH = bundled
  ? path.join(EXTENSION_DIR, 'visions-lsp-core.js')
  : path.join(packageRoot, 'server', 'core', 'visions-lsp-core.ts');
const CLI_PATH = cliPath;
const EDITOR_TIMEOUT_MS = 60000;

interface InstallOutcome extends ExtensionEditorTarget {
  ok: boolean;
  detail: string | undefined;
}

interface ExtensionReport {
  targets: ExtensionEditorTarget[];
  reason: string;
  results: InstallOutcome[];
}

interface WireReport {
  ok: boolean;
  reason: string;
  invocation?: Invocation;
  extensions: ExtensionReport;
  files: EditorOutcome[];
}

interface VisionsSetupOptions {
  getConfig?: () => Record<string, unknown>;
  configStore?: {
    configPath?: string;
    save: (mutator: (config: Record<string, unknown>) => void) => Record<string, unknown> | null;
  } | null;
  logger?: LaneLogger;
  debug?: boolean | (() => boolean);
  env?: NodeJS.ProcessEnv;
  onConfigChanged?: (() => void | Promise<void>) | null;
  wire?: typeof wireEverything;
  unwire?: typeof unwireEverything;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandFailureDetail(error: unknown): string | undefined {
  const failure = (error ?? {}) as { stderr?: unknown; message?: unknown };
  return String(failure.stderr || failure.message || error).trim().split('\n').pop();
}

// The extension host is CommonJS with no type stripping of its own, so every packed source is its
// types erased. The extension's own files are authored CommonJS-style and need nothing more.
function packedSource(filePath: string): string {
  return stripTypeScriptTypes(fs.readFileSync(filePath, 'utf8'), { mode: 'strip' });
}

// The core is the one packed file authored as an ES module, so its single export is rewritten too.
function packedLspCore(filePath: string): string {
  return packedSource(filePath).replace(/^export \{([^}]*)\};/m, 'module.exports = {$1};');
}

function packedExtensionSources(): { extensionJs: string; convertJs: string; lspCoreJs: string } {
  if (bundled) {
    return {
      extensionJs: fs.readFileSync(path.join(EXTENSION_DIR, 'extension.js'), 'utf8'),
      convertJs: fs.readFileSync(path.join(EXTENSION_DIR, 'lsp-convert.js'), 'utf8'),
      lspCoreJs: fs.readFileSync(LSP_CORE_PATH, 'utf8'),
    };
  }
  return {
    extensionJs: packedSource(path.join(EXTENSION_DIR, 'extension.ts')),
    convertJs: packedSource(path.join(EXTENSION_DIR, 'lsp-convert.ts')),
    lspCoreJs: packedLspCore(LSP_CORE_PATH),
  };
}

function packVsix(): { manifest: VsixManifest; vsix: Buffer } {
  const manifestJson = fs.readFileSync(path.join(EXTENSION_DIR, 'package.json'), 'utf8');
  const manifest = JSON.parse(manifestJson) as VsixManifest;
  const extensionFiles = visionsExtensionFiles({
    manifestJson,
    ...packedExtensionSources(),
    relayPath: RELAY_PATH,
  });
  const vsix = buildVsix({
    manifest,
    extensionFiles,
  });
  return { manifest, vsix };
}

function missingInstallFiles(): string[] {
  return [RELAY_PATH, LSP_CORE_PATH].filter((filePath) => !fs.existsSync(filePath));
}

function resolvedEditorPaths(
  { platform = process.platform, exec = execSync }: { platform?: NodeJS.Platform; exec?: typeof execSync } = {},
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const candidate of EDITOR_CANDIDATES) {
    const matches = resolvePathCommandMatches(candidate.command, { platform, exec });
    const first = matches[0];
    if (!first) continue;
    resolved[candidate.command] = first;
  }
  return resolved;
}

function relayInvocationOptions(
  { platform = process.platform, exec = execSync }: { platform?: NodeJS.Platform; exec?: typeof execSync } = {},
): { chosen: Invocation; absolute: Invocation; onPath: boolean } {
  const onPath = resolvePathCommandMatches('glissa', { platform, exec }).length > 0;
  return {
    chosen: relayInvocation({ glissaOnPath: onPath, cliPath: CLI_PATH, nodePath: process.execPath }),
    absolute: relayInvocation({ glissaOnPath: false, cliPath: CLI_PATH, nodePath: process.execPath }),
    onPath,
  };
}

function resolveRelayInvocation(
  options: { platform?: NodeJS.Platform; exec?: typeof execSync } = {},
): Invocation {
  return relayInvocationOptions(options).chosen;
}

async function editorExtensions(commandPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(commandPath, ['--list-extensions'], { timeout: EDITOR_TIMEOUT_MS });
    return stdout;
  } catch (error) {
    const failure = (error ?? {}) as { stdout?: unknown };
    return `${failure.stdout || ''}`;
  }
}

async function installInto(
  target: ExtensionEditorTarget,
  vsixPath: string,
  extensionId: string,
): Promise<InstallOutcome> {
  try {
    await execFileAsync(target.commandPath, ['--install-extension', vsixPath, '--force'], { timeout: EDITOR_TIMEOUT_MS });
  } catch (error) {
    return { ...target, ok: false, detail: commandFailureDetail(error) };
  }
  const installed = isExtensionInstalled(await editorExtensions(target.commandPath), extensionId);
  if (!installed) return { ...target, ok: false, detail: 'the editor reported no error but does not list the extension' };
  return { ...target, ok: true, detail: 'installed' };
}

async function uninstallFrom(target: ExtensionEditorTarget, extensionId: string): Promise<InstallOutcome> {
  if (!isExtensionInstalled(await editorExtensions(target.commandPath), extensionId)) {
    return { ...target, ok: true, detail: 'not installed' };
  }
  try {
    await execFileAsync(target.commandPath, ['--uninstall-extension', extensionId], { timeout: EDITOR_TIMEOUT_MS });
  } catch (error) {
    return { ...target, ok: false, detail: commandFailureDetail(error) };
  }
  return { ...target, ok: true, detail: 'removed' };
}

async function installExtensions(
  { requested = null, resolvedByCommand = null }: {
    requested?: string | null;
    resolvedByCommand?: Record<string, string> | null;
  } = {},
): Promise<ExtensionReport> {
  const { targets, reason } = decideEditorTargets({ requested, resolvedByCommand: resolvedByCommand || resolvedEditorPaths() });
  if (targets.length === 0) return { targets: [], reason, results: [] };

  const { manifest, vsix } = packVsix();
  const extensionId = extensionIdOf(manifest);
  const vsixPath = path.join(os.tmpdir(), `${extensionId}-${manifest.version}.vsix`);
  fs.writeFileSync(vsixPath, vsix);
  const results: InstallOutcome[] = [];
  for (const target of targets) results.push(await installInto(target, vsixPath, extensionId));
  return { targets, reason, results };
}

async function uninstallExtensions(
  { resolvedByCommand = null }: { resolvedByCommand?: Record<string, string> | null } = {},
): Promise<{ targets: ExtensionEditorTarget[]; results: InstallOutcome[] }> {
  const { targets } = decideEditorTargets({ resolvedByCommand: resolvedByCommand || resolvedEditorPaths() });
  const { manifest } = packVsix();
  const extensionId = extensionIdOf(manifest);
  const results: InstallOutcome[] = [];
  for (const target of targets) results.push(await uninstallFrom(target, extensionId));
  return { targets, results };
}

async function wireEverything(
  { requested = null, dryRun = false }: { requested?: string | null; dryRun?: boolean } = {},
): Promise<WireReport> {
  const missing = missingInstallFiles();
  if (missing.length > 0) {
    return { ok: false, reason: `missing from this install: ${missing.join(', ')}`, extensions: { targets: [], reason: 'not-run', results: [] }, files: [] };
  }
  const invocation = resolveRelayInvocation();
  const extensions = await installExtensions({ requested });
  const files = wireEditors({ invocation, dryRun });
  return { ok: true, reason: 'ok', invocation, extensions, files };
}

async function unwireEverything(): Promise<{
  extensions: { targets: ExtensionEditorTarget[]; results: InstallOutcome[] };
  files: EditorOutcome[];
}> {
  const extensions = await uninstallExtensions();
  const files = unwireEditors();
  return { extensions, files };
}

// One run per transition of `visions.enabled`, and failure is a log line: an editor that could not be
// wired must never be able to stop the lane it was for.
function createVisionsSetup({
  getConfig = () => ({}), configStore = null, logger = console, debug = false, env = process.env,
  onConfigChanged = null, wire = wireEverything, unwire = unwireEverything,
}: VisionsSetupOptions = {}) {
  const { note, warn } = createLaneLog({ prefix: '[visions-setup]', logger, debugFlag: debug });
  // False rather than null, so a boot with Visions OFF is not a transition and unwires nothing the
  // operator installed by hand; a boot with it ON is one, which is what keeps a wiring current.
  let appliedState: boolean | null = false;
  let inFlight: Promise<unknown> | null = null;

  function isEnabled(): boolean {
    const visions = getConfig()?.visions as { enabled?: unknown } | null | undefined;
    return visions?.enabled === true;
  }

  function reportFiles(files: EditorOutcome[]): void {
    for (const file of files) {
      if (file.action === 'unchanged' || file.action === 'skipped') continue;
      if (file.action === 'failed') {
        warn(`${file.label}: ${file.reason} (${file.filePath})`);
        continue;
      }
      note(`${file.label}: ${file.action} ${file.filePath}`);
    }
  }

  function reportConfigChanged(): void {
    if (typeof onConfigChanged !== 'function') return;
    void Promise.resolve().then(onConfigChanged).catch((error: unknown) => warn(`lane rebuild failed: ${errorMessage(error)}`));
  }

  // A test booting with Visions on must not install extensions into the operator's real editors.
  function isEditorWiringRefused(): boolean {
    return underTestRunner(env) && wire === wireEverything && unwire === unwireEverything;
  }

  // Nor may it write the operator's own config, the hazard db-path-guard refuses a home database for.
  function isConfigWriteRefused(): boolean {
    if (!underTestRunner(env)) return false;
    const configPath = configStore?.configPath;
    if (typeof configPath !== 'string' || !configPath) return false;
    return isUnder(configPath, os.homedir()) && !isUnder(configPath, os.tmpdir());
  }

  // The live config is mutated beside the file, since configStore.save only writes disk: without it the
  // lanes would compare against a config that still says off and rebuild nothing until the next boot.
  function writeImpliedDefaults() {
    if (!configStore || isConfigWriteRefused()) return null;
    if (decideImpliedDefaults(getConfig()).changes.length === 0) return null;
    // The DISK decision is the authority, and the live object then gets exactly what was written: the
    // file may have moved under this process, and two lists would let the lanes rebuild against neither.
    const written: ImpliedChange[] = [];
    const saved = configStore.save((freshConfig) => {
      const changes = decideImpliedDefaults(freshConfig).changes;
      written.push(...changes);
      applyChanges(freshConfig, changes);
    });
    if (!saved || written.length === 0) return null;
    applyChanges(getConfig(), written);
    for (const change of written) note(`config: ${change.path.join('.')} on (${change.why})`);
    reportConfigChanged();
    return saved;
  }

  async function apply(enabled: boolean) {
    if (!enabled) {
      if (isEditorWiringRefused()) return null;
      const report = await unwire();
      reportFiles(report.files);
      for (const result of report.extensions.results) note(`${result.label}: extension ${result.detail}`);
      return report;
    }
    writeImpliedDefaults();
    if (isEditorWiringRefused()) return null;
    const report = await wire({});
    if (!report.ok) {
      warn(report.reason);
      return report;
    }
    reportFiles(report.files);
    for (const result of report.extensions.results) {
      if (result.ok) note(`${result.label}: extension ${result.detail}`);
      if (!result.ok) warn(`${result.label}: extension install failed: ${result.detail}`);
    }
    return report;
  }

  async function maybeApply() {
    const enabled = isEnabled();
    if (appliedState === enabled) return null;
    if (inFlight) return inFlight;
    appliedState = enabled;
    inFlight = apply(enabled)
      .catch((error: unknown) => {
        appliedState = null;
        warn(`editor wiring failed: ${errorMessage(error)}`);
        return null;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return { maybeApply };
}

export {
  RELAY_PATH,
  createVisionsSetup,
  editorExtensions,
  installExtensions,
  packVsix,
  relayInvocationOptions,
  resolveRelayInvocation,
  resolvedEditorPaths,
  unwireEverything,
  wireEverything,
};
export type { ExtensionReport, InstallOutcome, VisionsSetupOptions, WireReport };
