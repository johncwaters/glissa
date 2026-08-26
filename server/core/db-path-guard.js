'use strict';

/*
 * The pure rule behind the one refusal server/glissa-db.js makes: under `node --test`, a database
 * resolving under the operator's home directory is never the intended target. A suite that reached the
 * real config wrote 42 fixture records into the live memory store before this existed (audit 2026-08-25).
 */

const path = require('node:path');

const HOME_DB_REFUSED_CODE = 'GLISSA_HOME_DB_REFUSED';
const HOME_DB_REFUSED_NAME = 'GlissaHomeDbRefusedError';

function isUnder(child, parent) {
  if (typeof child !== 'string' || typeof parent !== 'string' || !child || !parent) return false;
  const from = path.resolve(parent);
  const to = path.resolve(child);
  const relative = path.relative(from, to);
  if (relative === '') return true;
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  return true;
}

function underTestRunner(env) {
  const marker = env ? env.NODE_TEST_CONTEXT : undefined;
  return typeof marker === 'string' && marker !== '';
}

/**
 * @returns {string|null} the refusal message, or null when the open may proceed.
 */
function decideDbOpenRefusal({ dbPath, homeDir, tmpDir, isTestRunner }) {
  if (!isTestRunner) return null;
  if (!isUnder(dbPath, homeDir)) return null;
  // A Windows runner's %TEMP% sits under the home directory, so every temp fixture would be refused.
  if (isUnder(dbPath, tmpDir)) return null;
  return `refusing to open a database under the home directory while running under the node test runner: ${dbPath}`;
}

function homeDbRefusedError(message) {
  const error = new Error(message);
  error.name = HOME_DB_REFUSED_NAME;
  error.code = HOME_DB_REFUSED_CODE;
  return error;
}

module.exports = {
  HOME_DB_REFUSED_CODE,
  HOME_DB_REFUSED_NAME,
  decideDbOpenRefusal,
  homeDbRefusedError,
  isUnder,
  underTestRunner,
};
