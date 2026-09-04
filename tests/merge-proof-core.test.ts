import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MERGE_DRIVER_KEY_PATTERN,
  ancestorProvenProbe,
  ancestryFromResult,
  buildTipProbe,
  driverEnumerationEnv,
  mergeProbeEnv,
  neutralGitConfigEnv,
  parseTreeOid,
  proveMerged,
  proveMergedAcrossTips,
  safeDirectoryEntries,
} from '../server/core/merge-proof-core.ts';
import type { TipProbe } from '../server/core/merge-proof-core.ts';

const SHA1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA256 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const DEV_NULL = '/dev/null';

function numberedOverrides(childEnv: Record<string, string>): [string, string][] {
  const overrides: [string, string][] = [];
  for (let index = 0; index < Number(childEnv.GIT_CONFIG_COUNT); index += 1) {
    overrides.push([childEnv[`GIT_CONFIG_KEY_${index}`], childEnv[`GIT_CONFIG_VALUE_${index}`]]);
  }
  return overrides;
}

function probeEnvOverrides(configuredKeysOutput: string, safeDirectoryOutput = ''): [string, string][] {
  return numberedOverrides(mergeProbeEnv({
    neutralEnv: neutralGitConfigEnv({}, DEV_NULL),
    safeDirectoryOutput,
    configuredKeysOutput,
  }));
}

function probe(overrides: Partial<TipProbe>): TipProbe {
  return {
    isAncestor: false,
    integrationTreeOid: SHA1,
    mergeTree: { outcome: 'tree', treeOid: SHA1 },
    ...overrides,
  };
}

test('neutralGitConfigEnv drops every inherited git config injection variable', () => {
  const childEnv = neutralGitConfigEnv({
    PATH: '/usr/bin',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'merge.ours.driver',
    GIT_CONFIG_VALUE_0: 'true',
    GIT_CONFIG_KEY_11: 'merge.theirs.driver',
    GIT_CONFIG_VALUE_11: 'true',
    GIT_CONFIG_PARAMETERS: "'merge.ours.driver=true'",
    GIT_CONFIG: '/tmp/attacker.config',
    GIT_CONFIG_UNRELATED: 'kept',
    UNSET: undefined,
  }, DEV_NULL);

  assert.deepEqual(childEnv, {
    PATH: '/usr/bin',
    GIT_CONFIG_UNRELATED: 'kept',
    GIT_CONFIG_GLOBAL: DEV_NULL,
    GIT_CONFIG_SYSTEM: DEV_NULL,
    GIT_CONFIG_NOSYSTEM: '1',
  });
});

test('mergeProbeEnv neutralizes text merging, renormalization and the built in union driver when no driver is configured', () => {
  assert.deepEqual(probeEnvOverrides(''), [
    ['merge.default', 'text'],
    ['merge.renormalize', 'false'],
    ['merge.union.driver', 'false'],
  ]);
});

test('mergeProbeEnv replays every inherited safe directory ahead of the merge overrides', () => {
  assert.deepEqual(probeEnvOverrides('', '/srv/one\r\n/srv/two with spaces\n\n'), [
    ['safe.directory', '/srv/one'],
    ['safe.directory', '/srv/two with spaces'],
    ['merge.default', 'text'],
    ['merge.renormalize', 'false'],
    ['merge.union.driver', 'false'],
  ]);
});

test('driverEnumerationEnv carries the safe directory list and no merge override', () => {
  assert.deepEqual(numberedOverrides(driverEnumerationEnv({
    neutralEnv: neutralGitConfigEnv({}, DEV_NULL),
    safeDirectoryOutput: '/srv/one\n',
  })), [['safe.directory', '/srv/one']]);
});

test('safeDirectoryEntries skips blank lines and keeps every configured value', () => {
  assert.deepEqual(safeDirectoryEntries(''), []);
  assert.deepEqual(safeDirectoryEntries('*\n'), [['safe.directory', '*']]);
});

test('mergeProbeEnv disables every enumerated driver across CRLF output and dotted subsection names', () => {
  assert.deepEqual(probeEnvOverrides('merge.ours.driver\r\nmerge.my.custom.driver\r\nnotamergekey\r\n\r\n'), [
    ['merge.default', 'text'],
    ['merge.renormalize', 'false'],
    ['merge.union.driver', 'false'],
    ['merge.ours.driver', 'false'],
    ['merge.my.custom.driver', 'false'],
  ]);
});

test('mergeProbeEnv keeps a driver name containing an equals sign intact', () => {
  assert.deepEqual(probeEnvOverrides('merge.ours=theirs.driver\n'), [
    ['merge.default', 'text'],
    ['merge.renormalize', 'false'],
    ['merge.union.driver', 'false'],
    ['merge.ours=theirs.driver', 'false'],
  ]);
});

test('mergeProbeEnv counts each override once when a driver key repeats', () => {
  const childEnv = mergeProbeEnv({
    neutralEnv: neutralGitConfigEnv({}, DEV_NULL),
    safeDirectoryOutput: '',
    configuredKeysOutput: 'merge.ours.driver\nmerge.ours.driver\n',
  });

  assert.equal(childEnv.GIT_CONFIG_COUNT, '4');
  assert.equal(childEnv.GIT_CONFIG_KEY_3, 'merge.ours.driver');
  assert.equal(childEnv.GIT_CONFIG_VALUE_3, 'false');
});

