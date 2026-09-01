// Visions is one switch: turning it on wires every editor on the machine and turning it off unwires
// them, because a lane whose input needs a per-editor setup chore is a lane nobody has running.

'use strict';

const fs = require('node:fs');
const { stripTypeScriptTypes } = require('node:module');
const os = require('node:os');
const path = require('node:path');

const { execFileAsync, execSync } = require('./child-process-safe');
const { buildVsix, extensionIdOf } = require('./core/vsix-core.ts');
const {
  EDITOR_CANDIDATES, decideEditorTargets, isExtensionInstalled, visionsExtensionFiles,
} = require('./core/editor-extension-core.ts');
const { relayInvocation } = require('./core/editor-setup-core.ts');
const { applyChanges, decideImpliedDefaults } = require('./core/visions-defaults-core.ts');
const { isUnder, underTestRunner } = require('./core/db-path-guard.ts');
const { createLaneLog } = require('./lane-log');
const { unwireEditors, wireEditors } = require('./editor-wire');
const { resolvePathCommandMatches } = require('../session/core/spawn-command.ts');

const PACKAGE_ROOT = path.join(__dirname, '..');
const EXTENSION_DIR = path.join(PACKAGE_ROOT, 'tools', 'vscode-visions');
const RELAY_PATH = path.join(PACKAGE_ROOT, 'session', 'visions-relay.ts');
const LSP_CORE_PATH = path.join(PACKAGE_ROOT, 'server', 'core', 'visions-lsp-core.ts');
const CLI_PATH = path.join(PACKAGE_ROOT, 'bin', 'glissa.js');
const EDITOR_TIMEOUT_MS = 60000;

// The extension host is CommonJS with no type stripping of its own, so the packed copy of the core is
// its types erased and its one ESM export rewritten.
function packedLspCore(source) {
  const stripped = stripTypeScriptTypes(source, { mode: 'strip' });
  return stripped.replace(/^export \{([^}]*)\};/m, 'module.exports = {$1};');
}

function packVsix() {
  const manifestJson = fs.readFileSync(path.join(EXTENSION_DIR, 'package.json'), 'utf8');
  const manifest = JSON.parse(manifestJson);
  /** @type {{ path: string, data: string }[]} */
  const extensionFiles = visionsExtensionFiles({
    manifestJson,
    extensionJs: fs.readFileSync(path.join(EXTENSION_DIR, 'extension.js'), 'utf8'),
    convertJs: fs.readFileSync(path.join(EXTENSION_DIR, 'lsp-convert.js'), 'utf8'),
    lspCoreJs: packedLspCore(fs.readFileSync(LSP_CORE_PATH, 'utf8')),
    relayPath: RELAY_PATH,
  });
  const vsix = buildVsix({
    manifest,
    extensionFiles,
  });
  return { manifest, vsix };
}

function missingInstallFiles() {
  return [RELAY_PATH, LSP_CORE_PATH].filter((filePath) => !fs.existsSync(filePath));
}

function resolvedEditorPaths({ platform = process.platform, exec = execSync } = {}) {
  const resolved = {};
  for (const candidate of EDITOR_CANDIDATES) {
    const matches = resolvePathCommandMatches(candidate.command, { platform, exec });
    if (matches.length === 0) continue;
    resolved[candidate.command] = matches[0];
  }
  return resolved;
}

function relayInvocationOptions({ platform = process.platform, exec = execSync } = {}) {
  const onPath = resolvePathCommandMatches('glissa', { platform, exec }).length > 0;
  return {
    chosen: relayInvocation({ glissaOnPath: onPath, cliPath: CLI_PATH, nodePath: process.execPath }),
    absolute: relayInvocation({ glissaOnPath: false, cliPath: CLI_PATH, nodePath: process.execPath }),
    onPath,
  };
}

function resolveRelayInvocation(options = {}) {
  return relayInvocationOptions(options).chosen;
}

async function editorExtensions(commandPath) {
  try {
    const { stdout } = await execFileAsync(commandPath, ['--list-extensions'], { timeout: EDITOR_TIMEOUT_MS });
    return stdout;
  } catch (error) {
    return `${error?.stdout || ''}`;
  }
}

async function installInto(target, vsixPath, extensionId) {
  try {
    await execFileAsync(target.commandPath, ['--install-extension', vsixPath, '--force'], { timeout: EDITOR_TIMEOUT_MS });
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim().split('\n').pop();
    return { ...target, ok: false, detail };
  }
  const installed = isExtensionInstalled(await editorExtensions(target.commandPath), extensionId);
  if (!installed) return { ...target, ok: false, detail: 'the editor reported no error but does not list the extension' };
  return { ...target, ok: true, detail: 'installed' };
}

async function uninstallFrom(target, extensionId) {
  if (!isExtensionInstalled(await editorExtensions(target.commandPath), extensionId)) {
    return { ...target, ok: true, detail: 'not installed' };
  }
  try {
    await execFileAsync(target.commandPath, ['--uninstall-extension', extensionId], { timeout: EDITOR_TIMEOUT_MS });
  } catch (error) {
    return { ...target, ok: false, detail: String(error?.stderr || error?.message || error).trim().split('\n').pop() };
  }
  return { ...target, ok: true, detail: 'removed' };
}

