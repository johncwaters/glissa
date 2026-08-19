#!/usr/bin/env node

'use strict';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: glissa [command] [options]

Commands:
  doctor            Diagnose install / PATH issues and exit
  pair              Mint a single-use pairing link for a remote device
  pair --list       List paired devices
  pair --revoke <id>  Revoke a paired device
  pack build [name] Build one context pack, or every spec
  pack list         List context pack specs and their built versions

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

// Async, so it cannot process.exit inline the way `pair` does; the server boot is skipped instead.
const isPackCommand = args[0] === 'pack';
if (isPackCommand) {
  const { runPackCli } = require('../server/pack-cli');
  runPackCli(args.slice(1)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err?.message || String(err));
      process.exit(1);
    }
  );
}

if (!isPackCommand) {
  require('../server');
}

// Read-only replica of config-store.js resolveConfigPath precedence. Reports the
// path WITHOUT creating or seeding anything (the real resolver has side effects),
// so `glissa doctor` stays safe to run.
function resolveConfigPathReadOnly() {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  if (process.env.GLISSA_CONFIG) {
    const p = path.resolve(process.env.GLISSA_CONFIG);
    return fs.existsSync(p) ? p : `${p} (set via GLISSA_CONFIG, but NOT found)`;
  }
  const localConfig = path.join(__dirname, '..', 'config.json');
  if (fs.existsSync(localConfig)) return localConfig;
  const homeConfig = path.join(os.homedir(), '.glissa', 'config.json');
  if (fs.existsSync(homeConfig)) return homeConfig;
  return `${homeConfig} (created on first run)`;
}

// `glissa doctor`: print a read-only diagnosis of why `glissa` may not be found
// and whether the install is healthy. Must not start the server or throw, so the
// node-pty probe is wrapped and nothing here has side effects.
function runDoctor() {
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
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
  const npmBin = npmGlobalBinDir({ env: process.env, platform, homedir });
  const npmOn = npmBin ? onPath(npmBin, { pathEnv, platform }) : false;
  line('npm global bin', npmBin || '(unknown)');
  line('on PATH', npmBin ? (npmOn ? 'yes' : 'NO') : 'unknown');
  const pnpmBin = pnpmGlobalBinDir({ env: process.env, platform, homedir });
  if (pnpmBin && fs.existsSync(pnpmBin)) {
    line('pnpm global bin', pnpmBin);
    line('on PATH', onPath(pnpmBin, { pathEnv, platform }) ? 'yes' : 'NO');
  }

  console.log('\nNative module');
  try {
    require('node-pty');
    line('node-pty', 'loads OK');
  } catch (err) {
    const reason = (err?.message ? err.message : String(err)).split('\n')[0];
    line('node-pty', 'FAILED to load');
    line('reason', reason);
    line('hint', 'reinstall, or force a rebuild: npm install -g github:johncwaters/glissa --build-from-source');
  }

  console.log('\nConfig');
  line('resolved config', resolveConfigPathReadOnly());

  if (npmBin && !npmOn) {
    console.log(`\n${formatPathNotice({ installedBinDir: npmBin, onPathFlag: false, platform })}`);
  }
}
