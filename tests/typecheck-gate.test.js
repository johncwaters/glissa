'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CHECKED_INCLUDE_GLOBS = [
  'server/core/**/*.js',
  'server/backend-websockets.js',
  'server/backend-health.js',
  'server/backend-shutdown.js',
  'server/session-registry.js',
  'session/core/snapshot-projection.js',
  'session/core/worktree-state.js',
  'shared/contracts/**/*.js',
  'shared/*.js',
  'shared/**/*.d.ts',
];

test('typecheck gate retains its checked file globs', () => {
  const tsconfigPath = path.join(__dirname, '..', 'tsconfig.json');
  const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));
  assert.deepEqual(tsconfig.include, CHECKED_INCLUDE_GLOBS);
});
