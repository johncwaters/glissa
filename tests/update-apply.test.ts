import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { decideUpdateStatus } from '../server/core/update-core.ts';
import { createUpdateApplyLane } from '../server/update-apply.ts';
import type {
  UpdateApplyDependencies,
  UpdateFileSystem,
  UpdateGitWorkspace,
} from '../server/update-apply.ts';
import type { UpdateStatus } from '../server/backend-update.ts';
import type { UpdateJournal } from '../shared/contracts/update-journal.ts';

const ROOT = '/repo/glissa';
const UPDATE_PATH = `${ROOT}/.glissa/update`;
const STAGING_PATH = `${UPDATE_PATH}/next`;
const JOURNAL_PATH = '/home/test/.glissa/update-journal.json';
const HEAD_SHA = '1'.repeat(40);
const TARGET_SHA = '2'.repeat(40);

interface FakeFileSystem {
  api: UpdateFileSystem;
  entries: Set<string>;
  files: Map<string, string>;
  artifactRenames: Array<{ from: string; to: string }>;
  failArtifactRenameAt: number | null;
  failReversalContaining: string | null;
  failJournalWrites: boolean;
  failRestoreMarkerWrite: boolean;
  slowReads: boolean;
}

function makeFakeFileSystem(): FakeFileSystem {
  const entries = new Set([`${ROOT}/dist`, `${ROOT}/node_modules`]);
  const files = new Map<string, string>();
  const artifactRenames: Array<{ from: string; to: string }> = [];
  const state: Omit<FakeFileSystem, 'api'> = {
    entries,
    files,
    artifactRenames,
    failArtifactRenameAt: null,
    failReversalContaining: null,
    failJournalWrites: false,
    failRestoreMarkerWrite: false,
    slowReads: false,
  };

  function removePath(candidatePath: string): void {
    entries.delete(candidatePath);
    files.delete(candidatePath);
    for (const entry of [...entries]) {
      if (entry.startsWith(`${candidatePath}/`)) entries.delete(entry);
    }
    for (const filePath of [...files.keys()]) {
      if (filePath.startsWith(`${candidatePath}/`)) files.delete(filePath);
    }
  }

  async function rename(fromValue: unknown, toValue: unknown): Promise<void> {
    const from = String(fromValue);
    const to = String(toValue);
    if (from.includes('.tmp.')) {
      const content = files.get(from);
      if (content === undefined) throw new Error(`missing ${from}`);
      files.delete(from);
      files.set(to, content);
      return;
    }
    const renameIndex = artifactRenames.length;
    artifactRenames.push({ from, to });
    if (state.failArtifactRenameAt === renameIndex) throw new Error(`rename ${renameIndex} failed`);
    const failedForwardIndex = state.failArtifactRenameAt ?? Number.POSITIVE_INFINITY;
    if (renameIndex > failedForwardIndex && state.failReversalContaining && `${from}->${to}`.includes(state.failReversalContaining)) {
      state.failReversalContaining = null;
      throw new Error('reversal failed');
    }
    if (!entries.has(from)) throw new Error(`missing ${from}`);
    entries.delete(from);
    entries.add(to);
  }

  const fakeMethods = {
    appendFile: async () => {},
    mkdir: async () => undefined,
    readFile: async (filePath: unknown) => {
      if (state.slowReads) await new Promise((resolve) => setTimeout(resolve, 5));
      const content = files.get(String(filePath));
      if (content !== undefined) return content;
      const error = new Error(`missing ${String(filePath)}`) as Error & { code: string };
      error.code = 'ENOENT';
      throw error;
    },
    rename,
    rm: async (filePath: unknown) => { removePath(String(filePath)); },
    symlink: async (_target: unknown, filePath: unknown) => {
      const resolvedPath = String(filePath);
      if (entries.has(resolvedPath)) throw new Error(`exists ${resolvedPath}`);
      entries.add(resolvedPath);
    },
    writeFile: async (filePath: unknown, content: unknown) => {
      if (state.failJournalWrites && String(filePath).includes('.tmp.')) throw new Error('journal unavailable');
      if (state.failRestoreMarkerWrite && String(filePath).endsWith('restore.json')) throw new Error('marker unavailable');
      files.set(String(filePath), String(content));
    },
  };
  const api: UpdateFileSystem = new Proxy(fs.promises, {
    get(_target, property) {
      return Reflect.get(fakeMethods, property);
    },
  });
  return Object.assign(state, { api });
}

