#!/usr/bin/env node

'use strict';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: glissa [options]

Options:
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

require('../server');
