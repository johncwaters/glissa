type MergeProofVerdict = 'merged' | 'not-merged' | 'undecidable';
type MergeProofReason =
  | 'ancestor'
  | 'ancestor-probe-failed'
  | 'tree-probe-failed'
  | 'merge-tree-failed'
  | 'tree-contained'
  | 'unmerged-content';
type MergeTreeOutcome = 'tree' | 'conflicts' | 'failed';

type MergeProof = { verdict: MergeProofVerdict; reason: MergeProofReason };

type TipProbe = {
  isAncestor: boolean | null;
  integrationTreeOid: string | null;
  mergeTree: { outcome: MergeTreeOutcome; treeOid: string | null };
};

type GitProbeOutput = { ok: boolean; out?: string };

type MergeProbeEnvResult = { ok: true; probeEnv: Record<string, string> } | { ok: false; err: string };

const MERGE_DRIVER_KEY_PATTERN = '^merge\\..+\\.driver$';
const MERGE_DRIVER_KEY_REGEXP = new RegExp(MERGE_DRIVER_KEY_PATTERN);
const INJECTED_GIT_CONFIG_ENV_REGEXP = /^GIT_CONFIG(?:_COUNT|_KEY_\d+|_VALUE_\d+|_PARAMETERS)?$/;
const MERGE_PROBE_CONFIG_ENTRIES: [string, string][] = [
  ['merge.default', 'text'],
  ['merge.renormalize', 'false'],
  ['merge.union.driver', 'false'],
];

function neutralGitConfigEnv(inheritedEnv: Record<string, string | undefined>, devNullPath: string): Record<string, string> {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(inheritedEnv)) {
    if (value === undefined) continue;
    if (INJECTED_GIT_CONFIG_ENV_REGEXP.test(key)) continue;
    childEnv[key] = value;
  }
  childEnv.GIT_CONFIG_GLOBAL = devNullPath;
  childEnv.GIT_CONFIG_SYSTEM = devNullPath;
  childEnv.GIT_CONFIG_NOSYSTEM = '1';
  return childEnv;
}

function mergeDriverKeys(configuredKeysOutput: string): string[] {
  const keys: string[] = [];
  for (const line of configuredKeysOutput.split(/\r?\n/)) {
    const key = line.trim();
    if (!MERGE_DRIVER_KEY_REGEXP.test(key)) continue;
    if (keys.includes(key)) continue;
    keys.push(key);
  }
  return keys;
}

function safeDirectoryEntries(safeDirectoryOutput: string): [string, string][] {
  const entries: [string, string][] = [];
  for (const line of safeDirectoryOutput.split(/\r?\n/)) {
    const directory = line.trim();
    if (!directory) continue;
    entries.push(['safe.directory', directory]);
  }
  return entries;
}

function numberedGitConfigEnv(neutralEnv: Record<string, string>, overrides: [string, string][]): Record<string, string> {
  const childEnv: Record<string, string> = { ...neutralEnv, GIT_CONFIG_COUNT: String(overrides.length) };
  for (const [index, [key, value]] of overrides.entries()) {
    childEnv[`GIT_CONFIG_KEY_${index}`] = key;
    childEnv[`GIT_CONFIG_VALUE_${index}`] = value;
  }
  return childEnv;
}

function driverEnumerationEnv({ neutralEnv, safeDirectoryOutput }: {
  neutralEnv: Record<string, string>;
  safeDirectoryOutput: string;
}): Record<string, string> {
  return numberedGitConfigEnv(neutralEnv, safeDirectoryEntries(safeDirectoryOutput));
}

function mergeProbeEnv({ neutralEnv, safeDirectoryOutput, configuredKeysOutput }: {
  neutralEnv: Record<string, string>;
  safeDirectoryOutput: string;
  configuredKeysOutput: string;
}): Record<string, string> {
  return numberedGitConfigEnv(neutralEnv, [
    ...safeDirectoryEntries(safeDirectoryOutput),
    ...MERGE_PROBE_CONFIG_ENTRIES,
    ...mergeDriverKeys(configuredKeysOutput).map((key): [string, string] => [key, 'false']),
  ]);
}

function ancestryFromResult(result: { ok: boolean; isAncestor?: boolean }): boolean | null {
  if (!result.ok) return null;
  return result.isAncestor === true;
}

function parseTreeOid(out: string): string | null {
  const firstLine = out.split(/\r?\n/).find((line) => line.trim());
  if (!firstLine) return null;
  const treeOid = firstLine.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(treeOid)) return null;
  return treeOid;
}

function buildTipProbe({ isAncestor, integrationTree, mergeTree }: {
  isAncestor: boolean | null;
  integrationTree: GitProbeOutput;
  mergeTree: GitProbeOutput & { outcome: MergeTreeOutcome };
}): TipProbe {
  return {
    isAncestor,
    integrationTreeOid: integrationTree.ok ? parseTreeOid(integrationTree.out ?? '') : null,
    mergeTree: {
      outcome: mergeTree.outcome,
      treeOid: mergeTree.outcome === 'tree' ? parseTreeOid(mergeTree.out ?? '') : null,
    },
  };
}

function ancestorProvenProbe(): TipProbe {
  return { isAncestor: true, integrationTreeOid: null, mergeTree: { outcome: 'failed', treeOid: null } };
}

function proveMerged(probe: TipProbe): MergeProof {
  if (probe.isAncestor === true) return { verdict: 'merged', reason: 'ancestor' };
  if (probe.isAncestor === null) return { verdict: 'undecidable', reason: 'ancestor-probe-failed' };
  if (probe.integrationTreeOid === null) return { verdict: 'undecidable', reason: 'tree-probe-failed' };
  if (probe.mergeTree.outcome === 'failed') return { verdict: 'undecidable', reason: 'merge-tree-failed' };
  if (probe.mergeTree.outcome === 'conflicts') return { verdict: 'not-merged', reason: 'unmerged-content' };
  if (probe.mergeTree.treeOid === null) return { verdict: 'undecidable', reason: 'merge-tree-failed' };
  if (probe.mergeTree.treeOid === probe.integrationTreeOid) return { verdict: 'merged', reason: 'tree-contained' };
  return { verdict: 'not-merged', reason: 'unmerged-content' };
}

function proveMergedAcrossTips(probes: TipProbe[]): MergeProof {
  let mostCautiousProof: MergeProof = { verdict: 'not-merged', reason: 'unmerged-content' };
  for (const probe of probes) {
    const proof = proveMerged(probe);
    if (proof.verdict === 'merged') return proof;
    if (proof.verdict === 'undecidable') mostCautiousProof = proof;
  }
  return mostCautiousProof;
}

export {
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
};
export type { GitProbeOutput, MergeProbeEnvResult, MergeProof, MergeProofReason, MergeProofVerdict, MergeTreeOutcome, TipProbe };