interface HarnessOptions {
  hasStatus?: boolean;
  channel?: 'release' | 'main';
  statusChannel?: 'release' | 'main';
  flavor?: 'clone' | 'npm-global' | 'unknown';
  platform?: NodeJS.Platform;
  dirty?: boolean;
  branch?: string | null;
  upstream?: string | null;
  statusBranch?: string | null;
  statusUpstream?: string | null;
  canFastForward?: boolean;
  lockfileChanged?: boolean;
  failStep?: 'fetch' | 'stage' | 'install' | 'build';
  mergeMovedHead?: boolean;
  targetSha?: string | null;
  journal?: UpdateJournal | string;
}

interface QueueAdmission {
  refuseProbe: boolean;
  refuseRemoval: boolean;
}

interface ApplyHarness {
  lane: ReturnType<typeof createUpdateApplyLane>;
  fileSystem: FakeFileSystem;
  admission: QueueAdmission;
  commands: Array<{ file: string; args: string[]; cwd: string; timeout: number }>;
  removals: string[];
  resets: Array<{ expectedHead: string; sha: string }>;
  broadcasts: Record<string, unknown>[];
  events: string[];
  head: () => string;
}

function makeStatus(options: HarnessOptions): UpdateStatus {
  const channel = options.statusChannel || options.channel || 'release';
  return {
    ...decideUpdateStatus({
      installedSha: HEAD_SHA,
      latestSha: options.targetSha === undefined ? TARGET_SHA : options.targetSha,
      currentVersion: '0.24.0',
      latestVersion: '0.25.0',
      flavor: options.flavor || 'clone',
      channel,
      behindCount: channel === 'main' ? 1 : null,
    }),
    platform: 'linux',
    installedBranch: options.statusBranch === undefined ? 'main' : options.statusBranch,
    upstream: options.statusUpstream === undefined ? 'origin/main' : options.statusUpstream,
    isTreeClean: true,
    lastCheckAt: 1000,
    journalSummary: null,
    applyRefusal: null,
  };
}

