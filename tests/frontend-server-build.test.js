'use strict';

// The envelope-version rule (public/server-build-core.ts). A tab left open across a server update
// reconnects to a backend whose frames its bundle may predate; this decides when that is worth a
// reload, and - more importantly - when it is not.

const test = require('node:test');
const assert = require('node:assert/strict');

const importCore = () => import('../public/server-build-core.ts');

test('the first snapshot records the build and never reloads', async () => {
  const { decideReloadOnBuild } = await importCore();
  assert.deepEqual(decideReloadOnBuild(null, '0.22.0+abcd'), { knownBuild: '0.22.0+abcd', reload: false });
});

test('the same build across a reconnect is a no-op', async () => {
  const { decideReloadOnBuild } = await importCore();
  assert.deepEqual(decideReloadOnBuild('0.22.0+abcd', '0.22.0+abcd'), { knownBuild: '0.22.0+abcd', reload: false });
});

test('a changed build reloads once and adopts the new value', async () => {
  const { decideReloadOnBuild } = await importCore();
  const first = decideReloadOnBuild('0.22.0+abcd', '0.23.0+ef01');
  assert.deepEqual(first, { knownBuild: '0.23.0+ef01', reload: true });
  // Adopting it is what keeps a reload loop from forming if the page somehow survives.
  assert.equal(decideReloadOnBuild(first.knownBuild, '0.23.0+ef01').reload, false);
});

// A same-version restart is still a new process with new frames, which is why the stamp carries a
// boot id rather than the package version alone.
test('a restart onto the same version still counts as a new build', async () => {
  const { decideReloadOnBuild } = await importCore();
  assert.equal(decideReloadOnBuild('0.22.0+abcd', '0.22.0+9999').reload, true);
});

test('a snapshot with no build changes nothing', async () => {
  const { decideReloadOnBuild } = await importCore();
  for (const missing of [undefined, null, '', 42, {}]) {
    assert.deepEqual(
      decideReloadOnBuild('0.22.0+abcd', missing),
      { knownBuild: '0.22.0+abcd', reload: false },
      String(missing)
    );
  }
});