async function installExtensions({ requested = null, resolvedByCommand = null } = {}) {
  const { targets, reason } = decideEditorTargets({ requested, resolvedByCommand: resolvedByCommand || resolvedEditorPaths() });
  if (targets.length === 0) return { targets: [], reason, results: [] };

  const { manifest, vsix } = packVsix();
  const extensionId = extensionIdOf(manifest);
  const vsixPath = path.join(os.tmpdir(), `${extensionId}-${manifest.version}.vsix`);
  fs.writeFileSync(vsixPath, vsix);
  /** @type {Awaited<ReturnType<typeof installInto>>[]} */
  const results = [];
  for (const target of targets) results.push(await installInto(target, vsixPath, extensionId));
  return { targets, reason, results };
}

async function uninstallExtensions({ resolvedByCommand = null } = {}) {
  const { targets } = decideEditorTargets({ resolvedByCommand: resolvedByCommand || resolvedEditorPaths() });
  const { manifest } = packVsix();
  const extensionId = extensionIdOf(manifest);
  const results = [];
  for (const target of targets) results.push(await uninstallFrom(target, extensionId));
  return { targets, results };
}

async function wireEverything({ requested = null, dryRun = false } = {}) {
  const missing = missingInstallFiles();
  if (missing.length > 0) {
    return { ok: false, reason: `missing from this install: ${missing.join(', ')}`, extensions: { targets: [], reason: 'not-run', results: [] }, files: [] };
  }
  const invocation = resolveRelayInvocation();
  const extensions = await installExtensions({ requested });
  const files = wireEditors({ invocation, dryRun });
  return { ok: true, reason: 'ok', invocation, extensions, files };
}

async function unwireEverything() {
  const extensions = await uninstallExtensions();
  const files = unwireEditors();
  return { extensions, files };
}

// One run per transition of `visions.enabled`, and failure is a log line: an editor that could not be
// wired must never be able to stop the lane it was for.
/**
 * @param {{ getConfig?: () => { visions?: { enabled?: boolean } },
 *   configStore?: { configPath?: string, save: (mutator: (config: Record<string, unknown>) => void) => Record<string, unknown> | null } | null,
 *   logger?: Console, debug?: boolean | (() => boolean), env?: NodeJS.ProcessEnv,
 *   onConfigChanged?: (() => void | Promise<void>) | null,
 *   wire?: typeof wireEverything, unwire?: typeof unwireEverything }} [options]
 */
function createVisionsSetup({
  getConfig = () => ({}), configStore = null, logger = console, debug = false, env = process.env,
  onConfigChanged = null, wire = wireEverything, unwire = unwireEverything,
} = {}) {
  const { note, warn } = createLaneLog({ prefix: '[visions-setup]', logger, debugFlag: debug });
  // False rather than null, so a boot with Visions OFF is not a transition and unwires nothing the
  // operator installed by hand; a boot with it ON is one, which is what keeps a wiring current.
  /** @type {boolean | null} */
  let appliedState = false;
  /** @type {Promise<unknown> | null} */
  let inFlight = null;

  function isEnabled() {
    return getConfig()?.visions?.enabled === true;
  }

  function reportFiles(files) {
    for (const file of files) {
      if (file.action === 'unchanged' || file.action === 'skipped') continue;
      if (file.action === 'failed') {
        warn(`${file.label}: ${file.reason} (${file.filePath})`);
        continue;
      }
      note(`${file.label}: ${file.action} ${file.filePath}`);
    }
  }

  async function apply(enabled) {
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

  // The live config is mutated beside the file, since configStore.save only writes disk: without it the
  // lanes would compare against a config that still says off and rebuild nothing until the next boot.
  function writeImpliedDefaults() {
    if (!configStore || isConfigWriteRefused()) return null;
    if (decideImpliedDefaults(getConfig()).changes.length === 0) return null;
    // The DISK decision is the authority, and the live object then gets exactly what was written: the
    // file may have moved under this process, and two lists would let the lanes rebuild against neither.
    const written = [];
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

  function reportConfigChanged() {
    if (typeof onConfigChanged !== 'function') return;
    void Promise.resolve().then(onConfigChanged).catch((error) => warn(`lane rebuild failed: ${error.message}`));
  }

  // A test booting with Visions on must not install extensions into the operator's real editors.
  function isEditorWiringRefused() {
    return underTestRunner(env) && wire === wireEverything && unwire === unwireEverything;
  }

  // Nor may it write the operator's own config, the hazard db-path-guard refuses a home database for.
  function isConfigWriteRefused() {
    if (!underTestRunner(env)) return false;
    const configPath = configStore?.configPath;
    if (typeof configPath !== 'string' || !configPath) return false;
    return isUnder(configPath, os.homedir()) && !isUnder(configPath, os.tmpdir());
  }

  async function maybeApply() {
    const enabled = isEnabled();
    if (appliedState === enabled) return null;
    if (inFlight) return inFlight;
    appliedState = enabled;
    inFlight = apply(enabled)
      .catch((error) => {
        appliedState = null;
        warn(`editor wiring failed: ${error.message}`);
        return null;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return { maybeApply };
}

module.exports = {
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