function makeHarness(options: HarnessOptions = {}): ApplyHarness {
  const fileSystem = makeFakeFileSystem();
  const commands: Array<{ file: string; args: string[]; cwd: string; timeout: number }> = [];
  const removals: string[] = [];
  const resets: Array<{ expectedHead: string; sha: string }> = [];
  const broadcasts: Record<string, unknown>[] = [];
  const events: string[] = [];
  const admission: QueueAdmission = { refuseProbe: false, refuseRemoval: false };
  let liveHead = HEAD_SHA;
  let clockValue = 1000;
  if (options.journal !== undefined) {
    fileSystem.files.set(
      JOURNAL_PATH,
      typeof options.journal === 'string' ? options.journal : JSON.stringify(options.journal),
    );
  }
  const gitWorkspace: UpdateGitWorkspace = {
    fetchOrigin: async () => {
      events.push('fetch');
      if (options.failStep === 'fetch') return { ok: false, out: '', err: 'fetch failed' };
      return { ok: true, out: 'fetched' };
    },
    stageDetachedWorktree: async () => {
      events.push('stage');
      if (options.failStep === 'stage') return { ok: false, out: '', err: 'stage failed' };
      fileSystem.entries.add(`${STAGING_PATH}/dist`);
      return { ok: true, out: 'staged' };
    },
    removeWorktreeByPath: async ({ cwd }) => {
      if (admission.refuseRemoval) {
        events.push('remove-refused');
        return { ok: false, out: '', err: 'the git queue did not admit the worktree removal', admissionRefused: true };
      }
      events.push('remove');
      removals.push(cwd || '');
      for (const entry of [...fileSystem.entries]) {
        if (entry === cwd || entry.startsWith(`${cwd}/`)) fileSystem.entries.delete(entry);
      }
      return { ok: true, out: '' };
    },
    probeWorktreeDirty: async () => {
      if (admission.refuseProbe) {
        return { ok: false, dirty: true, headSha: null, err: 'the git queue did not admit the probe', admissionRefused: true };
      }
      return { ok: true, dirty: options.dirty === true, headSha: liveHead };
    },
    mergeFastForwardTo: async () => {
      const sampledHead = options.mergeMovedHead === false ? TARGET_SHA : liveHead;
      liveHead = TARGET_SHA;
      return { ok: true, out: '', sampledHead, outcome: 'merged' };
    },
    resetKeepTo: async ({ expectedHead, sha }) => {
      resets.push({ expectedHead: expectedHead || '', sha: sha || '' });
      if (expectedHead !== liveHead) return { ok: false, out: '', err: 'HEAD changed' };
      liveHead = sha || liveHead;
      return { ok: true, out: '' };
    },
  };
  const runCommand: NonNullable<UpdateApplyDependencies['runCommand']> = async (file, ...rest) => {
    const args = Array.isArray(rest[0]) ? rest[0].map(String) : [];
    const commandOptions = rest[1] && typeof rest[1] === 'object' ? rest[1] as Record<string, unknown> : {};
    const cwd = String(commandOptions.cwd || ROOT);
    const timeout = Number(commandOptions.timeout || 0);
    commands.push({ file, args, cwd, timeout });
    const joined = args.join(' ');
    if (file === 'git' && joined === 'rev-parse --abbrev-ref HEAD') {
      if (options.branch === null) return { stdout: 'HEAD\n', stderr: '' };
      return { stdout: `${options.branch || 'main'}\n`, stderr: '' };
    }
    if (file === 'git' && joined === 'rev-parse --abbrev-ref @{upstream}') {
      if (options.upstream === null) throw new Error('no upstream');
      return { stdout: `${options.upstream || 'origin/main'}\n`, stderr: '' };
    }
    if (file === 'git' && joined.startsWith('merge-base --is-ancestor')) {
      events.push('ancestry');
      if (options.canFastForward === false) throw new Error('not ancestor');
      return { stdout: '', stderr: '' };
    }
    if (file === 'git' && joined.startsWith('diff --name-only')) {
      return { stdout: options.lockfileChanged === false ? '' : 'package-lock.json\n', stderr: '' };
    }
    if (file === 'git' && joined === 'rev-parse HEAD' && cwd === STAGING_PATH) {
      return { stdout: `${options.targetSha || TARGET_SHA}\n`, stderr: '' };
    }
    if (file === 'npm' && joined === 'ci') {
      if (options.failStep === 'install') throw new Error('install failed');
      fileSystem.entries.add(`${STAGING_PATH}/node_modules`);
      return { stdout: 'installed', stderr: '' };
    }
    if (file === 'npm' && joined === 'run build') {
      if (options.failStep === 'build') throw new Error('build failed');
      return { stdout: 'built', stderr: '' };
    }
    throw new Error(`unexpected command ${file} ${joined}`);
  };
  const lane = createUpdateApplyLane({
    gitWorkspace,
    runCommand,
    fsPromises: fileSystem.api,
    packageRoot: ROOT,
    journalPath: JOURNAL_PATH,
    getUpdateStatus: () => options.hasStatus === false ? null : makeStatus(options),
    getUpdateChannel: () => options.channel || 'release',
    broadcastControl: (message) => { broadcasts.push(message); },
    logger: { log: () => {}, warn: () => {} },
    clock: () => { clockValue += 1; return clockValue; },
    platform: options.platform || 'linux',
  });
  return { lane, fileSystem, admission, commands, removals, resets, broadcasts, events, head: () => liveHead };
}

test('staging with a changed lockfile runs npm ci in the detached worktree', async () => {
  const harness = makeHarness({ lockfileChanged: true });
  const outcome = await harness.lane.applyUpdate();
  assert.equal(outcome.ok, true);
  assert.equal(harness.lane.getJournal().state, 'staged');
  assert.deepEqual(harness.lane.getJournal().steps.map((step) => step.id), ['fetch', 'stage', 'install', 'build']);
  const npmCommands = harness.commands.filter((command) => command.file === 'npm');
  assert.deepEqual(npmCommands.map((command) => command.args), [['ci']]);
  assert.equal(npmCommands[0]?.cwd, STAGING_PATH);
  assert.equal(npmCommands[0]?.timeout, 15 * 60_000);
});

