// Without the editor extension the Visions lane has no document source at all, which is why installing
// it is one command rather than a documented procedure.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { execFileAsync, execSync } = require('./child-process-safe');
const { buildVsix, extensionIdOf } = require('./core/vsix-core');
const {
  EDITOR_CANDIDATES, decideEditorTargets, isExtensionInstalled, visionsExtensionFiles,
} = require('./core/editor-extension-core');
const { resolvePathCommandMatches } = require('../session/core/spawn-command');

const PACKAGE_ROOT = path.join(__dirname, '..');
const EXTENSION_DIR = path.join(PACKAGE_ROOT, 'tools', 'vscode-visions');
const RELAY_PATH = path.join(PACKAGE_ROOT, 'session', 'visions-relay.js');
const LSP_CORE_PATH = path.join(PACKAGE_ROOT, 'server', 'core', 'visions-lsp-core.js');
const EDITOR_TIMEOUT_MS = 60000;

function resolvedEditorPaths({ platform = process.platform, exec = execSync } = {}) {
  const resolved = {};
  for (const candidate of EDITOR_CANDIDATES) {
    const matches = resolvePathCommandMatches(candidate.command, { platform, exec });
    if (matches.length === 0) continue;
    resolved[candidate.command] = matches[0];
  }
  return resolved;
}

function packVsix() {
  const manifestJson = fs.readFileSync(path.join(EXTENSION_DIR, 'package.json'), 'utf8');
  const manifest = JSON.parse(manifestJson);
  const vsix = buildVsix({
    manifest,
    extensionFiles: visionsExtensionFiles({
      manifestJson,
      extensionJs: fs.readFileSync(path.join(EXTENSION_DIR, 'extension.js'), 'utf8'),
      convertJs: fs.readFileSync(path.join(EXTENSION_DIR, 'lsp-convert.js'), 'utf8'),
      lspCoreJs: fs.readFileSync(LSP_CORE_PATH, 'utf8'),
      relayPath: RELAY_PATH,
    }),
  });
  return { manifest, vsix };
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
    return { ok: false, detail };
  }
  const installed = isExtensionInstalled(await editorExtensions(target.commandPath), extensionId);
  if (!installed) return { ok: false, detail: 'the editor reported no error but does not list the extension' };
  return { ok: true, detail: 'installed' };
}

async function runInstall(args) {
  const missing = [RELAY_PATH, LSP_CORE_PATH].filter((filePath) => !fs.existsSync(filePath));
  if (missing.length > 0) {
    console.error(`visions install: missing from this install: ${missing.join(', ')}`);
    return 1;
  }

  const requestedIndex = args.indexOf('--editor');
  const requested = requestedIndex >= 0 ? args[requestedIndex + 1] || null : null;
  const { targets, reason } = decideEditorTargets({ requested, resolvedByCommand: resolvedEditorPaths() });
  if (targets.length === 0) {
    console.error(`visions install: ${reason}`);
    console.error('install the editor CLI (VS Code and VSCodium ship it as "Shell Command: Install code command in PATH"), then run this again');
    return 1;
  }

  const { manifest, vsix } = packVsix();
  const extensionId = extensionIdOf(manifest);
  const vsixPath = path.join(os.tmpdir(), `${extensionId}-${manifest.version}.vsix`);
  fs.writeFileSync(vsixPath, vsix);

  let failures = 0;
  for (const target of targets) {
    const result = await installInto(target, vsixPath, extensionId);
    console.log(`  ${target.label.padEnd(18)} ${result.ok ? 'installed' : `FAILED: ${result.detail}`}`);
    if (!result.ok) failures += 1;
  }

  console.log(`\nrelay ${RELAY_PATH}`);
  console.log('reload the editor window, then open a markdown file inside a project the daemon knows.');
  return failures === 0 ? 0 : 1;
}

async function runStatus() {
  const { manifest } = packVsix();
  const extensionId = extensionIdOf(manifest);
  const resolved = resolvedEditorPaths();
  const { targets } = decideEditorTargets({ resolvedByCommand: resolved });

  console.log('glissa visions\n');
  console.log(`  ${'relay'.padEnd(18)} ${fs.existsSync(RELAY_PATH) ? RELAY_PATH : `MISSING: ${RELAY_PATH}`}`);
  console.log(`  ${'extension'.padEnd(18)} ${extensionId} ${manifest.version}`);
  if (targets.length === 0) console.log(`  ${'editors'.padEnd(18)} none found on PATH`);
  for (const target of targets) {
    const installed = isExtensionInstalled(await editorExtensions(target.commandPath), extensionId);
    console.log(`  ${target.label.padEnd(18)} ${installed ? 'extension installed' : 'not installed (run: glissa visions install)'}`);
  }
  return 0;
}

async function runVisionsCli(args = []) {
  const command = args[0];
  if (command === 'install') return runInstall(args.slice(1));
  if (command === 'status') return runStatus();
  console.error('Usage: glissa visions install [--editor <command>]\n       glissa visions status');
  return 1;
}

module.exports = { packVsix, runVisionsCli };
