'use strict';

const fs = require('node:fs');
const os = require('node:os');

const { resolveRtkPath } = require('../session/core/rtk-command.ts');
const { execSync } = require('./child-process-safe');

function resolveRtkPathFromSystem() {
  return resolveRtkPath({
    homeDir: os.homedir(),
    platform: process.platform,
    exec: execSync,
    fsApi: fs,
  });
}

/** @type {string|null} */
let cachedRtkPath = null;

function getRtkPath(resolve = resolveRtkPathFromSystem) {
  if (!cachedRtkPath) cachedRtkPath = resolve();
  return cachedRtkPath;
}

function resetRtkPathCache() {
  cachedRtkPath = null;
}

module.exports = { getRtkPath, resetRtkPathCache };