test('staging with an unchanged lockfile links live dependencies and runs the build', async () => {
  const harness = makeHarness({ lockfileChanged: false });
  const outcome = await harness.lane.applyUpdate();
  assert.equal(outcome.ok, true);
  assert.deepEqual(harness.lane.getJournal().steps.map((step) => step.id), ['fetch', 'stage', 'link-deps', 'build']);
  assert.equal(harness.fileSystem.entries.has(`${STAGING_PATH}/node_modules`), true);
  const npmCommands = harness.commands.filter((command) => command.file === 'npm');
  assert.deepEqual(npmCommands.map((command) => command.args), [['run', 'build']]);
  assert.equal(npmCommands[0]?.cwd, STAGING_PATH);
  assert.equal(npmCommands[0]?.timeout, 10 * 60_000);
});

const FAILURE_STEPS = ['fetch', 'stage', 'install', 'build'] as const;
for (const failStep of FAILURE_STEPS) {
  test(`${failStep} failure removes staging and leaves HEAD and live artifacts untouched`, async () => {
    const harness = makeHarness({ failStep, lockfileChanged: failStep !== 'build' });
    const outcome = await harness.lane.applyUpdate();
    assert.equal(outcome.ok, false);
    assert.equal(harness.lane.getJournal().state, 'failed');
    assert.equal(harness.removals.includes(STAGING_PATH), true);
    assert.equal(harness.head(), HEAD_SHA);
    assert.equal(harness.fileSystem.entries.has(`${ROOT}/dist`), true);
    assert.equal(harness.fileSystem.entries.has(`${ROOT}/node_modules`), true);
    assert.deepEqual(harness.fileSystem.artifactRenames, []);
  });
}

const REFUSALS: Array<{ name: string; options: HarnessOptions; reason: string }> = [
  { name: 'update status is missing', options: { hasStatus: false }, reason: 'missing-update-status' },
  { name: 'status channel differs', options: { channel: 'main', statusChannel: 'release' }, reason: 'channel-mismatch' },
  { name: 'flavor is unsupported', options: { flavor: 'npm-global' }, reason: 'unsupported-flavor' },
  { name: 'platform is unsupported', options: { platform: 'win32' }, reason: 'unsupported-platform' },
  { name: 'tree is dirty', options: { dirty: true }, reason: 'dirty-tree' },
  { name: 'branch is detached', options: { branch: null }, reason: 'no-branch' },
  { name: 'upstream is missing', options: { upstream: null }, reason: 'no-upstream' },
  { name: 'target sha is missing', options: { targetSha: null }, reason: 'missing-target-sha' },
  { name: 'checkout is already at the target', options: { targetSha: HEAD_SHA }, reason: 'nothing-to-do' },
  { name: 'the upstream remote is not origin', options: { upstream: 'fork/main', statusUpstream: 'fork/main' }, reason: 'unsupported-remote' },
  { name: 'the checked-out branch moved since the check', options: { branch: 'other' }, reason: 'checkout-changed' },
  { name: 'the upstream moved since the check', options: { statusUpstream: 'origin/other' }, reason: 'checkout-changed' },
];

for (const refusalCase of REFUSALS) {
  test(`preflight refuses when ${refusalCase.name}`, async () => {
    const harness = makeHarness(refusalCase.options);
    const outcome = await harness.lane.applyUpdate();
    assert.equal(outcome.reason, refusalCase.reason);
    assert.equal(harness.removals.length, 0);
    assert.deepEqual(harness.fileSystem.artifactRenames, []);
  });
}

test('the fast-forward probe runs only after the fetch lands the target sha', async () => {
  const harness = makeHarness({ lockfileChanged: false });
  await harness.lane.applyUpdate();
  assert.deepEqual(harness.events, ['fetch', 'ancestry', 'stage']);
});

test('a target the fetched history cannot reach fails the run with a named reason', async () => {
  const harness = makeHarness({ canFastForward: false });
  const outcome = await harness.lane.applyUpdate();
  assert.equal(outcome.reason, 'not-fast-forward');
  assert.equal(harness.lane.getJournal().state, 'failed');
  assert.equal(harness.commands.some((command) => command.args[0] === 'diff'), false);
  assert.deepEqual(harness.fileSystem.artifactRenames, []);
});

