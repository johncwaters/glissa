'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeClientTrust, shouldShowServerAction } = require('../shared/client-trust.ts');

test('normalizeClientTrust: only the literal remote label is remote', () => {
  assert.equal(normalizeClientTrust('remote'), 'remote');
  assert.equal(normalizeClientTrust('local'), 'local');
});

test('normalizeClientTrust: absent or unrecognized trust reads as local', () => {
  assert.equal(normalizeClientTrust(undefined), 'local');
  assert.equal(normalizeClientTrust(null), 'local');
  assert.equal(normalizeClientTrust(''), 'local');
  assert.equal(normalizeClientTrust('REMOTE'), 'local');
  assert.equal(normalizeClientTrust(true), 'local');
});

test('shouldShowServerAction: a local client is offered every action', () => {
  assert.equal(shouldShowServerAction('shutdown', 'local'), true);
  assert.equal(shouldShowServerAction('restart-server', 'local'), true);
  assert.equal(shouldShowServerAction('shutdown', undefined), true);
});

test('shouldShowServerAction: a remote client loses shutdown and keeps restart', () => {
  assert.equal(shouldShowServerAction('shutdown', 'remote'), false);
  assert.equal(shouldShowServerAction('restart-server', 'remote'), true);
  assert.equal(shouldShowServerAction('settings', 'remote'), true);
});
