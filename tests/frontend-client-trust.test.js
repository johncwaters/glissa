'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cjs = require('../shared/client-trust');

const importEsm = () => import('../shared/client-trust.esm.mjs');

test('normalizeClientTrust: only the literal remote label is remote', async () => {
  const { normalizeClientTrust } = await importEsm();
  assert.equal(normalizeClientTrust('remote'), 'remote');
  assert.equal(normalizeClientTrust('local'), 'local');
});

test('normalizeClientTrust: absent or unrecognized trust reads as local', async () => {
  const { normalizeClientTrust } = await importEsm();
  assert.equal(normalizeClientTrust(undefined), 'local');
  assert.equal(normalizeClientTrust(null), 'local');
  assert.equal(normalizeClientTrust(''), 'local');
  assert.equal(normalizeClientTrust('REMOTE'), 'local');
  assert.equal(normalizeClientTrust(true), 'local');
});

// The twins hand-duplicate normalizeClientTrust, and the header comment in each file claims they stay
// identical. Nothing but this locks that claim down: a server that labels a connection differently
// from how the browser reads the label is exactly the drift the shared/ pair exists to prevent.
test('normalizeClientTrust: the CJS and ESM twins agree on every input', async () => {
  const esm = await importEsm();
  for (const input of ['remote', 'local', 'REMOTE', 'Remote', '', 'anything-else', undefined, null, true, 0, {}]) {
    assert.equal(esm.normalizeClientTrust(input), cjs.normalizeClientTrust(input), `input: ${String(input)}`);
  }
});

// The CJS twin is deliberately narrower: the server only labels a connection, it never decides which
// actions to offer. Pinned so a future edit does not quietly widen it and re-create the duplication
// this pair was extracted to remove.
test('the CJS twin exports only the normalizer', () => {
  assert.deepEqual(Object.keys(cjs).sort(), ['normalizeClientTrust']);
});

test('shouldShowServerAction: a local client is offered every action', async () => {
  const { shouldShowServerAction } = await importEsm();
  assert.equal(shouldShowServerAction('shutdown', 'local'), true);
  assert.equal(shouldShowServerAction('restart-server', 'local'), true);
  assert.equal(shouldShowServerAction('shutdown', undefined), true);
});

test('shouldShowServerAction: a remote client loses shutdown and keeps restart', async () => {
  const { shouldShowServerAction } = await importEsm();
  assert.equal(shouldShowServerAction('shutdown', 'remote'), false);
  assert.equal(shouldShowServerAction('restart-server', 'remote'), true);
  assert.equal(shouldShowServerAction('settings', 'remote'), true);
});