test('a staged descriptor refuses a second apply until restart', async () => {
  const harness = makeHarness();
  assert.equal((await harness.lane.applyUpdate()).ok, true);
  const second = await harness.lane.applyUpdate();
  assert.equal(second.reason, 'already-staged');
});

test('a requested restart refuses a new apply', async () => {
  const harness = makeHarness();
  harness.lane.noteRestartRequested();
  assert.equal((await harness.lane.applyUpdate()).reason, 'restart-requested');
});

test('a journal write failure fails the staging run closed', async () => {
  const harness = makeHarness();
  harness.fileSystem.failJournalWrites = true;
  const outcome = await harness.lane.applyUpdate();
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /journal-write-failed/);
  assert.equal(harness.removals.includes(STAGING_PATH), true);
  assert.equal(harness.lane.getJournal().state, 'failed');
});

test('apply is single-flight and reports already-running to a concurrent caller', async () => {
  const harness = makeHarness();
  const first = harness.lane.applyUpdate();
  const second = await harness.lane.applyUpdate();
  assert.equal(second.reason, 'already-running');
  assert.equal((await first).ok, true);
});

test('handoff renames dist and dependencies in plan order', async () => {
  const harness = makeHarness({ lockfileChanged: true });
  await harness.lane.applyUpdate();
  await harness.lane.handOffStagedUpdate();
  assert.deepEqual(harness.fileSystem.artifactRenames.slice(0, 4), [
    { from: `${ROOT}/dist`, to: `${UPDATE_PATH}/prev-dist` },
    { from: `${STAGING_PATH}/dist`, to: `${ROOT}/dist` },
    { from: `${ROOT}/node_modules`, to: `${UPDATE_PATH}/prev-node_modules` },
    { from: `${STAGING_PATH}/node_modules`, to: `${ROOT}/node_modules` },
  ]);
  assert.equal(harness.lane.getJournal().state, 'succeeded');
});

for (let failureIndex = 0; failureIndex < 4; failureIndex += 1) {
  test(`handoff reverses completed renames when rename ${failureIndex + 1} fails`, async () => {
    const harness = makeHarness({ lockfileChanged: true });
    await harness.lane.applyUpdate();
    harness.fileSystem.failArtifactRenameAt = failureIndex;
    await harness.lane.handOffStagedUpdate();
    const forward = harness.fileSystem.artifactRenames.slice(0, failureIndex + 1);
    const reversals = harness.fileSystem.artifactRenames.slice(failureIndex + 1);
    assert.equal(forward.length, failureIndex + 1);
    assert.deepEqual(reversals, forward.slice(0, -1).reverse().map((rename) => ({ from: rename.to, to: rename.from })));
    assert.equal(harness.lane.getJournal().state, 'failed');
    assert.deepEqual(harness.resets, [{ expectedHead: TARGET_SHA, sha: HEAD_SHA }]);
  });
}

test('a restore marker that cannot be written still rolls the merge back and names the loss', async () => {
  const harness = makeHarness({ lockfileChanged: true });
  await harness.lane.applyUpdate();
  harness.fileSystem.failArtifactRenameAt = 2;
  harness.fileSystem.failReversalContaining = `${STAGING_PATH}/dist`;
  harness.fileSystem.failRestoreMarkerWrite = true;
  await harness.lane.handOffStagedUpdate();
  assert.deepEqual(harness.resets, [{ expectedHead: TARGET_SHA, sha: HEAD_SHA }]);
  assert.equal(harness.lane.getJournal().state, 'failed');
  assert.match(String(harness.lane.getJournal().reason), /restore marker unwritten/);
});

test('a refused preflight probe leaves the handoff unswapped and names the refusal', async () => {
  const harness = makeHarness({ lockfileChanged: true });
  await harness.lane.applyUpdate();
  harness.admission.refuseProbe = true;
  await harness.lane.handOffStagedUpdate();
  assert.equal(harness.head(), HEAD_SHA);
  assert.deepEqual(harness.fileSystem.artifactRenames, []);
  assert.deepEqual(harness.resets, []);
  assert.equal(harness.lane.getJournal().state, 'failed');
  assert.match(String(harness.lane.getJournal().reason), /handoff-queue-admission-timed-out/);
});

