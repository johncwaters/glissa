// Formatting only: the work behind install, setup and status lives in server/visions-setup.ts, which the
// daemon runs by itself when the switch flips.

import fs from 'node:fs';

import { createRelay } from '../session/visions-relay.ts';
import { buildSetupGuide, commandLine, recipeIds } from './core/editor-setup-core.ts';
import { isExtensionInstalled } from './core/editor-extension-core.ts';
import { extensionIdOf } from './core/vsix-core.ts';
import { editorTargets } from './editor-wire.ts';
import type { EditorOutcome } from './editor-wire.ts';
import {
  RELAY_PATH, editorExtensions, packVsix, relayInvocationOptions, resolveRelayInvocation, resolvedEditorPaths,
  unwireEverything, wireEverything,
} from './visions-setup.ts';

function reportFiles(files: EditorOutcome[]): void {
  for (const file of files) {
    console.log(`  ${file.label.padEnd(18)} ${file.action}: ${file.filePath}`);
  }
}

async function runInstall(args: string[]): Promise<number> {
  const requestedIndex = args.indexOf('--editor');
  const requested = requestedIndex >= 0 ? args[requestedIndex + 1] || null : null;
  const report = await wireEverything({ requested });
  if (!report.ok) {
    console.error(`visions install: ${report.reason}`);
    return 1;
  }

  for (const result of report.extensions.results) {
    console.log(`  ${result.label.padEnd(18)} ${result.ok ? 'extension installed' : `FAILED: ${result.detail}`}`);
  }
  if (report.extensions.results.length === 0) console.log(`  ${'VS Code family'.padEnd(18)} ${report.extensions.reason}`);
  reportFiles(report.files);

  console.log(`\nrelay ${report.invocation ? commandLine(report.invocation) : '(unresolved)'}`);
  console.log('reload any open editor window, then open a markdown file inside a project the daemon knows.');
  return report.extensions.results.some((result) => !result.ok) ? 1 : 0;
}

async function runUninstall(): Promise<number> {
  const report = await unwireEverything();
  for (const result of report.extensions.results) {
    console.log(`  ${result.label.padEnd(18)} ${result.ok ? `extension ${result.detail}` : `FAILED: ${result.detail}`}`);
  }
  reportFiles(report.files);
  return 0;
}

async function runStatus(): Promise<number> {
  const { manifest } = packVsix();
  const extensionId = extensionIdOf(manifest);
  const editors = Object.entries(resolvedEditorPaths());

  console.log('glissa visions\n');
  console.log(`  ${'relay'.padEnd(18)} ${fs.existsSync(RELAY_PATH) ? commandLine(resolveRelayInvocation()) : `MISSING: ${RELAY_PATH}`}`);
  console.log(`  ${'extension'.padEnd(18)} ${extensionId} ${manifest.version}`);
  if (editors.length === 0) console.log(`  ${'VS Code family'.padEnd(18)} none found on PATH`);
  for (const [command, commandPath] of editors) {
    const installed = isExtensionInstalled(await editorExtensions(commandPath), extensionId);
    console.log(`  ${command.padEnd(18)} ${installed ? 'extension installed' : 'not installed'}`);
  }
  for (const target of editorTargets()) {
    console.log(`  ${target.label.padEnd(18)} ${fs.existsSync(target.filePath) ? 'wired' : 'not wired'}: ${target.filePath}`);
  }
  return 0;
}

// The relay owns stdout from here on: it is the LSP wire, so nothing else may write a byte to it.
function runRelay(): Promise<never> {
  createRelay().start();
  return new Promise(() => {});
}

function runSetup(args: string[]): number {
  const editorIndex = args.indexOf('--editor');
  const editorId = editorIndex >= 0 ? args[editorIndex + 1] || null : null;
  const { chosen: invocation, absolute, onPath } = relayInvocationOptions();
  const guide = buildSetupGuide({ editorId, invocation });
  if (!guide.ok) {
    console.error(`visions setup: ${guide.reason} (known: ${recipeIds().join(', ')})`);
    return 1;
  }

  console.log(`The Visions relay is one stdio LSP server: ${commandLine(invocation)}`);
  // A GUI-launched editor inherits the desktop session's PATH, which often lacks the npm global bin dir.
  if (onPath) console.log(`An editor launched from a desktop menu may not see your PATH; there, use: ${commandLine(absolute)}`);
  console.log('Turning Visions on wires these for you; this is the manual form.\n');
  for (const section of guide.sections) {
    console.log(`${section.label}  (${section.where})`);
    console.log(`${section.snippet}\n`);
  }
  console.log('Findings reach the dashboard Visions tab whichever client mirrors the buffer.');
  console.log('The relay tries port 5173 then 3000; GLISSA_PORT or --port names another one.');
  return 0;
}

async function runVisionsCli(args: string[] = []): Promise<number | never> {
  const command = args[0];
  if (command === 'relay') return runRelay();
  if (command === 'install') return runInstall(args.slice(1));
  if (command === 'uninstall') return runUninstall();
  if (command === 'setup') return runSetup(args.slice(1));
  if (command === 'status') return runStatus();
  console.error('Usage: glissa visions relay\n       glissa visions install [--editor <command>]\n       glissa visions uninstall\n       glissa visions setup [--editor <id>]\n       glissa visions status');
  return 1;
}

export { runVisionsCli };
