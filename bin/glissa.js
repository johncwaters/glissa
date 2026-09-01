#!/usr/bin/env node

'use strict';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: glissa [command] [options]

Commands:
  doctor            Diagnose install / PATH issues and exit
  agent setup grok  Install Glissa's env-inert Grok hook relay
  pair              Mint a single-use pairing link for a remote device
  pair --list       List paired devices
  pair --revoke <id>  Revoke a paired device
  visions relay     Run the Visions LSP relay on stdio (what an editor's LSP client spawns)
  visions install   Install the Visions extension into every VS Code family editor on PATH
  visions setup     Print LSP client config for Neovim, Helix, Emacs, Kate, Sublime, JetBrains
  visions status    Report the relay path and which editors carry the extension
  pack build [name] Build one context pack, or every spec
  pack list         List context pack specs and their built versions
  memory forget <id|pattern>  Expunge a remembered record
  memory backfill   Re-run the cold-start transcript backfill
  memory distill [--dry-run]  Rebuild the published projection from the canon

Options:
  --name <label>    Label for the device being paired (with: pair)
  --port <number>   Override the server port (default: 3000)
  --config <path>   Path to config file (default: ~/.glissa/config.json)
  --version         Show version number
  --help, -h        Show this help message`);
  process.exit(0);
}

if (args.includes('--version')) {
  const pkg = require('../package.json');
  console.log(pkg.version);
  process.exit(0);
}

if (args[0] === 'doctor' || args.includes('--doctor')) {
  runDoctor();
  process.exit(0);
}

function getArgValue(flag) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return null;
}

const configArg = getArgValue('--config');
if (configArg) {
  process.env.GLISSA_CONFIG = configArg;
}

const portArg = getArgValue('--port');
if (portArg) {
  process.env.GLISSA_PORT = portArg;
}

// Dispatched BEFORE require('../server') so the CLI never boots a server, and AFTER --config is
// bridged into the env so it resolves the same ~/.glissa root the server would.
if (args[0] === 'pair') {
  const { runPairCli } = require('../server/pair-cli');
  process.exit(runPairCli(args.slice(1)));
}

const isAgentCommand = args[0] === 'agent';
if (isAgentCommand) {
  const { runAgentSetupCli } = require('../server/agent-setup-cli');
  process.exit(runAgentSetupCli(args.slice(1)));
}

// Async, so they cannot process.exit inline the way `pair` does; the server boot is skipped instead.
function runAsyncCommand(run) {
  run.then(
    (code) => process.exit(code),
    (err) => {
      console.error(err?.message || String(err));
      process.exit(1);
    }
  );
}

const isVisionsCommand = args[0] === 'visions';
if (isVisionsCommand) {
  const { runVisionsCli } = require('../server/visions-cli');
  runAsyncCommand(runVisionsCli(args.slice(1)));
}

const isPackCommand = args[0] === 'pack';
if (isPackCommand) {
  const { runPackCli } = require('../server/pack-cli');
  runAsyncCommand(runPackCli(args.slice(1)));
}

const isMemoryCommand = args[0] === 'memory';
if (isMemoryCommand) {
  const { runMemoryCli } = require('../server/memory-cli');
  runAsyncCommand(runMemoryCli(args.slice(1)));
}

if (!isPackCommand && !isMemoryCommand && !isAgentCommand && !isVisionsCommand) {
  require('../server');
}

// Read-only replica of config-store.js resolveConfigPath precedence. Reports the
// path WITHOUT creating or seeding anything (the real resolver has side effects),
// so `glissa doctor` stays safe to run.
function resolveConfigPathReadOnly() {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { decideConfigPath, glissaHomeDir } = require('../server/core/config-path-core.ts');
  const decided = decideConfigPath({
    env: process.env,
    homeDir: glissaHomeDir(os.homedir()),
    packageRoot: path.join(__dirname, '..'),
  }, (candidate) => fs.existsSync(candidate));
  if (decided.path) return decided.path;
  if (decided.source === 'env') return `${decided.envPath} (set via GLISSA_CONFIG, but NOT found)`;
  return `${decided.homePath} (created on first run)`;
}

// `glissa doctor`: print a read-only diagnosis of why `glissa` may not be found
// and whether the install is healthy. Must not start the server or throw, so the
// node-pty probe is wrapped and nothing here has side effects.
function runDoctor() {
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const { execSync } = require('../server/child-process-safe');
  const pkg = require('../package.json');
  const { npmGlobalBinDir, pnpmGlobalBinDir, onPath, formatPathNotice } = require('./path-doctor');

  const platform = process.platform;
  const homedir = os.homedir();
  const pathEnv = process.env.PATH || process.env.Path || '';
  const line = (label, value) => console.log(`  ${String(label).padEnd(18)} ${value}`);

  console.log('glissa doctor\n');

  console.log('Versions');
  line('glissa', pkg.version);
  line('node', process.version);
  line('platform', `${platform} ${process.arch}`);

  console.log('\nThis CLI');
  line('running from', process.argv[1] || '(unknown)');
  line('package dir', path.resolve(__dirname, '..'));

  console.log('\nPATH registration');
  // Resolved lazily, and only when the env alone cannot answer: `npm prefix -g` can stall ~2s cold.
  const envNpmBin = npmGlobalBinDir({ env: process.env, platform, homedir });
  const npmBin = envNpmBin || npmGlobalBinDir({ env: process.env, platform, homedir, resolvedPrefix: resolveNpmGlobalPrefix(execSync) });
  const npmOn = npmBin ? onPath(npmBin, { pathEnv, platform }) : false;
  line('npm global bin', npmBin || '(unknown)');
  line('on PATH', npmBin ? (npmOn ? 'yes' : 'NO') : 'unknown');
  const pnpmBin = pnpmGlobalBinDir({ env: process.env, platform, homedir });
  if (pnpmBin && fs.existsSync(pnpmBin)) {
    line('pnpm global bin', pnpmBin);
    line('on PATH', onPath(pnpmBin, { pathEnv, platform }) ? 'yes' : 'NO');
  }

  console.log('\nAgents');
  // Per-agent binary resolution, so an operator sees which supervised CLIs the Add Session picker
  // will offer and where each one resolves (session/adapters).
  try {
    const { listAgentIds, getAdapter, commandFor } = require('../session/adapters');
    for (const id of listAgentIds()) {
      const adapter = getAdapter(id);
      const resolved = commandFor(adapter);
      const where = resolved?.path ? resolved.path : 'not found on PATH';
      line(`${id} (${adapter.label || id})`, where);
      line(`${id} pack carrier`, adapter.capabilities.packs ? adapter.packCarrier : 'unsupported');
      if (adapter.packNoticeCaveat) line(`${id} pack notices`, adapter.packNoticeCaveat);
    }
    const { inspectGrokAgentSetup } = require('../server/agent-setup-cli');
    const grokSetup = inspectGrokAgentSetup();
    line('grok hook setup', `${grokSetup.classification}: ${grokSetup.filePath}`);
  } catch (err) {
    line('agents', `probe failed: ${(err?.message ? err.message : String(err)).split('\n')[0]}`);
  }

  console.log('\nrtk');
  try {
    const { getRtkPath } = require('../server/rtk-resolver');
    const rtkPath = getRtkPath();
    line('rtk', rtkPath || 'not installed (Glissa installs it when the rtk setting is on)');
  } catch (err) {
    line('rtk', `probe failed: ${(err?.message ? err.message : String(err)).split('\n')[0]}`);
  }

  console.log('\nNative module');
  try {
    require('node-pty');
    line('node-pty', 'loads OK');
  } catch (err) {
    const reason = (err?.message ? err.message : String(err)).split('\n')[0];
    line('node-pty', 'FAILED to load');
    line('reason', reason);
    line('hint', nodePtyRebuildHint(platform));
  }

  console.log('\nConfig');
  line('resolved config', resolveConfigPathReadOnly());

  if (npmBin && !npmOn) {
    console.log(`\n${formatPathNotice({ installedBinDir: npmBin, onPathFlag: false, platform })}`);
  }
}

function resolveNpmGlobalPrefix(exec) {
  try {
    const out = exec('npm prefix -g', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    const prefix = String(out || '').trim();
    if (prefix) return prefix;
  } catch {
    return null;
  }
  return null;
}

// npm 12 blocks rebuild scripts under its allowScripts policy (verified 12.0.2), hence the broad flag in the hint.
function nodePtyRebuildHint(platform) {
  if (platform === 'linux') return 'install build tools: sudo apt install build-essential python3; then rebuild: npm rebuild node-pty --dangerously-allow-all-scripts (the flag is required on npm 12, unknown-but-harmless on older npm)';
  if (platform === 'win32') return 'install Visual Studio Build Tools, then rebuild: npm rebuild node-pty --dangerously-allow-all-scripts (the flag is required on npm 12, unknown-but-harmless on older npm)';
  return 'install the native build tools for this platform, then rebuild: npm rebuild node-pty --dangerously-allow-all-scripts';
}