test('a refused staging removal after a failed rename still writes the restore marker', async () => {
  const harness = makeHarness({ lockfileChanged: true });
  await harness.lane.applyUpdate();
  harness.fileSystem.failArtifactRenameAt = 2;
  harness.fileSystem.failReversalContaining = `${STAGING_PATH}/dist`;
  harness.admission.refuseRemoval = true;
  await harness.lane.handOffStagedUpdate();
  const marker = harness.fileSystem.files.get(`${UPDATE_PATH}/restore.json`);
  assert.ok(marker);
  assert.deepEqual(JSON.parse(marker), { restore: [{ from: 'prev-dist', to: 'dist' }] });
  assert.deepEqual(harness.resets, [{ expectedHead: TARGET_SHA, sha: HEAD_SHA }]);
  assert.match(String(harness.lane.getJournal().reason), /the git queue refused staging worktree removal/);
});

test('a staging failure clears the staged descriptor so a handoff swaps nothing', async () => {
  const harness = makeHarness({ failStep: 'build', lockfileChanged: false });
  assert.equal((await harness.lane.applyUpdate()).ok, false);
  await harness.lane.handOffStagedUpdate();
  assert.deepEqual(harness.fileSystem.artifactRenames, []);
  assert.equal(harness.head(), HEAD_SHA);
});

test('a failed reversal writes a restore marker for the startup shim', async () => {
  const harness = makeHarness({ lockfileChanged: true });
  await harness.lane.applyUpdate();
  harness.fileSystem.failArtifactRenameAt = 2;
  harness.fileSystem.failReversalContaining = `${STAGING_PATH}/dist`;
  await harness.lane.handOffStagedUpdate();
  const marker = harness.fileSystem.files.get(`${UPDATE_PATH}/restore.json`);
  assert.ok(marker);
  assert.deepEqual(JSON.parse(marker), { restore: [{ from: 'prev-dist', to: 'dist' }] });
});

test('handoff resets only when the merge moved HEAD', async () => {
  const harness = makeHarness({ lockfileChanged: true, mergeMovedHead: false });
  await harness.lane.applyUpdate();
  harness.fileSystem.failArtifactRenameAt = 1;
  await harness.lane.handOffStagedUpdate();
  assert.deepEqual(harness.resets, []);
});

test('handoff without an in-memory staged descriptor only removes stale staging', async () => {
  const harness = makeHarness();
  await harness.lane.handOffStagedUpdate();
  assert.deepEqual(harness.removals, [STAGING_PATH]);
  assert.equal(harness.head(), HEAD_SHA);
});

test('handoff while apply is in flight refuses mutation and removes staging', async () => {
  const harness = makeHarness();
  const applying = harness.lane.applyUpdate();
  await harness.lane.handOffStagedUpdate();
  assert.equal(harness.removals.includes(STAGING_PATH), true);
  await applying;
});

function persistedJournal(state: 'running' | 'staged'): UpdateJournal {
  return {
    state,
    fromSha: HEAD_SHA,
    toSha: TARGET_SHA,
    toVersion: '0.25.0',
    channel: 'release',
    steps: [{
      id: 'fetch',
      status: state === 'running' ? 'running' : 'succeeded',
      startedAt: 1000,
      finishedAt: state === 'running' ? null : 1001,
      outputTail: [],
    }],
    activeStep: state === 'running' ? 'fetch' : null,
    reason: null,
    startedAt: 1000,
    finishedAt: state === 'running' ? null : 1002,
  };
}