test('the merge driver key pattern matches driver keys and nothing else', () => {
  const pattern = new RegExp(MERGE_DRIVER_KEY_PATTERN);

  assert.equal(pattern.test('merge.ours.driver'), true);
  assert.equal(pattern.test('merge.my.custom.driver'), true);
  assert.equal(pattern.test('merge.driver'), false);
  assert.equal(pattern.test('merge.ours.name'), false);
});

test('ancestorProvenProbe builds the only probe an ancestry proof needs', () => {
  assert.deepEqual(ancestorProvenProbe(), {
    isAncestor: true,
    integrationTreeOid: null,
    mergeTree: { outcome: 'failed', treeOid: null },
  });
  assert.deepEqual(proveMerged(ancestorProvenProbe()), { verdict: 'merged', reason: 'ancestor' });
});

test('ancestryFromResult reports an unusable probe as unknown rather than as not an ancestor', () => {
  assert.equal(ancestryFromResult({ ok: false }), null);
  assert.equal(ancestryFromResult({ ok: false, isAncestor: true }), null);
  assert.equal(ancestryFromResult({ ok: true, isAncestor: true }), true);
  assert.equal(ancestryFromResult({ ok: true, isAncestor: false }), false);
  assert.equal(ancestryFromResult({ ok: true }), false);
});

test('buildTipProbe parses both oids only from usable git output', () => {
  assert.deepEqual(buildTipProbe({
    isAncestor: false,
    integrationTree: { ok: true, out: `${SHA1}\n` },
    mergeTree: { ok: true, out: `${SHA256}\n`, outcome: 'tree' },
  }), {
    isAncestor: false,
    integrationTreeOid: SHA1,
    mergeTree: { outcome: 'tree', treeOid: SHA256 },
  });
  assert.deepEqual(buildTipProbe({
    isAncestor: null,
    integrationTree: { ok: false, out: SHA1 },
    mergeTree: { ok: false, out: SHA1, outcome: 'conflicts' },
  }), {
    isAncestor: null,
    integrationTreeOid: null,
    mergeTree: { outcome: 'conflicts', treeOid: null },
  });
});

test('parseTreeOid accepts sha1 and sha256 tree oids', () => {
  assert.equal(parseTreeOid(SHA1), SHA1);
  assert.equal(parseTreeOid(SHA256), SHA256);
});

test('parseTreeOid skips leading blank lines', () => {
  assert.equal(parseTreeOid(`\n\r\n${SHA1}\nextra`), SHA1);
});

test('parseTreeOid rejects garbage and empty output', () => {
  assert.equal(parseTreeOid('not-a-tree'), null);
  assert.equal(parseTreeOid(''), null);
});

test('proveMerged applies its failure guards before deciding a tip', () => {
  assert.deepEqual(proveMerged(probe({ isAncestor: true, integrationTreeOid: null, mergeTree: { outcome: 'failed', treeOid: null } })), { verdict: 'merged', reason: 'ancestor' });
  assert.deepEqual(proveMerged(probe({ isAncestor: null })), { verdict: 'undecidable', reason: 'ancestor-probe-failed' });
  assert.deepEqual(proveMerged(probe({ integrationTreeOid: null })), { verdict: 'undecidable', reason: 'tree-probe-failed' });
  assert.deepEqual(proveMerged(probe({ mergeTree: { outcome: 'failed', treeOid: null } })), { verdict: 'undecidable', reason: 'merge-tree-failed' });
  assert.deepEqual(proveMerged(probe({ mergeTree: { outcome: 'tree', treeOid: null } })), { verdict: 'undecidable', reason: 'merge-tree-failed' });
});

test('proveMerged separates a conflicting merge from a failed merge probe', () => {
  assert.deepEqual(proveMerged(probe({ mergeTree: { outcome: 'conflicts', treeOid: null } })), { verdict: 'not-merged', reason: 'unmerged-content' });
  assert.deepEqual(proveMerged(probe({ mergeTree: { outcome: 'failed', treeOid: null } })), { verdict: 'undecidable', reason: 'merge-tree-failed' });
});

test('proveMerged reads a matching written tree as containment and a differing one as unmerged', () => {
  assert.deepEqual(proveMerged(probe({})), { verdict: 'merged', reason: 'tree-contained' });
  assert.deepEqual(proveMerged(probe({ integrationTreeOid: SHA256 })), { verdict: 'not-merged', reason: 'unmerged-content' });
});

test('proveMergedAcrossTips returns the first merged tip', () => {
  const proof = proveMergedAcrossTips([
    probe({ integrationTreeOid: SHA256 }),
    probe({ isAncestor: true }),
    probe({ mergeTree: { outcome: 'failed', treeOid: null } }),
  ]);

  assert.deepEqual(proof, { verdict: 'merged', reason: 'ancestor' });
});

test('proveMergedAcrossTips prefers an undecidable tip over a not-merged one', () => {
  const proof = proveMergedAcrossTips([
    probe({ integrationTreeOid: SHA256 }),
    probe({ mergeTree: { outcome: 'failed', treeOid: null } }),
  ]);

  assert.deepEqual(proof, { verdict: 'undecidable', reason: 'merge-tree-failed' });
});

test('proveMergedAcrossTips reports not merged when every tip conflicts', () => {
  const proof = proveMergedAcrossTips([
    probe({ mergeTree: { outcome: 'conflicts', treeOid: null } }),
    probe({ integrationTreeOid: SHA256 }),
  ]);

  assert.deepEqual(proof, { verdict: 'not-merged', reason: 'unmerged-content' });
});

test('proveMergedAcrossTips reports not merged when there are no tips to probe', () => {
  assert.deepEqual(proveMergedAcrossTips([]), { verdict: 'not-merged', reason: 'unmerged-content' });
});
