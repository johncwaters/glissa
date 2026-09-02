import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BRANCH_FALLBACKS,
  configuredIntegrationBranch,
  decideMarkerBase,
  defaultBranchFromRemoteHead,
  markerProbeCommands,
} from '../server/core/integration-branch-core.ts';

const absorbedMarker = {
  marker: 'develop',
  detectedDefaultBranch: 'main',
  resolvedMarkerRef: 'refs/heads/develop',
  isMarkerRefResolvable: true,
  isMarkerAbsorbedByDefault: true,
};

test('configuredIntegrationBranch returns a configured branch name', () => {
  assert.equal(configuredIntegrationBranch({ integrationBranch: 'release' }), 'release');
});

test('configuredIntegrationBranch returns null for auto values', () => {
  assert.equal(configuredIntegrationBranch({ integrationBranch: null }), null);
  assert.equal(configuredIntegrationBranch({ integrationBranch: '' }), null);
  assert.equal(configuredIntegrationBranch({}), null);
});

test('defaultBranchFromRemoteHead reads the branch out of the origin HEAD ref', () => {
  assert.equal(defaultBranchFromRemoteHead('origin/trunk'), 'trunk');
  assert.equal(defaultBranchFromRemoteHead('origin/'), null);
  assert.equal(defaultBranchFromRemoteHead('trunk'), null);
  assert.equal(defaultBranchFromRemoteHead(''), null);
});

test('the default branch fallbacks stay ordered main before master', () => {
  assert.deepEqual([...DEFAULT_BRANCH_FALLBACKS], ['main', 'master']);
});

test('decideMarkerBase without a marker falls back to the configured branch, then the caller base', () => {
  const unprobed = { detectedDefaultBranch: null, resolvedMarkerRef: null, isMarkerRefResolvable: null, isMarkerAbsorbedByDefault: null };
  assert.deepEqual(
    decideMarkerBase({ marker: null, fallbackBase: 'release', configuredIntegrationBranch: 'staging', ...unprobed }),
    { base: 'staging', migrateTo: null, measureRef: null },
  );
  assert.deepEqual(
    decideMarkerBase({ marker: null, fallbackBase: 'release', configuredIntegrationBranch: null, ...unprobed }),
    { base: 'release', migrateTo: null, measureRef: null },
  );
  assert.deepEqual(
    decideMarkerBase({ marker: null, ...unprobed }),
    { base: null, migrateTo: null, measureRef: null },
  );
});

test('decideMarkerBase keeps the marker untouched whenever a branch is configured', () => {
  assert.deepEqual(
    decideMarkerBase({ ...absorbedMarker, fallbackBase: 'release', configuredIntegrationBranch: 'staging' }),
    { base: 'develop', migrateTo: null, measureRef: null },
  );
});

test('decideMarkerBase keeps the marker when no default is detected or the default is the marker', () => {
  assert.deepEqual(
    decideMarkerBase({ ...absorbedMarker, detectedDefaultBranch: null }),
    { base: 'develop', migrateTo: null, measureRef: null },
  );
  assert.deepEqual(
    decideMarkerBase({ ...absorbedMarker, marker: 'main' }),
    { base: 'main', migrateTo: null, measureRef: null },
  );
});

test('decideMarkerBase migrates an unconfigured marker the default absorbed', () => {
  assert.deepEqual(decideMarkerBase(absorbedMarker), { base: 'main', migrateTo: 'main', measureRef: null });
});

test('decideMarkerBase migrates an unconfigured marker whose ref no longer resolves', () => {
  assert.deepEqual(
    decideMarkerBase({ ...absorbedMarker, isMarkerRefResolvable: false, isMarkerAbsorbedByDefault: null }),
    { base: 'main', migrateTo: 'main', measureRef: null },
  );
});

test('decideMarkerBase keeps a live marker holding commits the default lacks', () => {
  assert.deepEqual(
    decideMarkerBase({ ...absorbedMarker, isMarkerAbsorbedByDefault: false }),
    { base: 'develop', migrateTo: null, measureRef: 'refs/heads/develop' },
  );
});

test('decideMarkerBase keeps the marker when the probes never ran', () => {
  assert.deepEqual(
    decideMarkerBase({ ...absorbedMarker, isMarkerRefResolvable: null, isMarkerAbsorbedByDefault: null }),
    { base: 'develop', migrateTo: null, measureRef: 'refs/heads/develop' },
  );
});

test('decideMarkerBase names a kept marker plainly and measures it against the ref that resolved', () => {
  assert.deepEqual(
    decideMarkerBase({
      ...absorbedMarker,
      resolvedMarkerRef: 'refs/remotes/origin/develop',
      isMarkerAbsorbedByDefault: false,
    }),
    { base: 'develop', migrateTo: null, measureRef: 'refs/remotes/origin/develop' },
  );
});

test('decideMarkerBase offers no ref to measure against when no probe ran or when it migrates', () => {
  assert.deepEqual(
    decideMarkerBase({ ...absorbedMarker, resolvedMarkerRef: null, isMarkerAbsorbedByDefault: false }),
    { base: 'develop', migrateTo: null, measureRef: null },
  );
  assert.deepEqual(
    decideMarkerBase({ ...absorbedMarker }),
    { base: 'main', migrateTo: 'main', measureRef: null },
  );
});

test('markerProbeCommands offers the local marker ref before the origin copy', () => {
  const plan = markerProbeCommands({ marker: 'staging', detectedDefaultBranch: 'main' });
  assert.deepEqual(plan?.markerRefCandidates, [
    { ref: 'refs/heads/staging', argv: ['rev-parse', '--verify', '--quiet', 'refs/heads/staging'] },
    { ref: 'refs/remotes/origin/staging', argv: ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/staging'] },
  ]);
});

test('markerProbeCommands asks whether the default absorbed whichever ref resolved', () => {
  const plan = markerProbeCommands({ marker: 'staging', detectedDefaultBranch: 'main' });
  assert.deepEqual(plan?.absorbedByDefault('refs/remotes/origin/staging'), ['merge-base', '--is-ancestor', 'refs/remotes/origin/staging', 'main']);
});

test('markerProbeCommands plans nothing without a marker, without a default, or when they match', () => {
  assert.equal(markerProbeCommands({ marker: null, detectedDefaultBranch: 'main' }), null);
  assert.equal(markerProbeCommands({ marker: 'staging', detectedDefaultBranch: null }), null);
  assert.equal(markerProbeCommands({ marker: 'main', detectedDefaultBranch: 'main' }), null);
});