for (const [state, expectedState, reason] of [
  ['staged', 'discarded', 'restarted without handoff'],
  ['running', 'interrupted', 'interrupted'],
] as const) {
  test(`boot marks a ${state} journal ${expectedState} and removes stale artifacts`, async () => {
    const harness = makeHarness({ journal: persistedJournal(state) });
    harness.fileSystem.entries.add(`${UPDATE_PATH}/prev-dist`);
    harness.fileSystem.entries.add(`${UPDATE_PATH}/prev-node_modules`);
    harness.lane.startAfterListening({ listening: true, once: () => {}, removeListener: () => {} });
    await harness.lane.whenIdle();
    assert.equal(harness.lane.getJournal().state, expectedState);
    assert.equal(harness.lane.getJournal().reason, reason);
    assert.equal(harness.removals.includes(STAGING_PATH), true);
    assert.equal(harness.fileSystem.entries.has(`${UPDATE_PATH}/prev-dist`), false);
    assert.equal(harness.fileSystem.entries.has(`${UPDATE_PATH}/prev-node_modules`), false);
  });
}

test('boot keeps the previous artifacts while an unapplied restore marker names them', async () => {
  const harness = makeHarness({ journal: persistedJournal('staged') });
  harness.fileSystem.files.set(`${UPDATE_PATH}/restore.json`, JSON.stringify({ restore: [{ from: 'prev-dist', to: 'dist' }] }));
  harness.fileSystem.entries.add(`${UPDATE_PATH}/prev-dist`);
  harness.fileSystem.entries.add(`${UPDATE_PATH}/prev-node_modules`);
  harness.lane.startAfterListening({ listening: true, once: () => {}, removeListener: () => {} });
  await harness.lane.whenIdle();
  assert.equal(harness.fileSystem.entries.has(`${UPDATE_PATH}/prev-dist`), true);
  assert.equal(harness.fileSystem.entries.has(`${UPDATE_PATH}/prev-node_modules`), true);
});

test('boot drops a quarantined artifact once the server is listening', async () => {
  const harness = makeHarness({ journal: persistedJournal('staged') });
  harness.fileSystem.files.set(`${UPDATE_PATH}/restore.json`, JSON.stringify({ restore: [] }));
  harness.fileSystem.entries.add(`${UPDATE_PATH}/broken-dist`);
  harness.fileSystem.entries.add(`${UPDATE_PATH}/broken-node_modules`);
  harness.lane.startAfterListening({ listening: true, once: () => {}, removeListener: () => {} });
  await harness.lane.whenIdle();
  assert.equal(harness.fileSystem.entries.has(`${UPDATE_PATH}/broken-dist`), false);
  assert.equal(harness.fileSystem.entries.has(`${UPDATE_PATH}/broken-node_modules`), false);
});

test('an immediate apply waits for the boot journal replay and stale worktree removal', async () => {
  const harness = makeHarness({ lockfileChanged: false, journal: persistedJournal('running') });
  harness.fileSystem.slowReads = true;
  harness.lane.startAfterListening({ listening: true, once: () => {}, removeListener: () => {} });
  const outcome = await harness.lane.applyUpdate();
  assert.equal(outcome.ok, true);
  assert.equal(harness.events[0], 'remove');
  assert.equal(harness.lane.getJournal().state, 'staged');
});

test('a malformed persisted journal fails closed to a display-only interrupted record', async () => {
  const harness = makeHarness({ journal: '{broken' });
  harness.lane.startAfterListening({ listening: true, once: () => {}, removeListener: () => {} });
  await harness.lane.whenIdle();
  assert.equal(harness.lane.getJournal().state, 'interrupted');
  assert.equal(harness.lane.getJournal().reason, 'update journal could not be read');
  assert.equal(harness.fileSystem.files.get(JOURNAL_PATH), '{broken');
});

test('update-progress broadcasts every persisted transition', async () => {
  const harness = makeHarness({ lockfileChanged: false });
  await harness.lane.applyUpdate();
  const progress = harness.broadcasts.filter((message) => message.type === 'update-progress');
  assert.ok(progress.length >= 9);
  assert.equal(harness.lane.getJournal().steps.every((step) => step.startedAt !== null && step.finishedAt !== null), true);
});

test('staging writes no package-root path outside the update directory', async () => {
  const harness = makeHarness({ lockfileChanged: false });
  await harness.lane.applyUpdate();
  const writtenPaths = [...harness.fileSystem.files.keys()];
  assert.equal(writtenPaths.every((filePath) => filePath === JOURNAL_PATH || filePath.startsWith(`${UPDATE_PATH}/`)), true);
  assert.equal(path.dirname(STAGING_PATH), UPDATE_PATH);
});
